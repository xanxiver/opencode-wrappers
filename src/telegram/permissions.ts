import { Context, Effect, Layer, Option, Ref } from "effect"

/** Pending permission entries expire after this long (30 minutes). */
export const PERMISSION_TTL_MS = 30 * 60 * 1000

export interface PendingPermission {
  readonly sessionID: string
  readonly requestID: string
  readonly chatId: number
  readonly messageId: number
  readonly timeCreated: number
}

export const hasExpired = (timeCreated: number, now: number, ttlMs: number = PERMISSION_TTL_MS): boolean =>
  now - timeCreated > ttlMs

export interface PermissionRegistryShape {
  readonly register: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
  }) => Effect.Effect<number, never>
  readonly attachMessageId: (token: number, messageId: number) => Effect.Effect<void, never>
  /** Atomically claim a pending permission from its original Telegram message. */
  readonly claim: (
    token: number,
    chatId: number,
    messageId: number,
  ) => Effect.Effect<Option.Option<PendingPermission>, never>
  /** Restore a claimed permission when OpenCode rejects the reply. */
  readonly restore: (token: number, entry: PendingPermission) => Effect.Effect<void, never>
  readonly take: (token: number) => Effect.Effect<Option.Option<PendingPermission>, never>
}

export class PermissionRegistry extends Context.Service<PermissionRegistry, PermissionRegistryShape>()(
  "opencode2-uis/PermissionRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly entries: ReadonlyMap<number, PendingPermission>
}

export const Live: Layer.Layer<PermissionRegistry> = Layer.effect(
  PermissionRegistry,
  Effect.gen(function* () {
    const ref = yield* Ref.make<RegistryState>({ next: 1, entries: new Map() })
    const purgeExpired = (state: RegistryState, now: number): RegistryState => {
      const entries = new Map(state.entries)
      for (const [token, entry] of entries) {
        if (hasExpired(entry.timeCreated, now)) {
          entries.delete(token)
        }
      }
      return entries.size === state.entries.size ? state : { ...state, entries }
    }
    return {
      register: (input) =>
        Ref.modify(ref, (state) => {
          const now = Date.now()
          const clean = purgeExpired(state, now)
          const token = clean.next
          const entry: PendingPermission = {
            sessionID: input.sessionID,
            requestID: input.requestID,
            chatId: input.chatId,
            messageId: 0,
            timeCreated: now,
          }
          const entries = new Map(clean.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      attachMessageId: (token, messageId) =>
        Ref.update(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || hasExpired(entry.timeCreated, Date.now())) return state
          const entries = new Map(state.entries).set(token, { ...entry, messageId })
          return { ...state, entries }
        }),
      claim: (token, chatId, messageId) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined) return [Option.none(), state]
          if (hasExpired(entry.timeCreated, Date.now())) {
            const entries = new Map(state.entries)
            entries.delete(token)
            return [Option.none(), { ...state, entries }]
          }
          if (entry.chatId !== chatId || entry.messageId !== messageId) {
            return [Option.none(), state]
          }
          const entries = new Map(state.entries)
          entries.delete(token)
          return [Option.some(entry), { ...state, entries }]
        }),
      restore: (token, entry) =>
        Ref.update(ref, (state) => {
          if (hasExpired(entry.timeCreated, Date.now())) return state
          return { ...state, entries: new Map(state.entries).set(token, entry) }
        }),
      take: (token) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined) return [Option.none(), state]
          if (hasExpired(entry.timeCreated, Date.now())) {
            const entries = new Map(state.entries)
            entries.delete(token)
            return [Option.none(), { ...state, entries }]
          }
          const entries = new Map(state.entries)
          entries.delete(token)
          return [Option.some(entry), { ...state, entries }]
        }),
    }
  }),
)
