import { beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

// Earlier app tests in this process can leave a home draft that the prompt would restore.
beforeEach(() => takeDraft(undefined))

test("file autocomplete keeps # in filenames while still attaching #line suffixes", async () => {
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const entries = [
    ...Array.from({ length: 25 }, (_, i) => ({ path: `report${String(i).padStart(2, "0")}.txt`, type: "file" })),
    { path: "report#2026.md", type: "file" },
    { path: "#notes.md", type: "file" },
  ]
  const queries: string[] = []
  {
    await using setup = await createAppFixture({
      fetch: (url) => {
        if (url.pathname === "/api/skill")
          return json({
            location,
            data: [{ id: "report", name: "Report", description: "Report an issue", location: "builtin" }],
          })
        if (url.pathname === "/api/fs/find") {
          const query = url.searchParams.get("query") ?? ""
          queries.push(query)
          return json({
            location,
            data: query ? entries.filter((entry) => entry.path.includes(query)).slice(0, 20) : [],
          })
        }
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("commands"))
    const editor = setup.renderer.currentFocusedEditor!

    await setup.mockInput.pasteBracketedText("@report#2026.md")
    await setup.waitForFrame((frame) => frame.includes("┃ report#2026.md") && !frame.includes("Report an issue"))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => editor.plainText === "@report#2026.md ")

    await setup.mockInput.pasteBracketedText("@#notes.md")
    await setup.waitForFrame((frame) => frame.includes("┃ #notes.md"))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => editor.plainText === "@report#2026.md @#notes.md ")

    await setup.mockInput.pasteBracketedText("@report#2026.md#3")
    await setup.waitForFrame((frame) => frame.includes("┃ report#2026.md#3"))
    setup.mockInput.pressEnter()
    await setup.waitFor(() => editor.plainText === "@report#2026.md @#notes.md @report#2026.md#3 ")
  }

  expect(queries.filter(Boolean)).toEqual(["report#2026.md", "#notes.md", "report#2026.md"])
  expect(takeDraft(undefined)?.prompt.files).toEqual([
    {
      uri: pathToFileURL(path.join(directory, "report#2026.md")).href,
      name: "report#2026.md",
      mention: { start: 0, end: 15, text: "@report#2026.md" },
    },
    {
      uri: pathToFileURL(path.join(directory, "#notes.md")).href,
      name: "#notes.md",
      mention: { start: 16, end: 26, text: "@#notes.md" },
    },
    {
      uri: `${pathToFileURL(path.join(directory, "report#2026.md")).href}?start=3`,
      name: "report#2026.md#3",
      mention: { start: 27, end: 44, text: "@report#2026.md#3" },
    },
  ])
})

test("an agent mention after a tab replaces only the mention", async () => {
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            { id: "build", mode: "primary", hidden: false, permissions: [] },
            { id: "助手", mode: "subagent", hidden: false, permissions: [] },
          ],
        })
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.pasteBracketedText("\f👨‍👩‍👧நி\t@助")
  await setup.waitForFrame((frame) => frame.includes("@助手"))
  setup.mockInput.pressEnter()
  const editor = setup.renderer.currentFocusedEditor!
  await setup.waitFor(() => editor.plainText === "\f👨‍👩‍👧நி\t@助手 ")
  const start = editor.editBuffer.measureText("\f👨‍👩‍👧நி\t")
  expect(editor.editorView.extmarks.getAll()).toMatchObject([
    { start, end: start + editor.editBuffer.measureText("@助手") },
  ])
})

test("history navigation moves the cursor to the end of wide text", async () => {
  await using state = await tmpdir()
  const file = path.join(state.path, "prompt-history.jsonl")
  const entry = (text: string) => JSON.stringify({ text, files: [], agents: [], skills: [], pasted: [] }) + "\n"
  await Bun.write(file, entry("中\t👨‍👩‍👧நி") + entry("末") + "corrupt\n")
  await using setup = await createAppFixture({ state: state.path })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  // The history provider rewrites the file without the corrupt line after it loads the entries.
  await setup.waitFor(async () => !(await Bun.file(file).text()).includes("corrupt"), { maxPasses: 200 })
  const text = () => setup.renderer.currentFocusedEditor?.plainText
  setup.mockInput.pressArrow("up")
  expect(text()).toBe("末")
  setup.mockInput.pressArrow("up")
  expect(text()).toBe("中\t👨‍👩‍👧நி")
  setup.mockInput.pressKey("END")
  setup.mockInput.pressArrow("down")
  await setup.mockInput.typeText("x")
  expect(text()).toBe("末x")
})
