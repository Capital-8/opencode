export * as ConfigIntegration from "./integration.js"

import { Option, Schema, SchemaGetter } from "effect"
import { Config, type Entry } from "@opencode/schema/config"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { ConfigProvider } from "@opencode/schema/config/provider"
import { Connection } from "@opencode/schema/connection"
import { IntegrationID } from "@opencode/schema/integration-id"

// Drop statements whose action or effect is a value this version does not know, so a newer remote source can
// extend either enum. Malformed statements still fail validation.
export const Policies = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform((policies) =>
      policies.filter((policy) => {
        const action = Schema.decodeUnknownOption(Schema.Struct({ action: Schema.String }))(policy)
        if (Option.isSome(action) && !Schema.is(ConfigPolicy.Action)(action.value.action)) return false
        const effect = Schema.decodeUnknownOption(Schema.Struct({ effect: Schema.String }))(policy)
        return Option.isNone(effect) || Schema.is(ConfigPolicy.Effect)(effect.value.effect)
      }),
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
  Schema.decodeTo(Schema.Array(ConfigPolicy.Info)),
)

/**
 * The OpenCode Console's Library for the connection's workspace: instructions with their content, in the order they
 * load, and skills whose files download from the Console once per version.
 */
export const Library = Schema.Struct({
  instructions: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, content: Schema.String })).pipe(
    Schema.optional,
  ),
  skills: Schema.Array(Schema.Struct({ slug: Schema.String, version: Schema.String })).pipe(Schema.optional),
})
export type Library = typeof Library.Type

// A malformed library is dropped instead of failing the whole remote config, which would drop its policies too.
const RemoteLibrary = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.UndefinedOr(Library), {
    decode: SchemaGetter.transform((library) => Option.getOrUndefined(Schema.decodeUnknownOption(Library)(library))),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

/**
 * The allow-listed keys of a remote config. Only these keys are read before decoding, so a newer remote source's
 * other keys, valid or not, can never reject the document.
 */
export const Remote = Schema.Struct({
  providers: Config.Info.fields.providers,
  mcp: Config.Info.fields.mcp,
  policies: Policies.pipe(Schema.optional),
  websearch: Config.Info.fields.websearch,
  library: RemoteLibrary.pipe(Schema.optional),
})
export type Remote = typeof Remote.Type

/**
 * A config document delivered by an integration connection, such as the OpenCode Console's config. Config loads it
 * right after managed policies, so user and project config override its settings while its policies outrank theirs.
 * Its providers authenticate with, and only exist for, that connection.
 */
export class Document extends Config.Document.extend<Document>("Config.IntegrationDocument")({
  integrationID: IntegrationID,
  connection: Connection.Info,
  /** Organization behind the connection, named in denials by the document's policies. */
  organization: Schema.optional(Schema.String),
  /** Server behind the connection, without a trailing slash. The library's skill files download from it. */
  origin: Schema.optional(Schema.String),
  /** Library content the connection's workspace shares. It is not user config, so it stays out of `info`. */
  library: Schema.optional(Library),
}) {}

/**
 * A config document a well-known origin delivers. `integrationID` is the origin, so `integration.use` decides the
 * providers it defines by the origin rather than by provider ID.
 */
export class WellKnownDocument extends Config.Document.extend<WellKnownDocument>("Config.WellKnownDocument")({
  integrationID: IntegrationID,
}) {}

/** The integration whose delivered document last defines each provider. */
export function suppliers(entries: readonly Entry[]) {
  return new Map(
    entries
      .filter((entry): entry is WellKnownDocument => entry instanceof WellKnownDocument)
      .flatMap((document) => Object.keys(document.info.providers ?? {}).map((id) => [id, document.integrationID])),
  )
}

/**
 * Builds an integration document from the allow-listed keys of a remote config: providers, remote MCP servers,
 * policies, the web search selection, and the Library. A remote source can never load plugins, run commands, or
 * change any other local behavior through config.
 */
export function make(input: {
  readonly integrationID: IntegrationID
  readonly connection: Connection.Info
  readonly organization?: string
  readonly origin?: string
  readonly info: Remote
}) {
  const servers = input.info.mcp?.servers
  return new Document({
    type: "document",
    integrationID: input.integrationID,
    connection: input.connection,
    organization: input.organization,
    origin: input.origin,
    library: input.info.library,
    info: new Config.Info({
      providers:
        input.info.providers &&
        Object.fromEntries(
          Object.entries(input.info.providers).map(([id, provider]) => [
            id,
            new ConfigProvider.Info({
              ...provider,
              // The connection supplies credentials; `env` would read local variables as this provider's key.
              env: undefined,
              settings: withoutCredentials(provider.settings),
              models:
                provider.models &&
                Object.fromEntries(
                  Object.entries(provider.models).map(([modelID, model]) => [
                    modelID,
                    {
                      ...model,
                      settings: withoutCredentials(model.settings),
                      variants: model.variants?.map((variant) => ({
                        ...variant,
                        settings: withoutCredentials(variant.settings),
                      })),
                    },
                  ]),
                ),
            }),
          ]),
        ),
      // Local servers would run a command on this machine.
      mcp:
        servers &&
        new ConfigMCP.Info({
          servers: Object.fromEntries(Object.entries(servers).filter(([, server]) => server.type === "remote")),
        }),
      policies: input.info.policies,
      websearch: input.info.websearch,
    }),
  })
}

function withoutCredentials<Value>(settings: Readonly<Record<string, Value>> | undefined) {
  return (
    settings &&
    Object.fromEntries(
      Object.entries(settings).filter(([key]) => !["apiKey", "authToken", "accessToken"].includes(key)),
    )
  )
}
