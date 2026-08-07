import { Context, Effect, Layer, Option, Ref } from "effect"

/** One selectable model in the picker. */
export interface PageModel {
  readonly id: string
  readonly providerID: string
  readonly variants: readonly string[]
}

/** A page of the model picker, or a variant picked for a chosen model. */
export type ModelEntry =
  | {
    readonly kind: "page"
    readonly sessionID: string
    readonly models: readonly PageModel[]
    readonly page: number
    readonly total: number
    readonly chatId: number
    readonly messageId: number
  }
  | {
    readonly kind: "variant"
    readonly sessionID: string
    readonly providerID: string
    readonly modelID: string
    readonly variants: readonly string[]
    readonly chatId: number
    readonly messageId: number
  }

export interface ModelRegistryShape {
  readonly registerPage: (input: {
    readonly sessionID: string
    readonly models: readonly PageModel[]
    readonly page: number
    readonly total: number
    readonly chatId: number
  }) => Effect.Effect<number, never>
  readonly registerVariant: (input: {
    readonly sessionID: string
    readonly providerID: string
    readonly modelID: string
    readonly variants: readonly string[]
    readonly chatId: number
    readonly messageId: number
  }) => Effect.Effect<number, never>
  readonly attachMessageId: (token: number, messageId: number) => Effect.Effect<void, never>
  readonly take: (token: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<ModelEntry>, never>
  /** Remove the picker entries attached to a message after cancellation. */
  readonly cancel: (token: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<ModelEntry>, never>
}

export class ModelRegistry extends Context.Service<ModelRegistry, ModelRegistryShape>()(
  "opencode2-uis/ModelRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly entries: ReadonlyMap<number, ModelEntry>
}

export const Live: Layer.Layer<ModelRegistry> = Layer.effect(
  ModelRegistry,
  Effect.gen(function* () {
    const ref = yield* Ref.make<RegistryState>({ next: 1, entries: new Map() })
    return {
      registerPage: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: ModelEntry = { kind: "page", ...input, messageId: 0 }
          const entries = new Map(state.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      registerVariant: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: ModelEntry = { kind: "variant", ...input }
          const entries = new Map(state.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      attachMessageId: (token, messageId) =>
        Ref.update(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined) return state
          const entries = new Map(state.entries).set(token, { ...entry, messageId })
          return { ...state, entries }
        }),
      take: (token, chatId, messageId) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined) return [Option.none(), state]
          if (entry.chatId !== chatId || entry.messageId !== messageId) {
            return [Option.none(), state]
          }
          const entries = new Map(state.entries)
          entries.delete(token)
          return [Option.some(entry), { ...state, entries }]
        }),
      cancel: (token, chatId, messageId) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || entry.chatId !== chatId || entry.messageId !== messageId) {
            return [Option.none(), state]
          }
          const entries = new Map(state.entries)
          for (const [key, value] of entries) {
            if (value.chatId === chatId && value.messageId === messageId) entries.delete(key)
          }
          return [Option.some(entry), { ...state, entries }]
        }),
    }
  }),
)
