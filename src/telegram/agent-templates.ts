import { Context, Effect, Layer, Option, Schema } from "effect"
import type { StoredModel } from "../core/store.js"
import { InteractionStore, type InteractionStoreError, type JsonValue } from "./interaction-store.js"

/** Storage key for global agent model templates in SQLite. */
export const AGENT_TEMPLATE_KEY = "agent-model-templates"

/** Template names use lowercase letters, numbers, hyphens, and underscores. */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** Normalize a template name for storage and lookup. */
export const normalizeTemplateName = (value: string): string => value.trim().toLowerCase()

/** Check a template name after normalization. */
export const isTemplateName = (value: string): boolean => TEMPLATE_NAME_PATTERN.test(value)

const StoredModelSchema = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  variant: Schema.optional(Schema.String),
})

const TemplatesSchema = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, StoredModelSchema),
)

/** One template maps agent ids to stored models. */
export type AgentPairings = Record<string, StoredModel>

/** All templates map template names to pairing sets. */
export type AgentModelTemplates = Record<string, AgentPairings>

export interface TemplatePairing {
  readonly agentID: string
  readonly model: StoredModel
}

export interface TemplateSummary {
  readonly name: string
  readonly pairings: ReadonlyArray<TemplatePairing>
}

export type AddPairingResult = "created" | "added" | "exists"
export type ReplacePairingResult = "replaced" | "template-missing" | "pairing-missing"
export type RemovePairingResult = "removed" | "removed-template" | "template-missing" | "pairing-missing"
export type RemoveTemplateResult = "removed" | "missing"

/** Decode stored JSON into templates. Corrupt state reads as empty. */
const decodeTemplates = (value: JsonValue | undefined): AgentModelTemplates =>
  Option.getOrElse(Schema.decodeUnknownOption(TemplatesSchema)(value), () => ({}))

/** Sort templates and pairings for stable display. */
const summarizeTemplates = (state: AgentModelTemplates): ReadonlyArray<TemplateSummary> =>
  Object.entries(state)
    .map(([name, pairings]) => ({
      name,
      pairings: Object.entries(pairings)
        .map(([agentID, model]) => ({ agentID, model }))
        .sort((left, right) => left.agentID.localeCompare(right.agentID)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))

export interface AgentTemplatesService {
  readonly list: () => Effect.Effect<ReadonlyArray<TemplateSummary>, InteractionStoreError>
  readonly get: (template: string) => Effect.Effect<Option.Option<AgentPairings>, InteractionStoreError>
  readonly add: (input: {
    readonly template: string
    readonly agentID: string
    readonly model: StoredModel
  }) => Effect.Effect<AddPairingResult, InteractionStoreError>
  readonly replace: (input: {
    readonly template: string
    readonly agentID: string
    readonly model: StoredModel
  }) => Effect.Effect<ReplacePairingResult, InteractionStoreError>
  readonly removePairing: (input: {
    readonly template: string
    readonly agentID: string
  }) => Effect.Effect<RemovePairingResult, InteractionStoreError>
  readonly removeTemplate: (template: string) => Effect.Effect<RemoveTemplateResult, InteractionStoreError>
}

export class AgentTemplates extends Context.Service<AgentTemplates, AgentTemplatesService>()(
  "opencode2-uis/AgentTemplates",
) {}

export const Live: Layer.Layer<AgentTemplates, never, InteractionStore> = Layer.effect(
  AgentTemplates,
  Effect.gen(function* () {
    const interactions = yield* InteractionStore
    const read = (): Effect.Effect<AgentModelTemplates, InteractionStoreError> =>
      interactions.get(AGENT_TEMPLATE_KEY).pipe(
        Effect.map((current) => decodeTemplates(Option.getOrUndefined(current))),
      )
    return {
      list: () => read().pipe(Effect.map(summarizeTemplates)),
      get: (template) =>
        read().pipe(Effect.map((state) => Option.fromNullishOr(state[normalizeTemplateName(template)]))),
      add: (input) =>
        interactions.modify(AGENT_TEMPLATE_KEY, (current) => {
          const state = decodeTemplates(Option.getOrUndefined(current))
          const name = normalizeTemplateName(input.template)
          const existing = state[name]
          if (existing === undefined) {
            return ["created", { ...state, [name]: { [input.agentID]: input.model } }] as const
          }
          if (existing[input.agentID] !== undefined) return ["exists", state] as const
          return ["added", { ...state, [name]: { ...existing, [input.agentID]: input.model } }] as const
        }),
      replace: (input) =>
        interactions.modify(AGENT_TEMPLATE_KEY, (current) => {
          const state = decodeTemplates(Option.getOrUndefined(current))
          const name = normalizeTemplateName(input.template)
          const existing = state[name]
          if (existing === undefined) return ["template-missing", state] as const
          if (existing[input.agentID] === undefined) return ["pairing-missing", state] as const
          return [
            "replaced",
            { ...state, [name]: { ...existing, [input.agentID]: input.model } },
          ] as const
        }),
      removePairing: (input) =>
        interactions.modify(AGENT_TEMPLATE_KEY, (current) => {
          const state = decodeTemplates(Option.getOrUndefined(current))
          const name = normalizeTemplateName(input.template)
          const existing = state[name]
          if (existing === undefined) return ["template-missing", state] as const
          if (existing[input.agentID] === undefined) return ["pairing-missing", state] as const
          const remaining = { ...existing }
          delete remaining[input.agentID]
          if (Object.keys(remaining).length === 0) {
            const next = { ...state }
            delete next[name]
            return ["removed-template", next] as const
          }
          return ["removed", { ...state, [name]: remaining }] as const
        }),
      removeTemplate: (template) =>
        interactions.modify(AGENT_TEMPLATE_KEY, (current) => {
          const state = decodeTemplates(Option.getOrUndefined(current))
          const name = normalizeTemplateName(template)
          if (state[name] === undefined) return ["missing", state] as const
          const next = { ...state }
          delete next[name]
          return ["removed", next] as const
        }),
    }
  }),
)
