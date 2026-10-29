import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json, type FetchHandler } from "./fixture/tui-client"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { copyPlugin } from "./fixture/fixture"

const hash = "e".repeat(64)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
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

test("reads transcripts with media refs and loads a ref's bytes before /undo rewinds its message", async () => {
  const calls: string[] = []
  const capabilities = new Set<string | null>()
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false } },
    args: { sessionID: session.id },
    fetch: (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) {
        capabilities.add(request.headers.get("x-opencode-capabilities"))
        return json({ data: messages, cursor: {} })
      }
      if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
        return json({ data: [] })
      if (url.pathname === `/api/experimental/media/${hash}`) {
        calls.push("media")
        return new Response(png, { headers: { "content-type": "image/png" } })
      }
      if (url.pathname === `/api/session/${session.id}/interrupt`) return json({ data: session })
      if (url.pathname === `/api/experimental/session/${session.id}/wait`) return new Response(null, { status: 204 })
      if (url.pathname === `/api/session/${session.id}/revert/stage`) {
        calls.push("revert")
        return json({ data: session })
      }
      return undefined
    },
  })

  await setup.waitForFrame((frame) => frame.includes("Looked at it"))
  expect([...capabilities]).toEqual(["experimental-media-uri"])
  // Image previews are off by default, so showing the transcript reads no media.
  expect(calls).toEqual([])

  await setup.mockInput.typeText("/undo")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(() => calls.includes("revert"))
  expect(calls).toEqual(["media", "revert"])
  // The transcript and the composer both show the prompt once it is back in the composer.
  await setup.waitForFrame((frame) => frame.split("What is in [Image 1]").length === 3)
}, 20000)

// Leaves the session while an undo waits on a media read, then lets the read finish.
async function undoAfterLeaving(input: { inbox: unknown[]; undo: (setup: Fixture) => Promise<void> }) {
  // Drafts are stashed per session for the whole process, so an earlier test's undo would prefill this composer.
  takeDraft(session.id)
  const calls: string[] = []
  const media = Promise.withResolvers<void>()
  const fetch: FetchHandler = async (url, request) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: input.inbox })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
    if (url.pathname === `/api/experimental/media/${hash}`) {
      calls.push("media")
      await media.promise
      return new Response(png, { headers: { "content-type": "image/png" } })
    }
    if (url.pathname.endsWith("/interrupt")) return json({ data: session })
    if (url.pathname.endsWith("/wait")) return new Response(null, { status: 204 })
    if (url.pathname.endsWith("/revert/stage") || request.method === "DELETE") {
      calls.push(`${request.method} ${url.pathname}`)
      return request.method === "DELETE" ? new Response(null, { status: 204 }) : json({ data: session })
    }
    return undefined
  }
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false } },
    args: { sessionID: session.id },
    fetch,
  })
  await setup.waitForFrame((frame) => frame.includes("Looked at it"))
  await input.undo(setup)
  await setup.waitForFrame(() => calls.includes("media"))

  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Looked at it"))
  media.resolve()
  await setup.waitForFrame(() => calls.length > 1)
  return { calls, draft: takeDraft(session.id)?.prompt }
}

type Fixture = Awaited<ReturnType<typeof createAppFixture>>

test("an /undo that finishes after its session closed keeps the prompt in that session's draft", async () => {
  const { calls, draft } = await undoAfterLeaving({
    inbox: [],
    undo: async (setup) => {
      await setup.mockInput.typeText("/undo")
      setup.mockInput.pressEnter()
    },
  })

  expect(calls).toEqual(["media", `POST /api/session/${session.id}/revert/stage`])
  expect(draft?.text).toBe("What is in [Image 1]")
  expect(draft?.files?.map((file) => file.uri)).toEqual([`data:image/png;base64,${png.toString("base64")}`])
}, 20000)

test("undoing a queued prompt after its session closed cancels it in that session and keeps it as a draft", async () => {
  const { calls, draft } = await undoAfterLeaving({
    inbox: [
      {
        id: "msg_queued",
        sessionID: session.id,
        type: "user",
        delivery: "queue",
        payload: messages[1],
        time: { created: 4 },
      },
    ],
    undo: async (setup) => {
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("q")
      await setup.waitForFrame((frame) => frame.includes("Queued prompts"))
      setup.mockInput.pressKey("u", { ctrl: true })
      await setup.waitForFrame(() => true)
      setup.mockInput.pressEscape()
    },
  })

  expect(calls).toEqual(["media", `DELETE /api/session/${session.id}/inbox/msg_queued`])
  expect(draft?.text).toBe("What is in [Image 1]")
  expect(draft?.files?.map((file) => file.uri)).toEqual([`data:image/png;base64,${png.toString("base64")}`])
}, 20000)

// Opens a message's actions from /timeline and picks one, with every other request answered as in the tests above.
async function messageAction(input: { action: string; respond: FetchHandler }) {
  takeDraft(session.id)
  const calls: string[] = []
  await using setup = await createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, tabs: { enabled: false } },
    args: { sessionID: session.id },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages, cursor: {} })
      if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
        return json({ data: [] })
      const response = await input.respond(url, request)
      if (response) calls.push(`${request.method} ${url.pathname} ${response.status}`)
      return response
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Looked at it"))
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Jump to message") || frame.includes("Timeline"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(input.action))
  await setup.mockInput.typeText(input.action)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => calls.length > 0 && !frame.includes("Message Actions"))
  // Let a late composer update land before reading the frame.
  await Bun.sleep(50)
  return { calls, frame: await setup.waitForFrame(() => true) }
}

test("a revert the server refuses leaves the composer as it was", async () => {
  const { calls, frame } = await messageAction({
    action: "Revert",
    respond: (url) => {
      if (url.pathname === `/api/experimental/media/${hash}`) return new Response(png)
      if (url.pathname.endsWith("/revert/stage")) return json({ name: "BusyError", data: {} }, { status: 409 })
      return undefined
    },
  })

  expect(calls).toEqual([`GET /api/experimental/media/${hash} 200`, `POST /api/session/${session.id}/revert/stage 409`])
  expect(frame.split("What is in [Image 1]").length).toBe(2)
}, 20000)

test("forking from a prompt whose image cannot be read does not fork", async () => {
  const { calls } = await messageAction({
    action: "Fork",
    respond: (url) => {
      if (url.pathname === `/api/experimental/media/${hash}`) return new Response("gone", { status: 404 })
      if (url.pathname.endsWith("/fork")) return json({ data: { ...session, id: "ses_forked" } })
      return undefined
    },
  })

  expect(calls).toEqual([`GET /api/experimental/media/${hash} 404`])
}, 20000)

test("plugins read messages with inline bytes while the transcript reads media refs", async () => {
  await using plugin = await copyPlugin("client-reads")
  const capabilities = new Map<string, string | null>()
  await using setup = await createAppFixture({
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin.directory] },
    args: { sessionID: session.id },
    fetch: (url, request) => {
      if (url.pathname.endsWith("/message"))
        capabilities.set(url.pathname, request.headers.get("x-opencode-capabilities"))
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname.endsWith("/message"))
        return json({ data: url.pathname.includes(session.id) ? messages : [], cursor: {} })
      if ([`/api/session/${session.id}/inbox`, `/api/session/${session.id}/permission`].includes(url.pathname))
        return json({ data: [] })
      return undefined
    },
  })
  await setup.waitForFrame(() => capabilities.size === 2)

  expect(Object.fromEntries(capabilities)).toEqual({
    [`/api/session/${session.id}/message`]: "experimental-media-uri",
    "/api/session/ses_plugin_probe/message": null,
  })
}, 20000)
