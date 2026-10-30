import { ai as effect } from "../src/effect.js"
import { ai } from "../src/index.js"
import { OpenAI } from "../src/providers.js"

const ids = ["openai/gpt-5.4-nano", "anthropic/claude-haiku-4-5"] as const
declare const configured: string

effect.generate({ model: "openai/gpt-5.4", prompt: "Hi", providerOptions: { store: false } })
effect.stream({ model: configured, prompt: "Hi" })
effect.loop({ model: ids[0], prompt: "Hi", tools: {} })
void Promise.all(ids.map((model) => ai.generate({ model, prompt: "Hi" })))
void ai.generateObject({ model: "openai/gpt-5.4", prompt: "Hi", jsonSchema: { type: "object" } })
effect.image.generate({ model: "openai/gpt-image-1", prompt: "A cat", providerOptions: { quality: "high" } })
effect.image.resume("openai/gpt-image-1", {})
effect.decision.generate({
  model: "openai/gpt-5.4-nano",
  input: { message: "Buy now" },
  questions: [{ name: "spam", type: "predicate", instructions: "Is this spam?" }],
})

// A model object keeps its typed provider options.
effect.generate({ model: OpenAI.model("gpt-5.4"), prompt: "Hi", providerOptions: { store: false } })
// @ts-expect-error OpenAI options keep their known value types.
effect.generate({ model: OpenAI.model("gpt-5.4"), prompt: "Hi", providerOptions: { store: "no" } })
// @ts-expect-error `ai.request` builds a request synchronously, so it needs a model object.
effect.request({ model: "openai/gpt-5.4", prompt: "Hi" })
// @ts-expect-error A model is a string or a model object.
effect.generate({ model: 1, prompt: "Hi" })
