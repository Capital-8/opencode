import { consoleProviderGroup, consoleProviderName } from "@/providers/catalog/console"

export type ComposerModelLabel = { provider?: string; model: string; full: string }

export function composerModelLabelKey(providerID: string, modelID: string) {
  return JSON.stringify([providerID, modelID])
}

type Provider = {
  id: string
  name: string
  canonical?: string
  integrationID?: string
  models: Readonly<Record<string, { id: string; name: string }>>
}

export function composerModelLabels(
  catalog: ReadonlyMap<string, Provider>,
  options?: { connected?: readonly string[]; accounts?: ReadonlyMap<string, string> },
): ReadonlyMap<string, ComposerModelLabel> {
  const all = [...catalog.values()]
  const connected = options?.connected && new Set(options.connected)
  const active = (id: string) => !connected || connected.has(id)
  const group = consoleProviderGroup(all)

  const native = (provider: Provider) =>
    provider.id === "opencode" && (!provider.integrationID || provider.integrationID === "opencode")

  const managed = (provider: Provider) => provider.integrationID === "opencode" && !native(provider)

  // A custom proxy's canonical provider describes catalog inheritance, not its connection route.
  const direct = new Set(
    all.flatMap((provider) =>
      active(provider.id) && !native(provider) && !managed(provider) ? [provider.integrationID ?? provider.id] : [],
    ),
  )

  const rows = all.flatMap((provider) => {
    const name = managed(provider) && group ? consoleProviderName(group, provider.name) : provider.name
    const origin = managed(provider) && !!provider.canonical && direct.has(provider.canonical)
    const models = Object.values(provider.models)
    const duplicateModels = counts(models.map((model) => model.name))

    return models.map((model) => {
      const modelName = (duplicateModels.get(model.name) ?? 0) > 1 ? `${model.name} (${model.id})` : model.name

      return {
        id: composerModelLabelKey(provider.id, model.id),
        providerID: provider.id,
        modelID: model.id,
        originalProvider: provider.name,
        originalModel: model.name,
        managed: managed(provider),
        native: native(provider),
        origin,
        label: {
          provider: native(provider) ? undefined : origin ? `OpenCode / ${name}` : name,
          model: modelName,
          full: `${provider.name} / ${modelName}`,
        },
      }
    })
  })

  const collisions = counts(rows.flatMap((row) => (active(row.providerID) ? [text(row.label)] : [])))

  const directLabels = new Set(
    rows.flatMap((row) => (active(row.providerID) && !row.managed && !row.native ? [text(row.label)] : [])),
  )

  const resolved = rows.map((row) => {
    if (!active(row.providerID) || (collisions.get(text(row.label)) ?? 0) < 2) return row

    if (row.native) return { ...row, label: { ...row.label, provider: "OpenCode" } }

    if (row.managed && !row.origin && directLabels.has(text(row.label)))
      return { ...row, label: { ...row.label, provider: `OpenCode / ${row.label.provider}` } }

    return row
  })

  const duplicates = counts(resolved.flatMap((row) => (active(row.providerID) ? [text(row.label)] : [])))

  const aliases = counts(
    resolved.flatMap((row) =>
      active(row.providerID) && (duplicates.get(text(row.label)) ?? 0) > 1
        ? [JSON.stringify([text(row.label), options?.accounts?.get(row.providerID)])]
        : [],
    ),
  )

  const qualified = resolved.map((row) => {
    if (!active(row.providerID) || (duplicates.get(text(row.label)) ?? 0) < 2) return row

    if (
      !resolved.some(
        (other) =>
          active(other.providerID) && other.providerID !== row.providerID && text(other.label) === text(row.label),
      )
    ) {
      const model = `${row.originalModel} (${row.modelID})`

      return { ...row, label: { ...row.label, model, full: `${row.originalProvider} / ${model}` } }
    }

    const alias = options?.accounts?.get(row.providerID)

    const qualifier =
      alias && aliases.get(JSON.stringify([text(row.label), alias])) === 1
        ? alias
        : alias
          ? `${alias}, ${row.providerID}`
          : row.providerID

    return {
      ...row,
      label: {
        ...row.label,
        provider: `${row.label.provider ?? "OpenCode"} (${qualifier})`,
        full: `${row.originalProvider} (${qualifier}) / ${row.label.model}`,
      },
    }
  })

  const remaining = counts(qualified.flatMap((row) => (active(row.providerID) ? [text(row.label)] : [])))
  const full = counts(qualified.flatMap((row) => (active(row.providerID) ? [row.label.full] : [])))

  return new Map(
    qualified.map((row) => {
      if (!active(row.providerID)) return [row.id, row.label]
      const collision = (remaining.get(text(row.label)) ?? 0) > 1

      const sameProvider =
        collision &&
        qualified.some(
          (other) =>
            other.id !== row.id && other.providerID === row.providerID && text(other.label) === text(row.label),
        )

      const label = collision
        ? {
            ...row.label,
            provider: sameProvider ? row.label.provider : `${row.label.provider ?? "OpenCode"} (${row.providerID})`,
            model: sameProvider ? `${row.label.model} (${row.modelID})` : row.label.model,
          }
        : row.label

      const context =
        collision || (full.get(row.label.full) ?? 0) > 1
          ? `${row.label.full} (${sameProvider ? row.modelID : row.providerID})`
          : row.label.full

      const visible = text(label)

      return [
        row.id,
        {
          ...label,
          full: context.includes(visible) ? context : `${visible} (${context})`,
        },
      ]
    }),
  )
}

function text(label: ComposerModelLabel) {
  return label.provider ? `${label.provider} / ${label.model}` : label.model
}

function counts(values: readonly string[]) {
  const result = new Map<string, number>()
  values.forEach((value) => result.set(value, (result.get(value) ?? 0) + 1))

  return result
}
