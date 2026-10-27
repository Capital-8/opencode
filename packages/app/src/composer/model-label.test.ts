import { expect, test } from "bun:test"
import type { Provider } from "@/runtime/server/types"
import { composerModelLabels } from "./model-label"

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

const root = provider("opencode", "Anomaly / OpenCode", { integrationID: "opencode", models: [] })

const managed = provider("console-openai", "Anomaly / OpenAI", { integrationID: "opencode", canonical: "openai" })

const cases: {
  name: string
  providers: ReturnType<typeof provider>[]
  options?: Parameters<typeof composerModelLabels>[1]
  expected: [string, string | undefined, string, string][]
}[] = [
  {
    name: "preserves configured direct provider and model names verbatim",
    providers: [provider("custom/route", "  Custom / Proxy  ", { models: [["model/id", "  GPT / custom  "]] })],
    expected: [
      ["custom/route/model/id", "  Custom / Proxy  ", "  GPT / custom  ", "  Custom / Proxy   /   GPT / custom  "],
    ],
  },
  {
    name: "shows managed Console native models without a provider",
    providers: [provider("opencode", "Anomaly / OpenCode", { integrationID: "opencode" })],
    expected: [["opencode/m", undefined, "Model", "Anomaly / OpenCode / Model"]],
  },
  {
    name: "supports legacy free Console native models",
    providers: [provider("opencode", "OpenCode")],
    expected: [["opencode/m", undefined, "Model", "OpenCode / Model"]],
  },
  {
    name: "shortens a managed provider with no matching direct connection",
    providers: [root, managed],
    expected: [["console-openai/m", "OpenAI", "Model", "Anomaly / OpenAI / Model"]],
  },
  {
    name: "distinguishes all three routes using OpenCode rather than workspace origin",
    providers: [
      provider("opencode", "Anomaly / OpenCode", { integrationID: "opencode" }),
      managed,
      provider("openai", "OpenAI"),
    ],
    expected: [
      ["opencode/m", undefined, "Model", "Anomaly / OpenCode / Model"],
      ["console-openai/m", "OpenCode / OpenAI", "Model", "Anomaly / OpenAI / Model"],
      ["openai/m", "OpenAI", "Model", "OpenAI / Model"],
    ],
  },
  {
    name: "does not treat a custom canonical proxy as a direct OpenAI connection",
    providers: [root, managed, provider("company-proxy", "Company", { canonical: "openai" })],
    expected: [
      ["console-openai/m", "OpenAI", "Model", "Anomaly / OpenAI / Model"],
      ["company-proxy/m", "Company", "Model", "Company / Model"],
    ],
  },
  {
    name: "keeps Azure, Vertex and OpenRouter routes separate from their upstream canonical providers",
    providers: [
      root,
      managed,
      provider("remote-google", "Anomaly / Google", { integrationID: "opencode", canonical: "google" }),
      provider("azure", "Azure", { canonical: "openai" }),
      provider("google-vertex", "Vertex", { canonical: "google" }),
      provider("openrouter", "OpenRouter", { canonical: "openai" }),
    ],
    expected: [
      ["console-openai/m", "OpenAI", "Model", "Anomaly / OpenAI / Model"],
      ["remote-google/m", "Google", "Model", "Anomaly / Google / Model"],
      ["azure/m", "Azure", "Model", "Azure / Model"],
      ["google-vertex/m", "Vertex", "Model", "Vertex / Model"],
      ["openrouter/m", "OpenRouter", "Model", "OpenRouter / Model"],
    ],
  },
  {
    name: "matches stable integration IDs despite misleading configured names",
    providers: [
      root,
      provider("remote", "Anomaly / Not OpenAI", { integrationID: "opencode", canonical: "openai" }),
      provider("account-1", "Owls", { integrationID: "openai" }),
    ],
    expected: [
      ["remote/m", "OpenCode / Not OpenAI", "Model", "Anomaly / Not OpenAI / Model"],
      ["account-1/m", "Owls", "Model", "Owls / Model"],
    ],
  },
  {
    name: "does not infer unknown managed routes by stripping console IDs or matching display names",
    providers: [
      root,
      provider("console-openai", "Anomaly / Other", { integrationID: "opencode" }),
      provider("openai", "OpenAI"),
    ],
    expected: [
      ["console-openai/m", "Other", "Model", "Anomaly / Other / Model"],
      ["openai/m", "OpenAI", "Model", "OpenAI / Model"],
    ],
  },
  {
    name: "falls back to Console origin when unknown managed and direct presentation collides",
    providers: [
      root,
      provider("remote", "Anomaly / OpenAI", { integrationID: "opencode" }),
      provider("proxy", "OpenAI"),
    ],
    expected: [
      ["remote/m", "OpenCode / OpenAI", "Model", "Anomaly / OpenAI / Model"],
      ["proxy/m", "OpenAI", "Model", "OpenAI / Model"],
    ],
  },
  {
    name: "retains accessible route identity when original managed and direct names also collide",
    providers: [provider("remote", "OpenAI", { integrationID: "opencode" }), provider("openai", "OpenAI")],
    expected: [
      ["remote/m", "OpenCode / OpenAI", "Model", "OpenAI / Model (remote)"],
      ["openai/m", "OpenAI", "Model", "OpenAI / Model (openai)"],
    ],
  },
  {
    name: "does not infer matching routes from equal provider names when complete labels differ",
    providers: [
      root,
      provider("remote", "Anomaly / OpenAI", { integrationID: "opencode", models: [["managed", "Managed"]] }),
      provider("proxy", "OpenAI"),
    ],
    expected: [
      ["remote/managed", "OpenAI", "Managed", "Anomaly / OpenAI / Managed"],
      ["proxy/m", "OpenAI", "Model", "OpenAI / Model"],
    ],
  },
  {
    name: "adds native origin when a model name resembles a complete provider and model label",
    providers: [
      provider("opencode", "OpenCode", { models: [["native", "OpenAI / Model"]] }),
      provider("openai", "OpenAI"),
    ],
    expected: [
      ["opencode/native", "OpenCode", "OpenAI / Model", "OpenCode / OpenAI / Model"],
      ["openai/m", "OpenAI", "Model", "OpenAI / Model"],
    ],
  },
  {
    name: "leaves duplicate provider names unqualified when complete model labels differ",
    providers: [provider("a", "Proxy"), provider("b", "Proxy", { models: [["other", "Other"]] })],
    expected: [
      ["a/m", "Proxy", "Model", "Proxy / Model"],
      ["b/other", "Proxy", "Other", "Proxy / Other"],
    ],
  },
  {
    name: "qualifies only overlapping model labels and ignores duplicate zero-model connections",
    providers: [
      provider("a", "Proxy", {
        models: [
          ["m", "Model"],
          ["other", "Other"],
        ],
      }),
      provider("b", "Proxy"),
      provider("empty", "Proxy", { models: [] }),
    ],
    options: {
      connected: ["a", "b", "empty"],
      accounts: new Map([
        ["a", "Work"],
        ["b", "Personal"],
      ]),
    },
    expected: [
      ["a/m", "Proxy (Work)", "Model", "Proxy (Work) / Model"],
      ["a/other", "Proxy", "Other", "Proxy / Other"],
      ["b/m", "Proxy (Personal)", "Model", "Proxy (Personal) / Model"],
    ],
  },
  {
    name: "does not qualify a model because another connected provider with the same name has no models",
    providers: [provider("a", "Proxy"), provider("empty", "Proxy", { models: [] })],
    options: { connected: ["a", "empty"] },
    expected: [["a/m", "Proxy", "Model", "Proxy / Model"]],
  },
  {
    name: "qualifies duplicate managed routes without inventing account names",
    providers: [
      root,
      managed,
      provider("remote", "Anomaly / OpenAI", { integrationID: "opencode", canonical: "openai" }),
    ],
    expected: [
      ["console-openai/m", "OpenAI (console-openai)", "Model", "Anomaly / OpenAI (console-openai) / Model"],
      ["remote/m", "OpenAI (remote)", "Model", "Anomaly / OpenAI (remote) / Model"],
    ],
  },
  {
    name: "uses supplied aliases for duplicate connection names",
    providers: [
      provider("a", "OpenAI", { integrationID: "openai" }),
      provider("b", "OpenAI", { integrationID: "openai" }),
    ],
    options: {
      accounts: new Map([
        ["a", "Work"],
        ["b", "Personal"],
      ]),
    },
    expected: [
      ["a/m", "OpenAI (Work)", "Model", "OpenAI (Work) / Model"],
      ["b/m", "OpenAI (Personal)", "Model", "OpenAI (Personal) / Model"],
    ],
  },
  {
    name: "adds stable provider IDs when supplied aliases also collide",
    providers: [provider("a", "OpenAI"), provider("b", "OpenAI")],
    options: {
      accounts: new Map([
        ["a", "Work"],
        ["b", "Work"],
      ]),
    },
    expected: [
      ["a/m", "OpenAI (Work, a)", "Model", "OpenAI (Work, a) / Model"],
      ["b/m", "OpenAI (Work, b)", "Model", "OpenAI (Work, b) / Model"],
    ],
  },
  {
    name: "qualifies duplicate model names on a single route with exact model IDs",
    providers: [
      provider("openai", "OpenAI", {
        models: [
          ["v1", "GPT"],
          ["v2", "GPT"],
        ],
      }),
    ],
    expected: [
      ["openai/v1", "OpenAI", "GPT (v1)", "OpenAI / GPT (v1)"],
      ["openai/v2", "OpenAI", "GPT (v2)", "OpenAI / GPT (v2)"],
    ],
  },
  {
    name: "counts connected direct routes with no models",
    providers: [root, managed, provider("openai", "Renamed", { models: [] })],
    options: { connected: ["opencode", "console-openai", "openai"] },
    expected: [["console-openai/m", "OpenCode / OpenAI", "Model", "Anomaly / OpenAI / Model"]],
  },
  {
    name: "ignores disconnected direct catalog entries for connection matching",
    providers: [root, managed, provider("openai", "OpenAI", { models: [] })],
    options: { connected: ["opencode", "console-openai"] },
    expected: [["console-openai/m", "OpenAI", "Model", "Anomaly / OpenAI / Model"]],
  },
  {
    name: "resolves global text collisions across provider and model boundaries",
    providers: [
      root,
      provider("remote", "Anomaly / A", { integrationID: "opencode", models: [["b", "B / Model"]] }),
      provider("direct", "A / B"),
    ],
    expected: [
      ["remote/b", "OpenCode / A", "B / Model", "Anomaly / A / B / Model"],
      ["direct/m", "A / B", "Model", "A / B / Model"],
    ],
  },
]

test.each(cases)("composer model labels: $name", (row) => {
  const expected = new Map(row.expected.map(([id, provider, model, full]) => [id, { provider, model, full }]))
  const catalog = new Map(row.providers.map((provider) => [provider.id, provider]))
  expect(composerModelLabels(catalog, row.options)).toEqual(expected)

  // Catalog/model enumeration order, connected order and account order cannot select a different label.
  const reversed = new Map(
    [...row.providers]
      .reverse()
      .map((provider) => [
        provider.id,
        { ...provider, models: Object.fromEntries(Object.entries(provider.models).reverse()) },
      ]),
  )

  expect(
    composerModelLabels(reversed, {
      connected: row.options?.connected && [...row.options.connected].reverse(),
      accounts: row.options?.accounts && new Map([...row.options.accounts].reverse()),
    }),
  ).toEqual(expected)
})

test("accepts the runtime provider catalog structurally", () => {
  const catalog: ReadonlyMap<string, Provider> = new Map()
  expect(composerModelLabels(catalog).size).toBe(0)
})
