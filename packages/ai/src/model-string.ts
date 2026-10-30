import { Effect } from "effect"
import type { DecisionModel } from "./decision.js"
import type { ImageModel } from "./image.js"
import { tryRequest } from "./media-model.js"
import { AIError, InvalidRequestError, type LanguageModel } from "./schema/index.js"

/**
 * Resolves `"provider/model"` strings to a provider's default model with env auth and no settings. The provider
 * module is imported only when a string names it. Until a bundled catalog exists, the provider is the text before
 * the first `/` and the model id is the rest.
 */
interface Loaders {
  model?(modelID: string, settings: {}): LanguageModel
  imageModel?(modelID: string, settings: {}): ImageModel
  decisionModel?(modelID: string, settings: {}): DecisionModel
}

const providers: Record<string, () => Promise<Loaders>> = {
  alibaba: () => import("./providers/alibaba.js"),
  "amazon-bedrock": () => import("./providers/amazon-bedrock.js"),
  anthropic: () => import("./providers/anthropic.js"),
  azure: () => import("./providers/azure.js"),
  baseten: () => import("./providers/baseten.js"),
  cerebras: () => import("./providers/cerebras.js"),
  "cloudflare-ai-gateway": () => import("./providers/cloudflare-ai-gateway.js"),
  "cloudflare-workers-ai": () => import("./providers/cloudflare-workers-ai.js"),
  cohere: () => import("./providers/cohere.js"),
  deepinfra: () => import("./providers/deepinfra.js"),
  deepseek: () => import("./providers/deepseek.js"),
  digitalocean: () => import("./providers/digitalocean.js"),
  fireworks: () => import("./providers/fireworks.js"),
  google: () => import("./providers/google.js"),
  "google-vertex": () => import("./providers/google-vertex.js"),
  groq: () => import("./providers/groq.js"),
  meta: () => import("./providers/meta.js"),
  minimax: () => import("./providers/minimax.js"),
  mistral: () => import("./providers/mistral.js"),
  moonshotai: () => import("./providers/moonshot.js"),
  openai: () => import("./providers/openai.js"),
  opencode: () => import("./providers/opencode.js"),
  openrouter: () => import("./providers/openrouter.js"),
  togetherai: () => import("./providers/togetherai.js"),
  "typesafe-ai": () => import("./providers/typesafe-ai.js"),
  venice: () => import("./providers/venice.js"),
  "vercel-ai-gateway": () => import("./providers/vercel-ai-gateway.js"),
  xai: () => import("./providers/xai.js"),
  zai: () => import("./providers/zai.js"),
  "zai-coding-plan": () => import("./providers/zai-coding-plan.js"),
  // models.dev ids that differ from the provider module's id.
  "fireworks-ai": () => import("./providers/fireworks.js"),
  "google-vertex-anthropic": () => import("./providers/google-vertex-messages.js"),
  vercel: () => import("./providers/vercel-ai-gateway.js"),
}

export const providerIDs = Object.keys(providers)

const kinds = { model: "text", imageModel: "image", decisionModel: "decision" } as const

const resolve = <Kind extends keyof Loaders>(kind: Kind, model: string) =>
  Effect.gen(function* () {
    const slash = model.indexOf("/")
    const provider = model.slice(0, slash)
    if (slash <= 0 || !Object.hasOwn(providers, provider))
      return yield* invalid(
        `Unknown provider in model "${model}". Use "provider/model" with one of: ${providerIDs.join(", ")}`,
      )
    const module = yield* Effect.tryPromise({
      try: () => providers[provider](),
      catch: (cause) => invalid(`Failed to load the ${provider} provider`, cause),
    })
    const make = module[kind]
    if (make === undefined) return yield* invalid(`Provider "${provider}" has no ${kinds[kind]} models`)
    return yield* tryRequest(() => make(model.slice(slash + 1), {}) as ReturnType<NonNullable<Loaders[Kind]>>)
  })

const invalid = (message: string, cause?: unknown) =>
  new AIError({ reason: new InvalidRequestError({ message, cause }) })

export const language = (model: LanguageModel | string) =>
  typeof model === "string" ? resolve("model", model) : Effect.succeed(model)

export const image = (model: ImageModel | string) =>
  typeof model === "string" ? resolve("imageModel", model) : Effect.succeed(model)

export const decision = (model: DecisionModel | string) =>
  typeof model === "string" ? resolve("decisionModel", model) : Effect.succeed(model)

export * as ModelString from "./model-string.js"
