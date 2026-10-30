import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema, Stream } from "effect"
import { AIClient, AIError, ai } from "../src/effect.js"
import { AI } from "../src/index.js"
import { ModelString } from "../src/model-string.js"
import { RequestExecutor } from "../src/route.js"
import { handlerLayer, json, observe, type Call } from "./lib/http.js"
import { it } from "./lib/effect.js"

// Every request is answered with a 400 so each test sees which endpoint, model id and env credential a string chose.
const calls: Array<Call> = []
const executor = RequestExecutor.layer.pipe(
  Layer.provide(
    handlerLayer((input) =>
      observe(calls, input).pipe(Effect.map(() => json(input, { error: { message: "stop" } }, { status: 400 }))),
    ),
  ),
)
const env = {
  OPENAI_API_KEY: "env-openai",
  ANTHROPIC_API_KEY: "env-anthropic",
  OPENROUTER_API_KEY: "env-openrouter",
  FIREWORKS_API_KEY: "env-fireworks",
}

const lastCall = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    calls.length = 0
    const error = yield* Effect.flip(effect)
    expect(calls).toHaveLength(1)
    return { error, call: calls[0], body: JSON.parse(calls[0].body) }
  }).pipe(
    Effect.provide(AIClient.layerWith(executor)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  )

const failure = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => error.reason),
    Effect.provide(AIClient.layerWith(executor)),
  )

const questions = [{ name: "spam", type: "predicate", instructions: "Is this spam?" }] as const

describe("ModelString", () => {
  test("covers every provider with text, image or decision models", async () => {
    const ids = Object.values(await import("../src/providers.js"))
      .filter((provider) => ["model", "imageModel", "decisionModel"].some((kind) => kind in provider))
      .map((provider) => provider.id)
      .filter((id) => !id.endsWith("-compatible"))
    expect(ModelString.providerIDs).toEqual(expect.arrayContaining(ids))
  })

  it.effect("resolves an OpenAI text model with its env key", () =>
    Effect.gen(function* () {
      const result = yield* lastCall(ai.generate({ model: "openai/gpt-5.4", prompt: "Hi" }))
      expect(result.call.url).toBe("https://api.openai.com/v1/responses")
      expect(result.call.headers.get("authorization")).toBe("Bearer env-openai")
      expect(result.body.model).toBe("gpt-5.4")
    }),
  )

  it.effect("resolves an Anthropic text model when streaming", () =>
    Effect.gen(function* () {
      const result = yield* lastCall(
        Stream.runDrain(
          ai.stream({ model: "anthropic/claude-haiku-4-5", prompt: "Hi", generation: { maxTokens: 8 } }),
        ),
      )
      expect(result.call.url).toStartWith("https://api.anthropic.com/v1/messages")
      expect(result.call.headers.get("x-api-key")).toBe("env-anthropic")
      expect(result.body.model).toBe("claude-haiku-4-5")
    }),
  )

  it.effect("keeps the slashes after the provider in the model id", () =>
    Effect.gen(function* () {
      const result = yield* lastCall(
        ai.generateObject({ model: "openrouter/openai/gpt-5.4", prompt: "Hi", schema: Schema.Struct({}) }),
      )
      expect(result.call.url).toBe("https://openrouter.ai/api/v1/chat/completions")
      expect(result.call.headers.get("authorization")).toBe("Bearer env-openrouter")
      expect(result.body.model).toBe("openai/gpt-5.4")
    }),
  )

  it.effect("accepts models.dev provider ids", () =>
    Effect.gen(function* () {
      const result = yield* lastCall(
        ai.generate({ model: "fireworks-ai/accounts/fireworks/models/kimi-k2", prompt: "Hi" }),
      )
      expect(result.call.url).toBe("https://api.fireworks.ai/inference/v1/chat/completions")
      expect(result.call.headers.get("authorization")).toBe("Bearer env-fireworks")
      expect(result.body.model).toBe("accounts/fireworks/models/kimi-k2")
    }),
  )

  it.effect("resolves image and decision models", () =>
    Effect.gen(function* () {
      const image = yield* lastCall(ai.image.generate({ model: "openai/gpt-image-1", prompt: "A cat" }))
      expect(image.call.url).toBe("https://api.openai.com/v1/images/generations")
      expect(image.body.model).toBe("gpt-image-1")

      const decision = yield* lastCall(
        ai.decision.generate({ model: "openai/gpt-5.4-nano", input: { message: "Buy now" }, questions }),
      )
      expect(decision.call.url).toBe("https://api.openai.com/v1/decisions")
      expect(decision.body.model).toBe("gpt-5.4-nano")
    }),
  )

  it.effect("fails on an unknown provider or a missing provider prefix", () =>
    Effect.gen(function* () {
      for (const model of ["nope/gpt-5.4", "gpt-5.4", "constructor/x"]) {
        const reason = yield* failure(ai.generate({ model, prompt: "Hi" }))
        expect(reason._tag).toBe("InvalidRequest")
        expect(reason.message).toContain(`Unknown provider in model "${model}"`)
        expect(reason.message).toContain("anthropic, ")
      }
    }),
  )

  it.effect("fails when the provider has no model of that kind", () =>
    Effect.gen(function* () {
      const image = yield* failure(ai.image.generate({ model: "anthropic/claude-haiku-4-5", prompt: "A cat" }))
      expect(image.message).toBe('Provider "anthropic" has no image models')
      const decision = yield* failure(
        ai.decision.generate({ model: "groq/llama", input: { message: "Buy now" }, questions }),
      )
      expect(decision.message).toBe('Provider "groq" has no decision models')
    }),
  )

  it.effect("reports settings a provider needs", () =>
    Effect.gen(function* () {
      const reason = yield* failure(ai.generate({ model: "azure/gpt-5.4", prompt: "Hi" }))
      expect(reason._tag).toBe("InvalidRequest")
      expect(reason.message).toContain("resourceName")
    }),
  )

  it.live("rejects unknown providers through the Promise client", () =>
    Effect.promise(async () => {
      const client = AI.make({ layer: executor })
      const error = await client.generate({ model: "nope/gpt-5.4", prompt: "Hi" }).catch((error) => error)
      await client.dispose()
      expect(error).toBeInstanceOf(AIError)
      expect(error.reason._tag).toBe("InvalidRequest")
    }),
  )
})
