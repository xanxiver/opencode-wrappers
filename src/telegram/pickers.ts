import { Context, Effect, Layer, Option, Ref } from "effect"

/** A directory chosen from the project picker. */
export interface PendingDirectory {
  readonly directory: string
  readonly chatId: number
  readonly messageId: number
}

/** A page in the project-directory picker. */
export interface PendingDirectoryPage {
  readonly kind: "directory-page"
  readonly directories: readonly string[]
  readonly page: number
  readonly chatId: number
  readonly messageId: number
}

/** A session chosen from the session list. */
export interface PendingSession {
  readonly sessionID: string
  readonly directory: string
  readonly title: Option.Option<string>
  readonly chatId: number
  readonly messageId: number
}

export interface PendingSessionPage {
  readonly kind: "session-page"
  readonly directory: string
  readonly chatId: number
  readonly current: { readonly cursor?: string }
  readonly history: readonly { readonly cursor?: string }[]
  readonly next?: string
  readonly messageId: number
}

export type PickerEntry = PendingDirectory | PendingDirectoryPage | PendingSession | PendingSessionPage

export interface PickerService {
  readonly registerDirectory: (input: { readonly directory: string; readonly chatId: number }) =>
    Effect.Effect<number, never>
  readonly registerDirectoryPage: (input: {
    readonly directories: readonly string[]
    readonly page: number
    readonly chatId: number
  }) => Effect.Effect<number, never>
  readonly registerSession: (input: {
    readonly sessionID: string
    readonly directory: string
    readonly title: Option.Option<string>
    readonly chatId: number
  }) => Effect.Effect<number, never>
  readonly registerSessionPage: (input: {
    readonly directory: string
    readonly chatId: number
    readonly current: { readonly cursor?: string }
    readonly history: readonly { readonly cursor?: string }[]
    readonly next?: string
  }) => Effect.Effect<number, never>
  readonly attachMessageId: (token: number, messageId: number) => Effect.Effect<void, never>
  readonly take: (token: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PickerEntry>, never>
  /** Remove the picker entries attached to a message after cancellation. */
  readonly cancel: (token: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PickerEntry>, never>
}

export class Pickers extends Context.Service<Pickers, PickerService>()("opencode2-uis/Pickers") {}

interface RegistryState {
  readonly next: number
  readonly entries: ReadonlyMap<number, PickerEntry>
}

export const Live: Layer.Layer<Pickers> = Layer.effect(
  Pickers,
  Effect.gen(function* () {
    const ref = yield* Ref.make<RegistryState>({ next: 1, entries: new Map() })
    return {
      registerDirectory: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: PickerEntry = { ...input, messageId: 0 }
          const entries = new Map(state.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      registerDirectoryPage: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: PickerEntry = { kind: "directory-page", ...input, messageId: 0 }
          const entries = new Map(state.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      registerSession: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: PickerEntry = {
            sessionID: input.sessionID,
            directory: input.directory,
            title: input.title,
            chatId: input.chatId,
            messageId: 0,
          }
          const entries = new Map(state.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      registerSessionPage: (input) =>
        Ref.modify(ref, (state) => {
          const token = state.next
          const entry: PickerEntry = { kind: "session-page", ...input, messageId: 0 }
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
