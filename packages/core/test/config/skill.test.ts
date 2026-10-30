import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Config } from "@opencode/core/config"
import { ConfigIntegration } from "@opencode/core/config/integration"
import { Directory, Document, type Entry, Info } from "@opencode/schema/config"
import { ConfigSkillPlugin } from "@opencode/core/config/plugin/skill"
import { ConfigCompatibilityPlugin } from "@opencode/core/config/plugin/compatibility"
import { SkillFile } from "@opencode/core/config/plugin/skill-file"
import { SkillScan } from "@opencode/core/config/plugin/skill-scan"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { FSUtil } from "@opencode/util/fs-util"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Skill } from "@opencode/core/skill"
import { SkillDiscovery } from "@opencode/core/skill/discovery"
import { WellKnown } from "@opencode/core/wellknown"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { advance, drain } from "../lib/clock"
import { tmpdir } from "../fixture/tmpdir"
import { registerIntegrationPolicy } from "../fixture/policy"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const emptyDiscovery = SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) })
const watcherLayer = Watcher.testLayer
const skillLayer = Layer.merge(AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node])), watcherLayer)
const it = testEffect(skillLayer)
const decode = Schema.decodeUnknownSync(Info)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

const startEntries = Effect.fnUntraced(function* (
  entries: Entry[],
  directory: string,
  home = directory,
  discovery = emptyDiscovery,
  compatibility: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] } = {
    claude: [],
    agents: [],
  },
  options: { readonly global?: Partial<Global.Interface>; readonly host?: Parameters<typeof host>[0] } = {},
) {
  const service = yield* Skill.Service
  const global = Global.Service.of({ ...Global.make(), home, ...options.global })
  const pluginHost = host({
    ...options.host,
    skill: {
      list: () => Effect.die("unused skill.list"),
      transform: service.transform,
      reload: service.reload,
    },
  })
  yield* ConfigCompatibilityPlugin.Plugin.effect(pluginHost).pipe(
    Effect.provide(Config.testLayer(entries, compatibility)),
  )
  yield* ConfigSkillPlugin.Plugin.effect(pluginHost).pipe(
    Effect.provide(Config.testLayer(entries, compatibility)),
    Effect.provideService(SkillDiscovery.Service, discovery),
    Effect.provideService(Global.Service, global),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(
      AppNodeBuilder.build(EffectFlock.node, [Global.node.replace(Layer.succeed(Global.Service, global))]),
    ),
  )
  return service
})

// A Console server for Library skill bundles that records each request. `respond` is replaced per phase.
const consoleServer = Effect.acquireRelease(
  Effect.sync(() => {
    const state = {
      respond: (_request: Request): Response | Promise<Response> => new Response(null, { status: 404 }),
      requests: [] as { path: string; authorization: string | null; orgID: string | null; userAgent: string | null }[],
    }
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        state.requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          orgID: request.headers.get("x-org-id"),
          userAgent: request.headers.get("user-agent"),
        })
        return state.respond(request)
      },
    })
    return { origin: server.url.origin, state, server }
  }),
  (fixture) => Effect.promise(() => fixture.server.stop(true)),
)

const bundle = (slug: string, version: string, files: Record<string, string>) =>
  Response.json({ slug, version, files: Object.entries(files).map(([path, content]) => ({ path, content })) })

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`

const consoleDocument = (origin: string, skills: ConfigIntegration.Library["skills"]) =>
  ConfigIntegration.make({
    integrationID: Integration.ID.make("opencode"),
    connection: { type: "credential", id: Credential.ID.make("cred_console"), label: "Acme", method: "key" },
    origin,
    orgID: "org_acme",
    info: { library: { skills } },
  })

const consoleCredential = () =>
  Effect.succeed(Credential.Key.make({ type: "key", key: "secret", metadata: { orgID: "org_acme" } }))

const consoleHost = (
  resolve: () => Effect.Effect<Credential.Value | undefined, unknown> = consoleCredential,
): Parameters<typeof host>[0] => {
  const integration = host().integration
  return { integration: { ...integration, connection: { ...integration.connection, resolve } } }
}

const consoleGlobal = (root: string) => ({ cache: path.join(root, "cache"), state: path.join(root, "state") })

// Each call starts a fresh plugin and skill catalog over the same cache, as a new session would.
const loadConsole = (input: {
  readonly root: string
  readonly origin: string
  readonly skills: ConfigIntegration.Library["skills"]
  readonly entries?: Entry[]
  readonly compatibility?: { readonly claude: readonly AbsolutePath[]; readonly agents: readonly AbsolutePath[] }
  readonly resolve?: () => Effect.Effect<Credential.Value | undefined, unknown>
}) =>
  Effect.gen(function* () {
    const skill = yield* startEntries(
      [...(input.entries ?? []), consoleDocument(input.origin, input.skills)],
      input.root,
      input.root,
      emptyDiscovery,
      input.compatibility,
      { global: consoleGlobal(input.root), host: consoleHost(input.resolve) },
    )
    return yield* skill.list()
  }).pipe(Effect.scoped, Effect.provide(skillLayer))

const start = (skills: string[], directory: string, discovery = emptyDiscovery) =>
  startEntries(
    [
      new Document({
        type: "document",
        info: decode({ skills }),
      }),
    ],
    directory,
    directory,
    discovery,
  )

const discover = (directory: string, global: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    return { entries: yield* config.entries(), compatibility: yield* config.compatibility!() }
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(emptyWellknownNode),
        Watcher.node.replace(Watcher.testLayer),
      ]),
    ),
  )

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const deferred = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(Skill.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(deferred).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

describe("SkillFile.parse", () => {
  test("reads disable-model-invocation as autoinvoke", () => {
    const parse = (frontmatter: string) =>
      SkillFile.parse("/repo/skills", "/repo/skills/deploy/SKILL.md", `---\n${frontmatter}\n---\n# deploy`)
    expect(parse("disable-model-invocation: true")).toMatchObject({ skill: { autoinvoke: false } })
    expect(parse("disable-model-invocation: yes")).toMatchObject({ skill: { autoinvoke: false } })
    expect(parse("disable-model-invocation: false")).not.toMatchObject({ skill: { autoinvoke: expect.anything() } })
    expect(parse("disable-model-invocation: maybe")).not.toMatchObject({ skill: { autoinvoke: expect.anything() } })
    expect(parse("disable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true")).toMatchObject({
      skill: { autoinvoke: true },
    })
  })

  test("parses root and nested skill ids and metadata flags", () => {
    const directory = "/repo/skills"
    expect(
      SkillFile.parse(
        directory,
        "/repo/skills/manual/SKILL.md",
        `---
name: Manual
description: Manual only
metadata:
  opencode/autoinvoke: false
---
# manual`,
      ),
    ).toEqual({
      _tag: "Parsed",
      skill: {
        id: Skill.ID.make("manual"),
        name: Skill.Name.make("Manual"),
        description: "Manual only",
        autoinvoke: false,
        path: AbsolutePath.make("/repo/skills/manual/SKILL.md"),
        content: "# manual",
      },
    })
    expect(SkillFile.parse(directory, "/repo/skills/foo.md", "# foo")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("foo") },
    })
    expect(SkillFile.parse("/repo/skills/manual", "/repo/skills/manual/SKILL.md", "# manual")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("manual"), name: Skill.Name.make("manual") },
    })
    expect(
      SkillFile.parse(directory, "/repo/skills/broken.md", "---\ndescription: foo: bar\nmetadata: [\n---\n# broken"),
    ).toEqual({ _tag: "Skipped", reason: "markdown" })
  })
})

describe("ConfigSkillPlugin.Plugin", () => {
  it.live("maps config entry types to skill directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const claude = path.join(tmp.path, "claude")
          const agents = path.join(tmp.path, "agents")
          const opencode = path.join(tmp.path, "opencode")
          const home = path.join(tmp.path, "home")
          const directory = path.join(tmp.path, "project")
          const expected = [
            path.join(claude, "skills"),
            path.join(agents, "skills"),
            path.join(opencode, "skill"),
            path.join(opencode, "skills"),
            path.join(home, "shared"),
            path.join(directory, "relative"),
          ]
          yield* Effect.promise(() => Promise.all(expected.map((item) => fs.mkdir(item, { recursive: true }))))

          yield* startEntries(
            [
              new Directory({ type: "directory", path: AbsolutePath.make(opencode) }),
              new Document({ type: "document", info: decode({ skills: ["~/shared", "./relative"] }) }),
            ],
            directory,
            home,
            emptyDiscovery,
            { claude: [AbsolutePath.make(claude)], agents: [AbsolutePath.make(agents)] },
          )
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual(
            expected.map((item) => ({ path: item, type: "directory", ignore: SkillScan.ignore.toSorted() })),
          )
        }),
      ),
    ),
  )

  it.live("loads directory and individual downloaded skill roots with later-source precedence", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "deploy"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "deploy", "Deploy")
            await write(second, "review", "Second")
          })
          const pulls: string[] = []
          const discovery = SkillDiscovery.Service.of({
            pull: (url) => {
              pulls.push(url)
              return Effect.succeed([
                AbsolutePath.make(path.join(second, "deploy")),
                AbsolutePath.make(path.join(second, "review")),
              ])
            },
          })

          const skill = yield* start([first, "https://example.test/skills/"], tmp.path, discovery)
          expect((yield* skill.list()).map((item) => item.id).toSorted()).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Deploy")
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Second")
          expect(pulls).toEqual(["https://example.test/skills/"])
        }),
      ),
    ),
  )

  it.live("prefers a worktree skill over the parent checkout copy", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const checkout = path.join(tmp.path, "repo")
          const worktree = path.join(checkout, ".worktrees", "feature")
          const parentSkills = path.join(checkout, ".agents", "skills")
          const worktreeSkills = path.join(worktree, ".agents", "skills")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(checkout, ".git"), { recursive: true })
            await fs.mkdir(path.join(parentSkills, "review"), { recursive: true })
            await fs.mkdir(path.join(worktreeSkills, "review"), { recursive: true })
            await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../../../.git/worktrees/feature\n")
            await write(parentSkills, "review", "Parent checkout")
            await write(worktreeSkills, "review", "Worktree")
          })

          const discovered = yield* discover(worktree, path.join(tmp.path, "global"))
          const skill = yield* startEntries(
            discovered.entries,
            worktree,
            worktree,
            emptyDiscovery,
            discovered.compatibility,
          )
          const review = (yield* skill.list()).find((item) => item.id === "review")

          expect(review?.description).toBe("Worktree")
          expect(review?.path).toBe(AbsolutePath.make(path.join(worktreeSkills, "review", "SKILL.md")))
        }),
      ),
    ),
  )

  it.live("keeps directory skills when a URL source fails", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Available")
          })
          const url = "https://unreachable.example.test/skills/"
          const discovery = SkillDiscovery.Service.of({ pull: () => Effect.die(`failed to pull ${url}`) })

          const skill = yield* start([tmp.path, url], tmp.path, discovery)
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Available")
        }),
      ),
    ),
  )

  it.live("rescans directory sources when watched files change", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Initial")
          })
          const skill = yield* start([tmp.path], tmp.path)
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Initial")

          const deploy = path.join(tmp.path, "deploy", "SKILL.md")
          yield* Effect.promise(() => write(tmp.path, "deploy", "Updated"))
          yield* emitAndWait({ type: "update", path: deploy })
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Updated")

          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Review")
          })
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])

          yield* Effect.promise(() => fs.rm(path.join(tmp.path, "review"), { recursive: true }))
          yield* emitAndWait({ type: "delete", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )

  it.live("watches canonical files behind symlinked skills", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const target = path.join(tmp.path, "target", "bro")
          const file = path.join(target, "SKILL.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(source, { recursive: true })
            await fs.mkdir(target, { recursive: true })
            await fs.writeFile(file, "---\nname: bro\ndescription: Initial\n---\n# bro")
            await fs.symlink(target, path.join(source, "bro"), process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Initial")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: file, type: "file" })

          yield* Effect.promise(() => fs.writeFile(file, "---\nname: bro\ndescription: Updated\n---\n# bro"))
          yield* emitAndWait({ type: "update", path: file })
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Updated")
        }),
      ),
    ),
  )

  it.live("reloads symlinked sources when their target changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "bro"), { recursive: true })
            await fs.mkdir(path.join(second, "bro"), { recursive: true })
            await write(first, "bro", "First")
            await write(second, "bro", "Second")
            await fs.symlink(first, source, process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("First")
          expect(yield* watcher.subscriptions()).toEqual([
            { path: first, type: "directory", ignore: SkillScan.ignore.toSorted() },
            { path: source, type: "file" },
          ])

          yield* Effect.promise(async () => {
            await fs.unlink(source)
            await fs.symlink(second, source, process.platform === "win32" ? "junction" : undefined)
          })
          yield* emitAndWait({ type: "update", path: source })

          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Second")
          expect(yield* watcher.subscriptions()).toEqual([
            { path: first, type: "directory", ignore: SkillScan.ignore.toSorted() },
            { path: source, type: "file" },
            { path: second, type: "directory", ignore: SkillScan.ignore.toSorted() },
            { path: source, type: "file" },
          ])
        }),
      ),
    ),
  )

  it.live("follows missing source directories as their parents appear", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "generated", "skills")
          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect(yield* skill.list()).toEqual([])
          expect(yield* watcher.subscriptions()).toEqual([{ path: path.join(tmp.path, "generated"), type: "file" }])

          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "generated")))
          yield* watcher.emit({ type: "create", path: path.join(tmp.path, "generated") })
          while ((yield* watcher.subscriptions()).at(-1)?.path !== source) yield* Effect.sleep("10 millis")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(source, "deploy"), { recursive: true })
            await write(source, "deploy", "Deploy")
          })
          yield* emitAndWait({ type: "create", path: source })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )

  it.effect("ignores unrelated config updates and coalesces compatibility bursts into one reload", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const claude = path.join(tmp.path, ".claude")
          const skills = path.join(claude, "skills")
          const service = yield* Skill.Service
          const configTest = yield* Config.Test
          let reloads = 0
          yield* ConfigCompatibilityPlugin.Plugin.effect(
            host({
              skill: {
                list: () => Effect.die("unused skill.list"),
                transform: service.transform,
                reload: () => service.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
              },
            }),
          )
          yield* Effect.yieldNow

          yield* configTest.emitChange({ type: "update", path: path.join(tmp.path, "opencode.json") })
          yield* configTest.emitChange({ type: "create", path: path.join(tmp.path, "commands", "review.md") })
          yield* configTest.emitChange({ type: "create", path: path.join(tmp.path, "agents", "reviewer.md") })
          yield* drain
          expect(reloads).toBe(0)

          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(skills, "review"), { recursive: true })
            await write(skills, "review", "Review once")
          })
          yield* configTest.emitChange({ type: "create", path: claude })
          yield* configTest.emitChange({ type: "create", path: path.join(skills, "review", "SKILL.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(skills, "review", "SKILL.md") })
          yield* advance(() => reloads >= 1)
          yield* drain
          expect(reloads).toBe(1)
          expect((yield* service.list()).find((item) => item.id === "review")?.description).toBe("Review once")
        }).pipe(
          Effect.provide(
            Config.testLayer([new Directory({ type: "directory", path: AbsolutePath.make(tmp.path) })], {
              claude: [AbsolutePath.make(path.join(tmp.path, ".claude"))],
              agents: [],
            }),
          ),
        ),
      ),
    ),
  )
})

describe("ConfigSkillPlugin.Plugin with Console Library skills", () => {
  it.live("loads a Console skill over same-ID local and compatibility skills", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          const local = path.join(tmp.path, "local")
          const claude = path.join(tmp.path, "claude")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(local, "review"), { recursive: true })
            await fs.mkdir(path.join(claude, "skills", "review"), { recursive: true })
            await write(local, "review", "Local")
            await write(path.join(claude, "skills"), "review", "Compatibility")
          })
          console.state.respond = () =>
            bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Console"), "references/style.md": "Style" })

          const review = (yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
            entries: [new Document({ type: "document", info: decode({ skills: [local] }) })],
            compatibility: { claude: [AbsolutePath.make(claude)], agents: [] },
          })).find((item) => item.id === "review")

          expect(review?.description).toBe("Console")
          expect(review?.path.startsWith(path.join(tmp.path, "cache", "skills"))).toBe(true)
          expect(
            yield* Effect.promise(() => Bun.file(path.join(path.dirname(review!.path), "references/style.md")).text()),
          ).toBe("Style")
        }),
      ),
    ),
  )

  it.live("downloads a skill bundle with the Console connection's headers", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Console") })

          yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
          })

          expect(console.state.requests).toEqual([
            {
              path: "/api/v2/library/skills/review",
              authorization: "Bearer secret",
              orgID: "org_acme",
              userAgent: "opencode/test/test/test",
            },
          ])
        }),
      ),
    ),
  )

  it.live("lets a skill.use deny remove a Console skill", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Console") })
          const entries = [
            new Document({
              type: "document",
              info: decode({ policies: [{ action: "skill.use", resource: "review", effect: "deny" }] }),
            }),
            consoleDocument(console.origin, [{ slug: "review", version: "skl_1:1" }]),
          ]

          const skill = yield* startEntries(entries, tmp.path, tmp.path, emptyDiscovery, undefined, {
            global: consoleGlobal(tmp.path),
            host: consoleHost(),
          })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("review")])
          yield* registerIntegrationPolicy({ skill }).pipe(Effect.provide(Config.testLayer(entries)))
          expect(yield* skill.list()).toEqual([])
        }),
      ),
    ),
  )

  it.live("reads a manual-only Console skill without a description", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () =>
            bundle("manual", "skl_1:1", {
              "SKILL.md": "---\nname: Manual\nmetadata:\n  opencode/autoinvoke: false\n---\n# Manual",
            })

          const skills = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "manual", version: "skl_1:1" }],
          })

          expect(skills).toHaveLength(1)
          expect(skills[0]).toMatchObject({ id: "manual", name: "Manual", autoinvoke: false, content: "# Manual" })
          expect(skills[0]?.description).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("downloads each version once, and again only when its SKILL.md is missing", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Console") })
          const load = Effect.gen(function* () {
            console.state.requests = []
            const skills = yield* loadConsole({
              root: tmp.path,
              origin: console.origin,
              skills: [{ slug: "review", version: "skl_1:1" }],
            })
            return { skills: skills.map((item) => item.id), requests: console.state.requests.length }
          })

          const first = yield* load
          expect(first).toEqual({ skills: [Skill.ID.make("review")], requests: 1 })
          expect(yield* load).toEqual({ skills: [Skill.ID.make("review")], requests: 0 })

          const cached = yield* Effect.promise(() =>
            Array.fromAsync(new Bun.Glob("cache/skills/*/review/SKILL.md").scan({ cwd: tmp.path, absolute: true })),
          )
          expect(cached).toHaveLength(1)
          yield* Effect.promise(() => fs.rm(cached[0]!))
          expect(yield* load).toEqual({ skills: [Skill.ID.make("review")], requests: 1 })
        }),
      ),
    ),
  )

  it.live("keeps the cached version when a newer version fails to download", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "First") })
          yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
          })

          console.state.respond = () => new Response("unavailable", { status: 503 })
          const skills = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:2" }],
          })

          expect(console.state.requests).toHaveLength(2)
          expect(skills.map((item) => item.description)).toEqual(["First"])
        }),
      ),
    ),
  )

  it.live("resolves the credential once per pass, and not at all for cached versions", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = (request) => {
            const slug = path.basename(new URL(request.url).pathname)
            return bundle(slug, "skl_1:1", { "SKILL.md": skillFile(slug, "Console") })
          }
          let resolves = 0
          const load = loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [
              { slug: "review", version: "skl_1:1" },
              { slug: "deploy", version: "skl_1:1" },
            ],
            resolve: () => consoleCredential().pipe(Effect.tap(() => Effect.sync(() => resolves++))),
          })

          yield* load
          expect(resolves).toBe(1)
          expect((yield* load).map((item) => item.id).toSorted()).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])
          expect(resolves).toBe(1)
        }),
      ),
    ),
  )

  it.live("keeps cached skills when the credential can't be resolved", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "First") })
          yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
          })
          const failing = () => Effect.fail(new Error("token refresh failed"))

          const hit = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
            resolve: failing,
          })
          const miss = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:2" }],
            resolve: failing,
          })

          expect(hit.map((item) => item.description)).toEqual(["First"])
          expect(miss.map((item) => item.description)).toEqual(["First"])
          expect(console.state.requests).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("downloads nothing when the credential now signs in to another workspace", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () => bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Other") })

          const skills = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
            resolve: () =>
              Effect.succeed(Credential.Key.make({ type: "key", key: "secret", metadata: { orgID: "org_other" } })),
          })

          expect(skills).toEqual([])
          expect(console.state.requests).toEqual([])
        }),
      ),
    ),
  )

  it.live("downloads a skill once when two sessions need it at the same time", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = () =>
            Bun.sleep(100).then(() =>
              bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Console"), "references/a.md": "A" }),
            )
          const load = loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
          })

          const results = yield* Effect.all([load, load], { concurrency: 2 })

          expect(results.map((skills) => skills.map((item) => item.description))).toEqual([["Console"], ["Console"]])
          expect(console.state.requests).toHaveLength(1)
        }),
      ),
    ),
  )

  it.live("drops a skill the Console stops listing though its files stay cached", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = (request) =>
            new URL(request.url).pathname.endsWith("/review")
              ? bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Review") })
              : bundle("deploy", "skl_2:1", { "SKILL.md": skillFile("deploy", "Deploy") })
          const listed = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [
              { slug: "review", version: "skl_1:1" },
              { slug: "deploy", version: "skl_2:1" },
            ],
          })
          expect(listed.map((item) => item.id).toSorted()).toEqual([Skill.ID.make("deploy"), Skill.ID.make("review")])

          const remaining = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "deploy", version: "skl_2:1" }],
          })

          expect(remaining.map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
          const review = listed.find((item) => item.id === "review")
          expect(yield* Effect.promise(() => Bun.file(review!.path).exists())).toBe(true)
        }),
      ),
    ),
  )

  it.live("rejects bundles with unsafe file paths", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          const unsafe: Record<string, string> = {
            parent: "../escape.md",
            nested: "references/../../escape.md",
            absolute: path.join(tmp.path, "escape.md"),
            backslash: "references\\..\\..\\escape.md",
            version: ".opencode-version",
          }
          console.state.respond = (request) => {
            const slug = path.basename(new URL(request.url).pathname)
            return bundle(slug, "skl_1:1", { "SKILL.md": skillFile(slug, "Unsafe"), [unsafe[slug]!]: "escaped" })
          }

          const skills = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: Object.keys(unsafe).map((slug) => ({ slug, version: "skl_1:1" })),
          })

          expect(console.state.requests).toHaveLength(Object.keys(unsafe).length)
          expect(skills).toEqual([])
          expect(
            yield* Effect.promise(() =>
              Array.fromAsync(new Bun.Glob("**/escape.md").scan({ cwd: tmp.path, dot: true })),
            ),
          ).toEqual([])
        }),
      ),
    ),
  )

  it.live("refuses to follow a redirect with the connection's credentials", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const console = yield* consoleServer
          console.state.respond = (request) =>
            new URL(request.url).pathname === "/elsewhere"
              ? bundle("review", "skl_1:1", { "SKILL.md": skillFile("review", "Redirected") })
              : new Response(null, { status: 302, headers: { location: "/elsewhere" } })

          const skills = yield* loadConsole({
            root: tmp.path,
            origin: console.origin,
            skills: [{ slug: "review", version: "skl_1:1" }],
          })

          expect(skills).toEqual([])
          expect(console.state.requests.map((request) => request.path)).toEqual(["/api/v2/library/skills/review"])
        }),
      ),
    ),
  )
})
