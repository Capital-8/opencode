import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

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
