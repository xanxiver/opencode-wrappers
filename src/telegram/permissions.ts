import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { InteractionStore, InteractionStoreError } from "./interaction-store.js"

/** Pending permission entries expire after this long (30 minutes). */
export const PERMISSION_TTL_MS = 30 * 60 * 1000
export const REPLY_LEASE_MS = 2 * 60 * 1000
export const DELIVERY_UNCERTAIN_MESSAGE_ID = -1
export const DELIVERY_REJECTED_MESSAGE_ID = -2
export const DELIVERY_IN_FLIGHT_MESSAGE_ID = -3
export type PromptDeliveryFailure = "uncertain" | "rejected"

export interface PendingPermission {
  readonly sessionID: string
  readonly requestID: string
  readonly chatId: number
  readonly messageId: number
  readonly timeCreated: number
  readonly replyingSince?: number
  readonly replyLeaseExpiresAt?: number
  readonly replyGeneration?: number
  readonly deliveryClaimedAt?: number
  readonly deliveryGeneration?: number
}

export interface PermissionReplyClaim {
  readonly entry: PendingPermission
  readonly generation: number
}

export interface SessionRoute {
  readonly chatId: number
  readonly threadId?: number
}

export const hasExpired = (timeCreated: number, now: number, ttlMs: number = PERMISSION_TTL_MS): boolean =>
  now - timeCreated > ttlMs

export interface PermissionRegistryService {
  readonly purgeExpired: Effect.Effect<void, InteractionStoreError>
  /** Record the Telegram destination that started the current session run. */
  readonly setSessionRoute: (sessionID: string, route: SessionRoute) => Effect.Effect<void, InteractionStoreError>
  /** Keep the existing owner route, or install the supplied route atomically. */
  readonly getOrSetSessionRoute: (sessionID: string, route: SessionRoute) => Effect.Effect<SessionRoute, InteractionStoreError>
  readonly getSessionRoute: (sessionID: string) => Effect.Effect<Option.Option<SessionRoute>, InteractionStoreError>
  /** Move unresolved prompts to a replacement session destination. */
  readonly rerouteSession: (sessionID: string, route: SessionRoute) => Effect.Effect<boolean, InteractionStoreError>
  readonly register: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
  }) => Effect.Effect<number, InteractionStoreError>
  /** Register only when the OpenCode request is not already surfaced. */
  readonly registerIfAbsent: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
  }) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  /** Register a request, or resume one whose Telegram message was not persisted. */
  readonly registerOrResume: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
  }) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  /** Atomically claim an unsent Telegram prompt before crossing the API boundary. */
  readonly claimDelivery: (token: number, chatId: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly claimDeliveryWithGeneration: (token: number, chatId: number) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  readonly rejectDelivery: (token: number, chatId: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly rejectDeliveryWithGeneration: (token: number, chatId: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  /** Find an active permission by its OpenCode identity without removing it. */
  readonly findByRequest: (chatId: number, sessionID: string, requestID: string) =>
    Effect.Effect<Option.Option<PendingPermission>, InteractionStoreError>
  readonly attachMessageId: (token: number, messageId: number, generation?: number) => Effect.Effect<void, InteractionStoreError>
  /** Read a permission only from its original Telegram message. */
  readonly getForMessage: (token: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PendingPermission>, InteractionStoreError>
  /** Atomically claim a pending permission from its original Telegram message. */
  readonly claim: (
    token: number,
    chatId: number,
    messageId: number,
  ) => Effect.Effect<Option.Option<PermissionReplyClaim>, InteractionStoreError>
  readonly renewClaim: (token: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  /** Restore a claimed permission when OpenCode rejects the reply. */
  readonly restoreClaim: (token: number, claim: PermissionReplyClaim) => Effect.Effect<boolean, InteractionStoreError>
  readonly completeClaim: (token: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  /** Make an operator-reviewed ambiguous Telegram send eligible for retry. */
  readonly retryUncertainDelivery: (token: number, chatId: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly listUncertainDeliveries: (chatId: number) => Effect.Effect<readonly { readonly token: number; readonly entry: PendingPermission; readonly failure: PromptDeliveryFailure }[], InteractionStoreError>
  readonly remove: (token: number) => Effect.Effect<void, InteractionStoreError>
  readonly take: (token: number) => Effect.Effect<Option.Option<PendingPermission>, InteractionStoreError>
}

export class PermissionRegistry extends Context.Service<PermissionRegistry, PermissionRegistryService>()(
  "opencode2-uis/PermissionRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly nextClaim: number
  readonly entries: ReadonlyMap<number, PendingPermission>
  readonly routes: ReadonlyMap<string, SessionRoute>
}

const STORE_KEY = "permissions"
const PendingPermissionSchema = Schema.Struct({
  sessionID: Schema.String,
  requestID: Schema.String,
  chatId: Schema.Number,
  messageId: Schema.Number,
  timeCreated: Schema.Number,
  replyingSince: Schema.optional(Schema.Number),
  replyLeaseExpiresAt: Schema.optional(Schema.Number),
  replyGeneration: Schema.optional(Schema.Number),
  deliveryClaimedAt: Schema.optional(Schema.Number),
  deliveryGeneration: Schema.optional(Schema.Number),
})
const SessionRouteSchema = Schema.Struct({ chatId: Schema.Number, threadId: Schema.optional(Schema.Number) })
const PersistedStateSchema = Schema.Struct({
  next: Schema.Number,
  nextClaim: Schema.optional(Schema.Number),
  entries: Schema.Array(Schema.Struct({ token: Schema.Number, entry: PendingPermissionSchema })),
  routes: Schema.Array(Schema.Struct({ sessionID: Schema.String, route: SessionRouteSchema })),
})

const encodeState = (state: RegistryState) => ({
  next: state.next,
  nextClaim: state.nextClaim,
  entries: [...state.entries].map(([token, entry]) => ({ token, entry })),
  routes: [...state.routes].map(([sessionID, route]) => ({ sessionID, route })),
})

const stateFromStored = (stored: Option.Option<unknown>): RegistryState => Option.match(stored, {
  onNone: () => ({ next: 1, nextClaim: 1, entries: new Map(), routes: new Map() }),
  onSome: (value) => {
    const decoded = Schema.decodeUnknownOption(PersistedStateSchema)(value)
    if (Option.isNone(decoded)) throw new InteractionStoreError({ operation: "decode permission state", cause: value })
    return {
      next: decoded.value.next,
      nextClaim: decoded.value.nextClaim ?? 1,
      entries: new Map(decoded.value.entries.map(({ token, entry }) => [token, entry])),
      routes: new Map(decoded.value.routes.map(({ sessionID, route }) => [sessionID, route])),
    }
  },
})

export const Live: Layer.Layer<PermissionRegistry, InteractionStoreError, InteractionStore> = Layer.effect(
  PermissionRegistry,
  Effect.gen(function* () {
    const persistence = yield* InteractionStore
    yield* persistence.get(STORE_KEY).pipe(Effect.flatMap((stored) => Effect.try({
      try: () => stateFromStored(stored),
      catch: (cause) => cause instanceof InteractionStoreError ? cause : new InteractionStoreError({ operation: "decode permission state", cause }),
    })))
    const modify = <A>(
      change: (state: RegistryState) => readonly [A, RegistryState],
    ): Effect.Effect<A, InteractionStoreError> =>
      persistence.modify(STORE_KEY, (stored) => {
        const [value, next] = change(stateFromStored(stored))
        return [value, encodeState(next)]
      })
    const update = (change: (state: RegistryState) => RegistryState): Effect.Effect<void, InteractionStoreError> =>
      modify((state) => [undefined, change(state)])
    const purgeExpired = (state: RegistryState, now: number): RegistryState => {
      const entries = new Map(state.entries)
      for (const [token, entry] of entries) {
        if (hasExpired(entry.timeCreated, now)) {
          entries.delete(token)
        }
      }
      return entries.size === state.entries.size ? state : { ...state, entries }
    }
    const cleanState = (state: RegistryState, now: number): RegistryState => {
      const current = purgeExpired(state, now)
      let changed = false
      const entries = new Map(current.entries)
      for (const [token, entry] of entries) {
        if (entry.messageId === DELIVERY_IN_FLIGHT_MESSAGE_ID) {
          if (entry.deliveryClaimedAt !== undefined && entry.deliveryClaimedAt + REPLY_LEASE_MS > now) continue
          changed = true
          entries.set(token, { ...entry, messageId: DELIVERY_UNCERTAIN_MESSAGE_ID, deliveryClaimedAt: undefined, deliveryGeneration: undefined })
          continue
        }
        if (entry.replyingSince === undefined) continue
        if (entry.replyLeaseExpiresAt !== undefined && entry.replyLeaseExpiresAt > now) continue
        changed = true
        entries.set(token, {
          ...entry,
          replyingSince: undefined,
          replyLeaseExpiresAt: undefined,
          replyGeneration: undefined,
        })
      }
      return changed ? { ...current, entries } : current
    }
    return {
      purgeExpired: Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => update((state) => purgeExpired(state, now))),
      ),
      setSessionRoute: (sessionID, route) =>
        update((state) => ({
          ...state,
          routes: new Map(state.routes).set(sessionID, route),
        })),
      getOrSetSessionRoute: (sessionID, route) => modify((state) => {
        const existing = state.routes.get(sessionID)
        if (existing !== undefined) return [existing, state]
        return [route, { ...state, routes: new Map(state.routes).set(sessionID, route) }]
      }),
      getSessionRoute: (sessionID) =>
        modify((state) => [Option.fromNullishOr(state.routes.get(sessionID)), state]),
      rerouteSession: (sessionID, route) => modify((state) => {
        const previous = state.routes.get(sessionID)
        const changedRoute = previous?.chatId !== route.chatId || previous.threadId !== route.threadId
        if (!changedRoute) return [false, state]
        let changed = false
        const entries = new Map(state.entries)
        for (const [token, entry] of entries) {
          if (entry.sessionID !== sessionID) continue
          changed = true
          let messageId = entry.messageId
          if (messageId === DELIVERY_IN_FLIGHT_MESSAGE_ID) messageId = DELIVERY_UNCERTAIN_MESSAGE_ID
          else if (messageId === DELIVERY_REJECTED_MESSAGE_ID) messageId = 0
          else if (messageId > 0) messageId = 0
          entries.set(token, {
            ...entry,
            chatId: route.chatId,
            messageId,
            deliveryClaimedAt: undefined,
            deliveryGeneration: undefined,
          })
        }
        return [true, {
          ...state,
          entries: changed ? entries : state.entries,
          routes: new Map(state.routes).set(sessionID, route),
        }]
      }),
      register: (input) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const token = clean.next
          const entry: PendingPermission = {
            sessionID: input.sessionID,
            requestID: input.requestID,
            chatId: input.chatId,
            messageId: 0,
            timeCreated: now,
          }
          const entries = new Map(clean.entries).set(token, entry)
          return [token, { ...clean, next: token + 1, entries }]
        })),
      ),
      registerIfAbsent: (input) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          for (const entry of clean.entries.values()) {
            if (entry.chatId === input.chatId && entry.sessionID === input.sessionID && entry.requestID === input.requestID) return [Option.none(), clean]
          }
          const token = clean.next
          const entry: PendingPermission = { ...input, messageId: 0, timeCreated: now }
          return [Option.some(token), { ...clean, next: token + 1, entries: new Map(clean.entries).set(token, entry) }]
        })),
      ),
      registerOrResume: (input) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          for (const [token, entry] of clean.entries) {
            if (entry.chatId === input.chatId && entry.sessionID === input.sessionID && entry.requestID === input.requestID) {
              return [entry.messageId === 0 ? Option.some(token) : Option.none(), clean]
            }
          }
          const token = clean.next
          const entry: PendingPermission = { ...input, messageId: 0, timeCreated: now }
          return [Option.some(token), { ...clean, next: token + 1, entries: new Map(clean.entries).set(token, entry) }]
        })),
      ),
      claimDeliveryWithGeneration: (token, chatId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const clean = cleanState(state, now)
        const entry = clean.entries.get(token)
        const generation = clean.nextClaim
        if (entry === undefined || entry.chatId !== chatId || entry.messageId !== 0) return [Option.none(), clean]
        return [Option.some(generation), { ...clean, nextClaim: generation + 1, entries: new Map(clean.entries).set(token, { ...entry, messageId: DELIVERY_IN_FLIGHT_MESSAGE_ID, deliveryClaimedAt: now, deliveryGeneration: generation }) }]
      }))),
      claimDelivery: (token, chatId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const clean = cleanState(state, now)
        const entry = clean.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageId !== 0) return [false, clean]
        return [true, { ...clean, entries: new Map(clean.entries).set(token, { ...entry, messageId: DELIVERY_IN_FLIGHT_MESSAGE_ID, deliveryClaimedAt: now, deliveryGeneration: undefined }) }]
      }))),
      rejectDeliveryWithGeneration: (token, chatId, generation) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageId !== DELIVERY_IN_FLIGHT_MESSAGE_ID || entry.deliveryGeneration !== generation) return [false, state]
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageId: DELIVERY_REJECTED_MESSAGE_ID, deliveryClaimedAt: undefined, deliveryGeneration: undefined }) }]
      }),
      rejectDelivery: (token, chatId) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageId !== DELIVERY_IN_FLIGHT_MESSAGE_ID) return [false, state]
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageId: DELIVERY_REJECTED_MESSAGE_ID, deliveryClaimedAt: undefined, deliveryGeneration: undefined }) }]
      }),
      findByRequest: (chatId, sessionID, requestID) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
            const clean = cleanState(state, now)
            for (const entry of clean.entries.values()) {
              if (!hasExpired(entry.timeCreated, now) && entry.chatId === chatId && entry.sessionID === sessionID && entry.requestID === requestID) {
                return [Option.some(entry), clean]
              }
            }
            return [Option.none(), clean]
          })),
      ),
      attachMessageId: (token, messageId, generation) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => update((state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || hasExpired(entry.timeCreated, now)) return state
          // A late response from an expired sender must not overwrite an
          // operator retry or an uncertain outcome. Legacy callers may still
          // persist the sentinel values used by recovery tests.
          if (messageId >= 0 && entry.messageId !== 0 && entry.messageId !== DELIVERY_IN_FLIGHT_MESSAGE_ID) return state
          if (generation !== undefined && (entry.messageId !== DELIVERY_IN_FLIGHT_MESSAGE_ID || entry.deliveryGeneration !== generation)) return state
          const entries = new Map(state.entries).set(token, { ...entry, messageId, deliveryClaimedAt: undefined, deliveryGeneration: undefined })
          return { ...state, entries }
        })),
      ),
      getForMessage: (token, chatId, messageId) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined) return [Option.none(), clean]
          return [entry.chatId === chatId && entry.messageId === messageId ? Option.some(entry) : Option.none(), clean]
        })),
      ),
      claim: (token, chatId, messageId) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined) return [Option.none(), clean]
          if (entry.chatId !== chatId || entry.messageId !== messageId) {
            return [Option.none(), clean]
          }
          const generation = clean.nextClaim
          const entries = new Map(clean.entries).set(token, {
            ...entry,
            replyingSince: now,
            replyLeaseExpiresAt: now + REPLY_LEASE_MS,
            replyGeneration: generation,
          })
          return [Option.some({ entry, generation }), { ...clean, nextClaim: generation + 1, entries }]
        })),
      ),
      renewClaim: (token, generation) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const clean = cleanState(state, now)
        const entry = clean.entries.get(token)
        if (entry === undefined || entry.replyGeneration !== generation) return [false, clean]
        return [true, {
          ...clean,
          entries: new Map(clean.entries).set(token, { ...entry, replyLeaseExpiresAt: now + REPLY_LEASE_MS }),
        }]
      }))),
      restoreClaim: (token, claim) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const current = state.entries.get(token)
        if (current?.replyGeneration !== claim.generation || hasExpired(claim.entry.timeCreated, now)) return [false, state]
        const restored: PendingPermission = {
          ...claim.entry,
          // A force reconnect can move and re-surface this interaction while
          // the OpenCode reply is in flight. Restore the answer state without
          // replacing the newer Telegram destination with the claim snapshot.
          chatId: current.chatId,
          messageId: current.messageId,
          deliveryClaimedAt: current.deliveryClaimedAt,
          deliveryGeneration: current.deliveryGeneration,
        }
        return [true, { ...state, entries: new Map(state.entries).set(token, restored) }]
      }))),
      completeClaim: (token, generation) => modify((state) => {
        const current = state.entries.get(token)
        if (current?.replyGeneration !== generation) return [false, state]
        const entries = new Map(state.entries)
        entries.delete(token)
        return [true, { ...state, entries }]
      }),
      retryUncertainDelivery: (token, chatId) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || (entry.messageId !== DELIVERY_UNCERTAIN_MESSAGE_ID && entry.messageId !== DELIVERY_REJECTED_MESSAGE_ID)) return [false, state]
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageId: 0, deliveryGeneration: undefined, deliveryClaimedAt: undefined }) }]
      }),
      listUncertainDeliveries: (chatId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const clean = cleanState(state, now)
        const deliveries: Array<{ readonly token: number; readonly entry: PendingPermission; readonly failure: PromptDeliveryFailure }> = []
        for (const [token, entry] of clean.entries) {
          if (entry.chatId !== chatId) continue
          if (entry.messageId === DELIVERY_UNCERTAIN_MESSAGE_ID) deliveries.push({ token, entry, failure: "uncertain" })
          else if (entry.messageId === DELIVERY_REJECTED_MESSAGE_ID) deliveries.push({ token, entry, failure: "rejected" })
        }
        return [deliveries, clean]
      }))),
      remove: (token) => update((state) => {
        if (!state.entries.has(token)) return state
        const entries = new Map(state.entries)
        entries.delete(token)
        return { ...state, entries }
      }),
      take: (token) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const entry = state.entries.get(token)
          if (entry === undefined) return [Option.none(), state]
          if (hasExpired(entry.timeCreated, now)) {
            const entries = new Map(state.entries)
            entries.delete(token)
            return [Option.none(), { ...state, entries }]
          }
          const entries = new Map(state.entries)
          entries.delete(token)
          return [Option.some(entry), { ...state, entries }]
        })),
      ),
    }
  }),
)
