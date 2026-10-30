export * as ConfigSkillPlugin from "./skill.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Hash } from "@opencode/util/hash"
import path from "path"
import { Effect, FiberMap, PubSub, Schema, Semaphore, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { App } from "../../app.js"
import { Config } from "../../config.js"
import { ConsoleAccess } from "../../console-access.js"
import { Watcher } from "../../filesystem/watcher.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { SkillDiscovery } from "../../skill/discovery.js"
import { ConfigIntegration } from "../integration.js"
import { SkillFile } from "./skill-file.js"
import { SkillScan } from "./skill-scan.js"

type Source = Skill.DirectorySource | Skill.UrlSource

// One Console Library skill's files, SKILL.md first.
const Bundle = Schema.Struct({
  slug: Schema.String,
  version: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
})

export const Plugin = define({
  id: "opencode.config.skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const client = yield* HttpClient.HttpClient
    // The Console reads the User-Agent to tell which OpenCode a member runs.
    const http = HttpClient.withScope(
      HttpClient.filterStatusOk(
        HttpClient.mapRequest(client, HttpClientRequest.setHeader("User-Agent", App.useragent(ctx.app))),
      ),
    )
    const loaded: { entries: Entry[]; skills: Skill.Info[] } = {
      entries: yield* config.entries(),
      skills: [],
    }
    const watches = yield* FiberMap.make<string>()
    const changes = yield* PubSub.sliding<string>(1)
    const lock = Semaphore.makeUnsafe(1)

    const watch = Effect.fn("ConfigSkillPlugin.watch")(function* (directory: string, type: "file" | "directory") {
      const target = path.resolve(directory)
      const updates = yield* watcher.subscribe(
        type === "directory" ? { path: target, type, ignore: SkillScan.ignore } : { path: target, type },
      )
      yield* FiberMap.run(
        watches,
        `${type}:${target}`,
        updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
        { onlyIfMissing: true, startImmediately: true },
      )
    })

    function firstMissing(target: string): Effect.Effect<string | undefined> {
      const parent = path.dirname(target)
      if (parent === target) return Effect.undefined
      return fs.isDir(parent).pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(target) : firstMissing(parent))))
    }

    const watchDirectory: (directory: string) => Effect.Effect<string[]> = Effect.fn(
      "ConfigSkillPlugin.watchDirectory",
    )(function* (directory: string) {
      const target = path.resolve(directory)
      const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
      if (resolved) {
        yield* watch(resolved, "directory")
        if (resolved !== target) yield* watch(target, "file")
        return resolved === target ? [target] : [target, resolved]
      }
      const missing = yield* firstMissing(target)
      if (missing) yield* watch(missing, "file")
      if (
        yield* fs.realPath(directory).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      ) {
        if (missing) yield* FiberMap.remove(watches, `file:${path.resolve(missing)}`)
        return yield* watchDirectory(directory)
      }
      return [target]
    })

    const sources = () => {
      const result: Source[] = []
      const add = (source: Source) => {
        if (result.some((item) => Skill.Source.equals(item, source))) return
        result.push(source)
      }
      const directories = loaded.entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      const items = loaded.entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
      for (const directory of directories) {
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }))
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          add(Skill.UrlSource.make({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        add(
          Skill.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
          }),
        )
      }
      return result
    }

    const load = Effect.fn("ConfigSkillPlugin.load")(function* (source: Source) {
      const directories =
        source.type === "directory"
          ? [source.path]
          : yield* discovery.pull(source.url).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to load skill source", {
                  source: Skill.Source.key(source),
                  cause,
                }).pipe(Effect.as([] as AbsolutePath[])),
              ),
            )
      const roots = (yield* Effect.forEach(directories, watchDirectory)).flat()
      const skills: Skill.Info[] = []
      for (const directory of directories) {
        for (const filepath of yield* SkillScan.scan(directory)) {
          const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
          if (!roots.some((root) => FSUtil.contains(root, resolved))) yield* watch(resolved, "file")
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
          if (!content) continue
          const parsed = SkillFile.parse(directory, filepath, content)
          if (parsed._tag === "Skipped") {
            yield* Effect.logDebug("skill file skipped", {
              filepath,
              reason: parsed.reason,
              ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
            })
            continue
          }
          skills.push(parsed.skill)
        }
      }
      yield* Effect.logDebug("skill source loaded", {
        source: Skill.Source.key(source),
        type: source.type,
        directories,
        skills: skills.map((skill) => skill.id),
      })
      return skills
    })

    // Console skills come from the documents' lists, never from scanning or watching the cache, so a skill the
    // Console stops listing disappears though its files stay cached.
    const library = Effect.fn("ConfigSkillPlugin.library")(function* () {
      const documents = loaded.entries.filter(
        (entry): entry is ConfigIntegration.Document => entry instanceof ConfigIntegration.Document,
      )
      return (yield* Effect.forEach(documents, (document) =>
        librarySkills(document).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load Console skills", { integrationID: document.integrationID, cause }).pipe(
              Effect.as([] as Skill.Info[]),
            ),
          ),
        ),
      )).flat()
    })

    const librarySkills = Effect.fnUntraced(function* (document: ConfigIntegration.Document) {
      const origin = document.origin
      const listed = document.library?.skills ?? []
      if (!origin || listed.length === 0) return []
      const credential = yield* ctx.integration.connection.resolve(document.connection)
      if (!credential || credential.type === "external")
        return yield* Effect.fail(new Error(`${document.integrationID} is not connected`))
      const orgID = credential.metadata?.orgID
      // Workspaces on one server can share skill slugs, so each connection and workspace keeps its own cache.
      const cache = path.resolve(
        global.cache,
        "skills",
        Hash.fast(
          [origin, IntegrationConnection.key(document.connection), typeof orgID === "string" ? orgID : ""].join("\n"),
        ),
      )
      const skills = yield* Effect.forEach(
        listed.filter((skill) => SkillDiscovery.isSafeSegment(skill.slug)),
        (skill) =>
          librarySkill({
            url: `${origin}/api/v2/library/skills/${encodeURIComponent(skill.slug)}`,
            headers: ConsoleAccess.headers(credential),
            root: path.join(cache, skill.slug),
            slug: skill.slug,
            version: skill.version,
          }),
        { concurrency: 4 },
      )
      return skills.filter((skill) => skill !== undefined)
    })

    // A version already on disk costs no request; a failed download keeps the cached version.
    const librarySkill = Effect.fnUntraced(function* (input: {
      url: string
      headers: Record<string, string>
      root: string
      slug: string
      version: string
    }) {
      const file = path.join(input.root, "SKILL.md")
      const current = yield* fs
        .readFileStringSafe(path.join(input.root, ".opencode-version"))
        .pipe(Effect.orElseSucceed(() => undefined))
      if (current !== input.version || !(yield* fs.isFile(file)))
        yield* download(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to download Console skill", { slug: input.slug, version: input.version, cause }),
          ),
        )
      const content = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (!content) return undefined
      const parsed = SkillFile.parse(input.root, file, content)
      if (parsed._tag === "Parsed") return parsed.skill
      yield* Effect.logDebug("skill file skipped", {
        filepath: file,
        reason: parsed.reason,
        ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
      })
      return undefined
    })

    const download = Effect.fnUntraced(function* (input: {
      url: string
      headers: Record<string, string>
      root: string
      slug: string
    }) {
      const bundle = yield* http
        .execute(
          HttpClientRequest.get(input.url).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeaders(input.headers),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Bundle)),
          // The connection's credentials must not follow a redirect to another server.
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.scoped,
          Effect.timeout("30 seconds"),
        )
      if (bundle.slug !== input.slug)
        return yield* Effect.fail(new Error(`expected skill ${input.slug}, received ${bundle.slug}`))
      const unsafe = bundle.files.find((file) => {
        const destination = path.resolve(input.root, file.path)
        return (
          !SkillDiscovery.isSafeRelativePath(file.path) ||
          file.path.toLowerCase() === ".opencode-version" ||
          !FSUtil.contains(input.root, destination) ||
          destination === input.root
        )
      })
      if (unsafe) return yield* Effect.fail(new Error(`unsafe skill file path: ${unsafe.path}`))
      if (!bundle.files.some((file) => file.path === "SKILL.md"))
        return yield* Effect.fail(new Error(`skill ${input.slug} has no SKILL.md`))
      const staging = `${input.root}.tmp-${crypto.randomUUID()}`
      yield* Effect.gen(function* () {
        yield* Effect.forEach(
          bundle.files,
          (file) => fs.writeWithDirs(path.resolve(staging, file.path), file.content),
          { discard: true },
        )
        yield* fs.writeFileString(path.join(staging, ".opencode-version"), bundle.version)
        yield* SkillDiscovery.replace(fs, input.root, staging)
      }).pipe(Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)))
    })

    const refresh = Effect.fn("ConfigSkillPlugin.refresh")(
      function* (file?: string) {
        yield* FiberMap.clear(watches)
        const skills = new Map<Skill.ID, Skill.Info>()
        const current = sources()
        for (const source of current) {
          for (const skill of yield* load(source)) skills.set(skill.id, skill)
        }
        // Console skills load last, so they win over local skills with the same ID.
        for (const skill of yield* library()) skills.set(skill.id, skill)
        loaded.skills = Array.from(skills.values())
        if (file) {
          yield* Effect.logInfo("skills rescanned", {
            file,
            sources: current.map(Skill.Source.key),
            skills: loaded.skills.map((skill) => skill.id),
          })
        }
      },
      (effect, ..._args: [file?: string]) => lock.withPermit(effect),
    )

    // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
    // before debouncing so no update slips through while the debounce starts its pull.
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(ctx.skill.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* refresh()
    yield* ctx.skill.transform((editor) => {
      for (const skill of loaded.skills) editor.add(skill)
    })
    yield* ctx.event.subscribe({ types: ["config.updated"] }).pipe(
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          Effect.andThen(refresh()),
          Effect.andThen(ctx.skill.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
