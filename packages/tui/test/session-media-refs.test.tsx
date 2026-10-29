import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { copyPlugin } from "./fixture/fixture"

const hash = "e".repeat(64)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const pngURI = `data:image/png;base64,${png.toString("base64")}`
const session = {
  id: "ses_media_refs",
  title: "Media refs",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const messages = [
  {
    type: "assistant",
    id: "msg_reply",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    finish: "stop",
    time: { created: 2, completed: 3 },
    content: [{ type: "text", text: "Looked at it" }],
  },
  {
    type: "user",
    id: "msg_shot",
    text: "What is in [Image 1]",
    files: [
      {
        uri: `media:${hash}`,
        mime: "image/png",
        source: { type: "inline" },
        name: "shot.png",
        mention: { start: 11, end: 20, text: "[Image 1]" },
      },
    ],
    time: { created: 1 },
  },
]
const queuedShot = {
  id: "msg_queued",
  sessionID: session.id,
  type: "user",
  delivery: "queue",
  payload: messages[1],
  time: { created: 4 },
}

// The requests a rewind makes, logged with their status.
const MEDIA = `GET /api/experimental/media/${hash}`
const REVERT = `POST /api/session/${session.id}/revert/stage`
const CANCEL = `DELETE /api/session/${session.id}/inbox/msg_queued`
const FORK = `POST /api/session/${session.id}/fork`

type Respond = () => Response | Promise<Response>
const image: Respond = () => new Response(png, { headers: { "content-type": "image/png" } })
// What the server answers once a blob is swept, and a failure where the blob may still exist.
const gone: Respond = () =>
  json({ _tag: "FileNotFoundError", path: `/api/experimental/media/${hash}`, message: "gone" }, { status: 404 })
const unavailable: Respond = () => new Response("unavailable", { status: 503 })

/** Opens the session against a fake server. `calls` logs media reads and rewinds as `<request> <status>`. */
async function openSession(server: { inbox?: unknown[]; plugins?: string[]; respond?: Record<string, Respond> }) {
  // Drafts are stashed per session for the whole process, so an earlier test's undo would prefill this composer.
  takeDraft(session.id)
  const calls: string[] = []
  const capabilities = new Map<string, string | null>()
  const logged: Partial<Record<string, Respond>> = {
    [MEDIA]: image,
    [REVERT]: () => json({ data: session }),
    [CANCEL]: () => new Response(null, { status: 204 }),
    [FORK]: () => json({ data: { ...session, id: "ses_forked" } }),
    ...server.respond,
  }
  const setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false }, plugins: server.plugins },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      const key = `${request.method} ${url.pathname}`
      if (url.pathname.endsWith("/message")) {
        capabilities.set(url.pathname, request.headers.get("x-opencode-capabilities"))
        return json({ data: url.pathname.includes(session.id) ? messages : [], cursor: {} })
      }
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: server.inbox ?? [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/interrupt`) return json({ data: session })
      if (url.pathname === `/api/experimental/session/${session.id}/wait`) return new Response(null, { status: 204 })
      const respond = logged[key]
      if (!respond) return undefined
      // Logged on arrival, so a test can act while a read is still waiting; the status is added once it answers.
      calls.push(key)
      const response = await respond()
      calls[calls.lastIndexOf(key)] = `${key} ${response.status}`
      return response
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Looked at it"))
  return Object.assign(setup, { calls, capabilities })
}

type App = Awaited<ReturnType<typeof openSession>>

async function undoLast(app: App) {
  await app.mockInput.typeText("/undo")
  app.mockInput.pressEnter()
}

async function undoQueued(app: App) {
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("q")
  await app.waitForFrame((frame) => frame.includes("Queued prompts"))
  app.mockInput.pressKey("u", { ctrl: true })
  await app.waitForFrame(() => true)
}

// Picks one of a message's actions from /timeline.
async function messageAction(app: App, action: string) {
  await app.mockInput.typeText("/timeline")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Jump to message") || frame.includes("Timeline"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes(action))
  await app.mockInput.typeText(action)
  app.mockInput.pressEnter()
}

// Waits for the requests to settle, then lets a late composer update land before reading the frame.
async function settled(app: App, done: (frame: string) => boolean) {
  await app.waitForFrame(done)
  await Bun.sleep(50)
  return app.waitForFrame(() => true)
}

// How many times the frame shows the prompt: once in the transcript, twice once it is also back in the composer.
const shown = (frame: string) => frame.split("What is in [Image 1]").length - 1

test("reads transcripts with media refs and loads a ref's bytes before /undo rewinds its message", async () => {
  await using app = await openSession({})
  expect([...app.capabilities.values()]).toEqual(["experimental-media-uri"])
  // Image previews are off by default, so showing the transcript reads no media.
  expect(app.calls).toEqual([])

  await undoLast(app)
  await app.waitForFrame((frame) => shown(frame) === 2)
  expect(app.calls).toEqual([`${MEDIA} 200`, `${REVERT} 200`])
}, 20000)

// Starts an undo, leaves the session while its media read waits, then lets the read finish.
async function undoAfterLeaving(input: { inbox: unknown[]; undo: (app: App) => Promise<void> }) {
  const media = Promise.withResolvers<void>()
  await using app = await openSession({ inbox: input.inbox, respond: { [MEDIA]: () => media.promise.then(image) } })
  await input.undo(app)
  await app.waitForFrame(() => app.calls.length > 0)
  await app.mockInput.typeText("/new")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => !frame.includes("Looked at it"))
  media.resolve()
  await app.waitForFrame(() => app.calls.length > 1)
  return { calls: app.calls, draft: takeDraft(session.id)?.prompt }
}

test("an /undo that finishes after its session closed keeps the prompt in that session's draft", async () => {
  const { calls, draft } = await undoAfterLeaving({ inbox: [], undo: undoLast })

  expect(calls).toEqual([`${MEDIA} 200`, `${REVERT} 200`])
  expect(draft?.text).toBe("What is in [Image 1]")
  expect(draft?.files?.map((file) => file.uri)).toEqual([pngURI])
}, 20000)

test("undoing a queued prompt after its session closed cancels it in that session and keeps it as a draft", async () => {
  const { calls, draft } = await undoAfterLeaving({
    inbox: [queuedShot],
    undo: async (app) => {
      await undoQueued(app)
      app.mockInput.pressEscape()
    },
  })

  expect(calls).toEqual([`${MEDIA} 200`, `${CANCEL} 204`])
  expect(draft?.text).toBe("What is in [Image 1]")
  expect(draft?.files?.map((file) => file.uri)).toEqual([pngURI])
}, 20000)

// Undoes a prompt whose image read fails. The composer is read from the draft it leaves when the app closes.
async function undoWithFailedRead(media: Respond, queued: boolean) {
  const result = await (async () => {
    await using app = await openSession({ inbox: queued ? [queuedShot] : [], respond: { [MEDIA]: media } })
    await (queued ? undoQueued(app) : undoLast(app))
    const frame = await settled(app, (frame) => app.calls.length > 0 && /no longer|unavailable|503/i.test(frame))
    return { calls: app.calls, frame }
  })()
  return { ...result, draft: takeDraft(session.id)?.prompt }
}

for (const queued of [false, true]) {
  const name = queued ? "undoing a queued prompt" : "/undo"

  test(`${name} goes ahead without an image the server no longer has`, async () => {
    const { calls, frame, draft } = await undoWithFailedRead(gone, queued)

    expect(calls).toEqual([`${MEDIA} 404`, queued ? `${CANCEL} 204` : `${REVERT} 200`])
    expect(draft?.text).toBe("What is in [Image 1]")
    expect(draft?.files).toEqual([])
    expect(frame).toContain("no longer stored")
  }, 20000)

  test(`${name} keeps the message when an image read fails for another reason`, async () => {
    const { calls, draft } = await undoWithFailedRead(unavailable, queued)

    expect(calls).toEqual([`${MEDIA} 503`])
    expect(draft).toBeUndefined()
  }, 20000)
}

test("a revert the server refuses leaves the composer as it was", async () => {
  await using app = await openSession({
    respond: { [REVERT]: () => json({ name: "BusyError", data: {} }, { status: 409 }) },
  })
  await messageAction(app, "Revert")
  const frame = await settled(app, () => app.calls.length === 2)

  expect(app.calls).toEqual([`${MEDIA} 200`, `${REVERT} 409`])
  expect(shown(frame)).toBe(1)
}, 20000)

test("a revert goes ahead without an image the server no longer has", async () => {
  await using app = await openSession({ respond: { [MEDIA]: gone } })
  await messageAction(app, "Revert")
  const frame = await settled(app, () => app.calls.length === 2)

  expect(app.calls).toEqual([`${MEDIA} 404`, `${REVERT} 200`])
  expect(shown(frame)).toBe(2)
  expect(frame).toContain("no longer stored")
}, 20000)

test("a revert whose image read fails for another reason does not revert", async () => {
  await using app = await openSession({ respond: { [MEDIA]: unavailable } })
  await messageAction(app, "Revert")
  const frame = await settled(app, (frame) => app.calls.length > 0 && !frame.includes("Message Actions"))

  expect(app.calls).toEqual([`${MEDIA} 503`])
  expect(shown(frame)).toBe(1)
}, 20000)

test("forking from a prompt whose image is gone does not fork", async () => {
  await using app = await openSession({ respond: { [MEDIA]: gone } })
  await messageAction(app, "Fork")
  await settled(app, (frame) => app.calls.length > 0 && !frame.includes("Message Actions"))

  expect(app.calls).toEqual([`${MEDIA} 404`])
}, 20000)

test("plugins read messages with inline bytes while the transcript reads media refs", async () => {
  await using plugin = await copyPlugin("client-reads")
  await using app = await openSession({ plugins: [plugin.directory] })
  await app.waitForFrame(() => app.capabilities.size === 2)

  expect(Object.fromEntries(app.capabilities)).toEqual({
    [`/api/session/${session.id}/message`]: "experimental-media-uri",
    "/api/session/ses_plugin_probe/message": null,
  })
}, 20000)
