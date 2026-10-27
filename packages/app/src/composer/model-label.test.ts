import { expect, test } from "bun:test"
import { composerModelLabelKey, composerModelLabels, composerProviderName } from "./model-label"

function provider(
  id: string,
  name: string,
  options: { canonical?: string; integrationID?: string; models?: readonly (readonly [string, string])[] } = {},
) {
  return {
    id,
    name,
    canonical: options.canonical,
    integrationID: options.integrationID,
    models: Object.fromEntries((options.models ?? [["m", "Model"]]).map(([id, name]) => [id, { id, name }])),
  }
}

function catalog(...providers: ReturnType<typeof provider>[]) {
  return new Map(providers.map((provider) => [provider.id, provider]))
}

const root = provider("opencode", "Anomaly / OpenCode", { integrationID: "opencode", models: [] })

const managed = provider("console-openai", "Anomaly / OpenAI", { integrationID: "opencode", canonical: "openai" })

test.each([
  provider("opencode", "Anomaly / OpenCode", { integrationID: "opencode" }),
  provider("opencode", "OpenCode"),
])("omits native provider $name in composer but retains its accessible context", (native) => {
  const all = catalog(native)
  expect(composerProviderName("opencode", all)).toBe("OpenCode")
  expect(composerModelLabels(all).get(composerModelLabelKey("opencode", "m"))).toEqual({
    provider: undefined,
    model: "Model",
    full: `${native.name} / Model`,
  })
})

test.each([
  { direct: provider("openai", "Renamed", { models: [] }), connected: [], expected: "OpenAI" },
  { direct: provider("openai", "Renamed", { models: [] }), connected: ["openai"], expected: "Anomaly / OpenAI" },
  {
    direct: provider("account", "Owls", { integrationID: "openai" }),
    connected: ["account"],
    expected: "Anomaly / OpenAI",
  },
  { direct: provider("proxy", "OpenAI", { canonical: "openai" }), connected: ["proxy"], expected: "OpenAI" },
  { direct: provider("azure", "Azure", { canonical: "openai" }), connected: ["azure"], expected: "OpenAI" },
])("matches connected stable identities, not names or canonical proxies: $direct.id / $connected", (row) => {
  const all = catalog(root, managed, row.direct)
  expect(composerProviderName(managed.id, all, { connected: row.connected })).toBe(row.expected)
})

test("shared helper retains workspace origin by default and supports composer origin", () => {
  const all = catalog(root, managed, provider("openai", "OpenAI", { models: [] }))
  expect(composerProviderName(managed.id, all)).toBe("Anomaly / OpenAI")
  expect(composerProviderName(managed.id, all, { origin: "OpenCode" })).toBe("OpenCode / OpenAI")
  expect(composerProviderName("openai", all)).toBe("OpenAI")
})

test.each([
  { connected: ["opencode", "console-openai"], provider: "OpenAI", full: "Anomaly / OpenAI / Model" },
  {
    connected: ["opencode", "console-openai", "openai"],
    provider: "OpenCode / OpenAI",
    full: "OpenCode / OpenAI / Model (Anomaly / OpenAI / Model)",
  },
])("composer origin follows direct connection availability: $provider", (row) => {
  const all = catalog(root, managed, provider("openai", "OpenAI", { models: [] }))
  expect(composerModelLabels(all, { connected: row.connected }).get(composerModelLabelKey(managed.id, "m"))).toEqual({
    provider: row.provider,
    model: "Model",
    full: row.full,
  })
})

test("unknown managed routes do not infer identity from console prefixes or display names", () => {
  const all = catalog(
    root,
    provider("console-openai", "Anomaly / OpenAI", { integrationID: "opencode" }),
    provider("openai", "OpenAI"),
  )

  expect(composerProviderName("console-openai", all)).toBe("OpenAI")
  expect(composerModelLabels(all).get(composerModelLabelKey("console-openai", "m"))).toEqual({
    provider: "console-openai",
    model: "Model",
    full: "console-openai / Model (Anomaly / OpenAI / Model)",
  })
})

test("duplicate provider labels use raw IDs only for overlapping model labels", () => {
  const labels = composerModelLabels(
    catalog(
      provider("a", "OpenAI", {
        models: [
          ["m", "Model"],
          ["other", "Other"],
        ],
      }),
      provider("b", "OpenAI"),
      provider("empty", "OpenAI", { models: [] }),
    ),
  )

  expect(labels.get(composerModelLabelKey("a", "m"))).toEqual({
    provider: "a",
    model: "Model",
    full: "a / Model (OpenAI / Model)",
  })
  expect(labels.get(composerModelLabelKey("b", "m"))).toEqual({
    provider: "b",
    model: "Model",
    full: "b / Model (OpenAI / Model)",
  })
  expect(labels.get(composerModelLabelKey("a", "other"))).toEqual({
    provider: "OpenAI",
    model: "Other",
    full: "OpenAI / Other",
  })
})

test("same-route duplicate model names append exact model IDs", () => {
  const labels = composerModelLabels(
    catalog(
      provider("openai", "OpenAI", {
        models: [
          ["v1", "GPT"],
          ["v2", "GPT"],
        ],
      }),
    ),
  )

  expect(labels.get(composerModelLabelKey("openai", "v1"))).toEqual({
    provider: "OpenAI",
    model: "GPT (v1)",
    full: "OpenAI / GPT (v1)",
  })
  expect(labels.get(composerModelLabelKey("openai", "v2"))).toEqual({
    provider: "OpenAI",
    model: "GPT (v2)",
    full: "OpenAI / GPT (v2)",
  })
})

test("a peer group with provider and model duplicates needs both qualifiers", () => {
  const labels = composerModelLabels(
    catalog(
      provider("a", "OpenAI", {
        models: [
          ["v1", "GPT"],
          ["v2", "GPT"],
        ],
      }),
      provider("b", "OpenAI", { models: [["m", "GPT"]] }),
    ),
  )

  expect(labels.get(composerModelLabelKey("a", "v1"))).toMatchObject({ provider: "a", model: "GPT (v1)" })
  expect(labels.get(composerModelLabelKey("a", "v2"))).toMatchObject({ provider: "a", model: "GPT (v2)" })
  expect(labels.get(composerModelLabelKey("b", "m"))).toMatchObject({ provider: "b", model: "GPT" })
})

test("preserves configured direct provider and model names verbatim", () => {
  const all = catalog(provider("custom", "  Custom / Proxy  ", { models: [["m", "  GPT / custom  "]] }))
  expect(composerProviderName("custom", all)).toBe("  Custom / Proxy  ")
  expect(composerModelLabels(all).get(composerModelLabelKey("custom", "m"))).toEqual({
    provider: "  Custom / Proxy  ",
    model: "  GPT / custom  ",
    full: "  Custom / Proxy   /   GPT / custom  ",
  })
})

test("tuple keys keep slash-containing provider and model identities separate", () => {
  const labels = composerModelLabels(
    catalog(
      provider("company", "Company", { models: [["openai/gpt", "First model"]] }),
      provider("company/openai", "Other", { models: [["gpt", "Second model"]] }),
    ),
  )

  expect(composerModelLabelKey("company", "openai/gpt")).toBe('["company","openai/gpt"]')
  expect(labels.size).toBe(2)
  expect(labels.get(composerModelLabelKey("company", "openai/gpt"))).toEqual({
    provider: "Company",
    model: "First model",
    full: "Company / First model",
  })
  expect(labels.get(composerModelLabelKey("company/openai", "gpt"))).toEqual({
    provider: "Other",
    model: "Second model",
    full: "Other / Second model",
  })
})
