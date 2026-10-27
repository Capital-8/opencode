import { consoleProviderGroup, consoleProviderName } from "@/providers/catalog/console"

export type ComposerModelLabel = { provider?: string; model: string; full: string }

type Provider = {
  id: string
  name: string
  canonical?: string
  integrationID?: string
  models: Readonly<Record<string, { id: string; name: string }>>
}

export function composerModelLabelKey(providerID: string, modelID: string) {
  return JSON.stringify([providerID, modelID])
}

export function composerProviderName(
  providerID: string,
  catalog: ReadonlyMap<string, Provider>,
  options?: { connected?: readonly string[]; origin?: string },
) {
  const provider = catalog.get(providerID)

  if (!provider) return providerID
  const all = [...catalog.values()]
  const group = consoleProviderGroup(all)

  const name =
    provider.integrationID === "opencode" && group ? consoleProviderName(group, provider.name) : provider.name

  if (provider.integrationID !== "opencode" || !provider.canonical) return name
  const connected = options?.connected && new Set(options.connected)

  const direct = all.some(
    (item) =>
      !native(item) &&
      item.integrationID !== "opencode" &&
      (!connected || connected.has(item.id)) &&
      (item.integrationID ?? item.id) === provider.canonical,
  )

  return direct ? `${options?.origin ?? group?.workspace ?? "OpenCode"} / ${name}` : name
}

export function composerModelLabels(
  catalog: ReadonlyMap<string, Provider>,
  options?: { connected?: readonly string[] },
): ReadonlyMap<string, ComposerModelLabel> {
  const connected = options?.connected && new Set(options.connected)
  const active = (id: string) => !connected || connected.has(id)

  const rows = [...catalog.values()].flatMap((provider) => {
    const name = native(provider)
      ? undefined
      : composerProviderName(provider.id, catalog, { ...options, origin: "OpenCode" })

    return Object.values(provider.models).map((model) => ({
      key: composerModelLabelKey(provider.id, model.id),
      providerID: provider.id,
      modelID: model.id,
      originalProvider: provider.name,
      provider: name,
      model: model.name,
      text: name ? `${name} / ${model.name}` : model.name,
    }))
  })

  const groups = Map.groupBy(
    rows.filter((row) => active(row.providerID)),
    (row) => row.text,
  )

  return new Map(
    rows.map((row) => {
      const peers = active(row.providerID) ? groups.get(row.text) : undefined
      const provider = peers?.some((other) => other.providerID !== row.providerID) ? row.providerID : row.provider

      const model = peers?.some((other) => other.providerID === row.providerID && other.modelID !== row.modelID)
        ? `${row.model} (${row.modelID})`
        : row.model

      const visible = provider ? `${provider} / ${model}` : model
      const full = `${row.originalProvider} / ${model}`

      return [row.key, { provider, model, full: full.includes(visible) ? full : `${visible} (${full})` }]
    }),
  )
}

function native(provider: Provider) {
  return provider.id === "opencode" && (!provider.integrationID || provider.integrationID === "opencode")
}
