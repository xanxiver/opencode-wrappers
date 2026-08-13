import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { InteractionStore, InteractionStoreError } from "./interaction-store.js"
import { DELIVERY_IN_FLIGHT_MESSAGE_ID, DELIVERY_REJECTED_MESSAGE_ID, DELIVERY_UNCERTAIN_MESSAGE_ID, REPLY_LEASE_MS, type PromptDeliveryFailure } from "./permissions.js"
import type { SessionRoute } from "./permissions.js"

/** Pending question entries expire after this long (1 hour). */
export const QUESTION_TTL_MS = 60 * 60 * 1000

/** A pending question request from the agent, awaiting user answers. */
export interface PendingQuestion {
  readonly token: number
  readonly sessionID: string
  readonly requestID: string
  readonly chatId: number
  readonly questions: readonly string[]
  readonly options: ReadonlyArray<readonly string[]>
  readonly customs: readonly boolean[]
  /** True when the question allows multiple selections. */
  readonly multiples: readonly boolean[]
  /** Accumulated selections per question (multi-select). */
  readonly selections: ReadonlyArray<readonly string[]>
  /** One answer per question; undefined until answered. */
  readonly answers: ReadonlyArray<readonly string[] | undefined>
  /** Message id of the question message per question. */
  readonly messageIds: readonly number[]
  readonly timeCreated: number
  readonly replyingSince?: number
  readonly replyLeaseExpiresAt?: number
  readonly replyGeneration?: number
  readonly deliveryClaimedAt: readonly (number | undefined)[]
  readonly deliveryGenerations: readonly (number | undefined)[]
}

export interface QuestionReplyClaim {
  readonly entry: PendingQuestion
  readonly generation: number
}

export const hasExpired = (timeCreated: number, now: number, ttlMs: number = QUESTION_TTL_MS): boolean =>
  now - timeCreated > ttlMs

/** True when every question in the request has an answer. */
export const isComplete = (entry: PendingQuestion): boolean =>
  entry.answers.every((answer) => answer !== undefined)

export interface QuestionRegistryService {
  readonly purgeExpired: Effect.Effect<void, InteractionStoreError>
  /** Record the Telegram destination that owns questions for this session. */
  readonly setSessionRoute: (sessionID: string, route: SessionRoute) => Effect.Effect<void, InteractionStoreError>
  /** Keep the existing question route, or install the supplied route atomically. */
  readonly getOrSetSessionRoute: (sessionID: string, route: SessionRoute) => Effect.Effect<SessionRoute, InteractionStoreError>
  readonly getSessionRoute: (sessionID: string) => Effect.Effect<Option.Option<SessionRoute>, InteractionStoreError>
  /** Move unanswered prompts to a replacement session destination. */
  readonly rerouteSession: (sessionID: string, route: SessionRoute) => Effect.Effect<void, InteractionStoreError>
  readonly register: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
    readonly questions: readonly string[]
    readonly options: ReadonlyArray<readonly string[]>
    readonly customs: readonly boolean[]
    readonly multiples: readonly boolean[]
  }) => Effect.Effect<number, InteractionStoreError>
  /** Register only when the OpenCode request is not already surfaced. */
  readonly registerIfAbsent: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
    readonly questions: readonly string[]
    readonly options: ReadonlyArray<readonly string[]>
    readonly customs: readonly boolean[]
    readonly multiples: readonly boolean[]
  }) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  /** Register a request, or resume delivery of its missing Telegram messages. */
  readonly registerOrResume: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
    readonly questions: readonly string[]
    readonly options: ReadonlyArray<readonly string[]>
    readonly customs: readonly boolean[]
    readonly multiples: readonly boolean[]
  }) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  readonly claimDelivery: (token: number, questionIndex: number, chatId: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly claimDeliveryWithGeneration: (token: number, questionIndex: number, chatId: number) => Effect.Effect<Option.Option<number>, InteractionStoreError>
  readonly rejectDelivery: (token: number, questionIndex: number, chatId: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly rejectDeliveryWithGeneration: (token: number, questionIndex: number, chatId: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly attachMessageId: (token: number, questionIndex: number, messageId: number, generation?: number) =>
    Effect.Effect<void, InteractionStoreError>
  /** Find a pending request by its question message (does not remove it). */
  readonly findByMessage: (chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Find a pending request by its OpenCode identity. */
  readonly findByRequest: (chatId: number, sessionID: string, requestID: string) =>
    Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Read a pending request by token (does not remove it). */
  readonly get: (token: number) => Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Read a request only from its original Telegram question message. */
  readonly getForMessage: (token: number, questionIndex: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Toggle a selection for a multi-select question; returns the updated entry. */
  readonly toggleSelection: (token: number, questionIndex: number, label: string) =>
    Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Record an answer; returns the updated entry, or none when the token is gone. */
  readonly answer: (token: number, questionIndex: number, value: readonly string[]) =>
    Effect.Effect<Option.Option<PendingQuestion>, InteractionStoreError>
  /** Remove and return a complete request before crossing the OpenCode boundary. */
  readonly claimComplete: (token: number) => Effect.Effect<Option.Option<QuestionReplyClaim>, InteractionStoreError>
  readonly renewClaim: (token: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  readonly restoreClaim: (claim: QuestionReplyClaim) => Effect.Effect<boolean, InteractionStoreError>
  readonly completeClaim: (token: number, generation: number) => Effect.Effect<boolean, InteractionStoreError>
  /** Make an operator-reviewed ambiguous Telegram send eligible for retry. */
  readonly retryUncertainDelivery: (token: number, questionIndex: number, chatId: number, sessionID?: string) => Effect.Effect<boolean, InteractionStoreError>
  readonly listUncertainDeliveries: (chatId: number, sessionID?: string) => Effect.Effect<readonly { readonly token: number; readonly questionIndex: number; readonly entry: PendingQuestion; readonly failure: PromptDeliveryFailure }[], InteractionStoreError>
  readonly remove: (token: number) => Effect.Effect<void, InteractionStoreError>
}

export class QuestionRegistry extends Context.Service<QuestionRegistry, QuestionRegistryService>()(
  "opencode2-uis/QuestionRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly nextClaim: number
  readonly entries: ReadonlyMap<number, PendingQuestion>
  readonly routes: ReadonlyMap<string, SessionRoute>
}

const STORE_KEY = "questions"
const PersistedQuestionSchema = Schema.Struct({
  token: Schema.Number,
  sessionID: Schema.String,
  requestID: Schema.String,
  chatId: Schema.Number,
  questions: Schema.Array(Schema.String),
  options: Schema.Array(Schema.Array(Schema.String)),
  customs: Schema.Array(Schema.Boolean),
  multiples: Schema.Array(Schema.Boolean),
  selections: Schema.Array(Schema.Array(Schema.String)),
  answers: Schema.Array(Schema.Struct({ answered: Schema.Boolean, value: Schema.Array(Schema.String) })),
  messageIds: Schema.Array(Schema.Number),
  deliveryClaimedAt: Schema.optional(Schema.Array(Schema.Union([Schema.Number, Schema.Null, Schema.Undefined]))),
  deliveryGenerations: Schema.optional(Schema.Array(Schema.Union([Schema.Number, Schema.Null, Schema.Undefined]))),
  timeCreated: Schema.Number,
  replyingSince: Schema.optional(Schema.Number),
  replyLeaseExpiresAt: Schema.optional(Schema.Number),
  replyGeneration: Schema.optional(Schema.Number),
})
const SessionRouteSchema = Schema.Struct({ chatId: Schema.Number, threadId: Schema.optional(Schema.Number) })
const PersistedStateSchema = Schema.Struct({
  next: Schema.Number,
  nextClaim: Schema.optional(Schema.Number),
  entries: Schema.Array(PersistedQuestionSchema),
  routes: Schema.optional(Schema.Array(Schema.Struct({ sessionID: Schema.String, route: SessionRouteSchema }))),
})

const encodeState = (state: RegistryState) => ({
  next: state.next,
  nextClaim: state.nextClaim,
  entries: [...state.entries.values()].map((entry) => ({
    ...entry,
    answers: entry.answers.map((answer) => ({ answered: answer !== undefined, value: answer ?? [] })),
  })),
  routes: [...state.routes].map(([sessionID, route]) => ({ sessionID, route })),
})

const stateFromStored = (stored: Option.Option<unknown>): RegistryState => Option.match(stored, {
  onNone: () => ({ next: 1, nextClaim: 1, entries: new Map(), routes: new Map() }),
  onSome: (value) => {
    const decoded = Schema.decodeUnknownOption(PersistedStateSchema)(value)
    if (Option.isNone(decoded)) throw new InteractionStoreError({ operation: "decode question state", cause: value })
    const entries = new Map(decoded.value.entries.map((entry) => [entry.token, {
      ...entry,
      answers: entry.answers.map((answer) => answer.answered ? answer.value : undefined),
      deliveryClaimedAt: entry.deliveryClaimedAt?.map((value) => value ?? undefined) ?? entry.messageIds.map(() => undefined),
      deliveryGenerations: entry.deliveryGenerations?.map((value) => value ?? undefined) ?? entry.messageIds.map(() => undefined),
    }]))
    const routes = new Map((decoded.value.routes ?? []).map(({ sessionID, route }) => [sessionID, route]))
    // Older persisted question state has no route table. Recover a safe
    // chat-level route from the entry so pending questions remain visible
    // after restart; the topic cannot be recovered from the old format.
    for (const entry of entries.values()) {
      if (!routes.has(entry.sessionID)) routes.set(entry.sessionID, { chatId: entry.chatId })
    }
    return {
      next: decoded.value.next,
      nextClaim: decoded.value.nextClaim ?? 1,
      entries,
      routes,
    }
  },
})

export const Live: Layer.Layer<QuestionRegistry, InteractionStoreError, InteractionStore> = Layer.effect(
  QuestionRegistry,
  Effect.gen(function* () {
    const persistence = yield* InteractionStore
    yield* persistence.get(STORE_KEY).pipe(Effect.flatMap((stored) => Effect.try({
      try: () => stateFromStored(stored),
      catch: (cause) => cause instanceof InteractionStoreError ? cause : new InteractionStoreError({ operation: "decode question state", cause }),
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
        const stale = entry.messageIds.map((messageId, index) =>
          messageId === DELIVERY_IN_FLIGHT_MESSAGE_ID && (entry.deliveryClaimedAt[index] ?? 0) + REPLY_LEASE_MS <= now)
        if (stale.some(Boolean)) {
          changed = true
          entries.set(token, {
            ...entry,
            messageIds: entry.messageIds.map((messageId, index) => stale[index] ? DELIVERY_UNCERTAIN_MESSAGE_ID : messageId),
            deliveryClaimedAt: entry.deliveryClaimedAt.map((claimedAt, index) => stale[index] ? undefined : claimedAt),
            deliveryGenerations: entry.deliveryGenerations.map((generation, index) => stale[index] ? undefined : generation),
          })
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
      setSessionRoute: (sessionID, route) => update((state) => ({
        ...state,
        routes: new Map(state.routes).set(sessionID, route),
      })),
      getOrSetSessionRoute: (sessionID, route) => modify((state) => {
        const existing = state.routes.get(sessionID)
        if (existing !== undefined) return [existing, state]
        return [route, { ...state, routes: new Map(state.routes).set(sessionID, route) }]
      }),
      getSessionRoute: (sessionID) => modify((state) => [Option.fromNullishOr(state.routes.get(sessionID)), state]),
      rerouteSession: (sessionID, route) => update((state) => {
        const previous = state.routes.get(sessionID)
        if (previous?.chatId === route.chatId && previous.threadId === route.threadId) return state
        let changed = false
        const entries = new Map(state.entries)
        for (const [token, entry] of entries) {
          if (entry.sessionID !== sessionID) continue
          changed = true
          const rerouteClaimedReply = entry.replyingSince !== undefined
          const messageIds = entry.messageIds.map((messageId, index) => {
            if (entry.answers[index] !== undefined && !rerouteClaimedReply) return messageId
            if (messageId === DELIVERY_IN_FLIGHT_MESSAGE_ID) return DELIVERY_UNCERTAIN_MESSAGE_ID
            if (messageId === DELIVERY_REJECTED_MESSAGE_ID) return 0
            return messageId > 0 ? 0 : messageId
          })
          const selections = entry.selections.map((selection, index) =>
            messageIds[index] === 0 ? [] : selection)
          entries.set(token, {
            ...entry,
            chatId: route.chatId,
            messageIds,
            selections,
            deliveryClaimedAt: entry.deliveryClaimedAt.map(() => undefined),
            deliveryGenerations: entry.deliveryGenerations.map(() => undefined),
          })
        }
        return {
          ...state,
          entries: changed ? entries : state.entries,
          routes: new Map(state.routes).set(sessionID, route),
        }
      }),
      register: (input) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const token = clean.next
          const entry: PendingQuestion = {
            token,
            sessionID: input.sessionID,
            requestID: input.requestID,
            chatId: input.chatId,
            questions: input.questions,
            options: input.options,
            customs: input.customs,
            multiples: input.multiples,
            selections: input.questions.map(() => []),
            answers: input.questions.map(() => undefined),
            messageIds: input.questions.map(() => 0),
            deliveryClaimedAt: input.questions.map(() => undefined),
            deliveryGenerations: input.questions.map(() => undefined),
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
          const entry: PendingQuestion = {
            token, ...input, selections: input.questions.map(() => []), answers: input.questions.map(() => undefined), messageIds: input.questions.map(() => 0), deliveryClaimedAt: input.questions.map(() => undefined), deliveryGenerations: input.questions.map(() => undefined), timeCreated: now,
          }
          return [Option.some(token), { ...clean, next: token + 1, entries: new Map(clean.entries).set(token, entry) }]
        })),
      ),
      registerOrResume: (input) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          for (const entry of clean.entries.values()) {
            if (entry.chatId === input.chatId && entry.sessionID === input.sessionID && entry.requestID === input.requestID) {
              return [entry.messageIds.some((messageId) => messageId === 0) ? Option.some(entry.token) : Option.none(), clean]
            }
          }
          const token = clean.next
          const entry: PendingQuestion = {
            token, ...input, selections: input.questions.map(() => []), answers: input.questions.map(() => undefined), messageIds: input.questions.map(() => 0), deliveryClaimedAt: input.questions.map(() => undefined), deliveryGenerations: input.questions.map(() => undefined), timeCreated: now,
          }
          return [Option.some(token), { ...clean, next: token + 1, entries: new Map(clean.entries).set(token, entry) }]
        })),
      ),
      claimDeliveryWithGeneration: (token, questionIndex, chatId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const entry = state.entries.get(token)
        const generation = state.nextClaim
        if (entry === undefined || entry.chatId !== chatId || entry.messageIds[questionIndex] !== 0) return [Option.none(), state]
        const messageIds = [...entry.messageIds]
        messageIds[questionIndex] = DELIVERY_IN_FLIGHT_MESSAGE_ID
        const deliveryClaimedAt = [...entry.deliveryClaimedAt]
        deliveryClaimedAt[questionIndex] = now
        const deliveryGenerations = [...entry.deliveryGenerations]
        deliveryGenerations[questionIndex] = generation
        return [Option.some(generation), { ...state, nextClaim: generation + 1, entries: new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt, deliveryGenerations }) }]
      }))),
      claimDelivery: (token, questionIndex, chatId) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageIds[questionIndex] !== 0) return [false, state]
        const messageIds = [...entry.messageIds]
        messageIds[questionIndex] = DELIVERY_IN_FLIGHT_MESSAGE_ID
        const deliveryClaimedAt = [...entry.deliveryClaimedAt]
        deliveryClaimedAt[questionIndex] = now
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt }) }]
      }))),
      rejectDeliveryWithGeneration: (token, questionIndex, chatId, generation) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageIds[questionIndex] !== DELIVERY_IN_FLIGHT_MESSAGE_ID || entry.deliveryGenerations[questionIndex] !== generation) return [false, state]
        const messageIds = [...entry.messageIds]
        messageIds[questionIndex] = DELIVERY_REJECTED_MESSAGE_ID
        const deliveryClaimedAt = [...entry.deliveryClaimedAt]
        deliveryClaimedAt[questionIndex] = undefined
        const deliveryGenerations = [...entry.deliveryGenerations]
        deliveryGenerations[questionIndex] = undefined
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt, deliveryGenerations }) }]
      }),
      rejectDelivery: (token, questionIndex, chatId) => modify((state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageIds[questionIndex] !== DELIVERY_IN_FLIGHT_MESSAGE_ID) return [false, state]
        const messageIds = [...entry.messageIds]
        messageIds[questionIndex] = DELIVERY_REJECTED_MESSAGE_ID
        const deliveryClaimedAt = [...entry.deliveryClaimedAt]
        deliveryClaimedAt[questionIndex] = undefined
        const deliveryGenerations = [...entry.deliveryGenerations]
        deliveryGenerations[questionIndex] = undefined
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt, deliveryGenerations }) }]
      }),
      attachMessageId: (token, questionIndex, messageId, generation) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => update((state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || entry.messageIds[questionIndex] === undefined) return state
          if (hasExpired(entry.timeCreated, now)) return state
          if (messageId >= 0 && entry.messageIds[questionIndex] !== 0 && entry.messageIds[questionIndex] !== DELIVERY_IN_FLIGHT_MESSAGE_ID) return state
          if (generation !== undefined && (entry.messageIds[questionIndex] !== DELIVERY_IN_FLIGHT_MESSAGE_ID || entry.deliveryGenerations[questionIndex] !== generation)) return state
          const messageIds = [...entry.messageIds]
          messageIds[questionIndex] = messageId
          const deliveryClaimedAt = [...entry.deliveryClaimedAt]
          deliveryClaimedAt[questionIndex] = undefined
          const deliveryGenerations = [...entry.deliveryGenerations]
          deliveryGenerations[questionIndex] = undefined
          const entries = new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt, deliveryGenerations })
          return { ...state, entries }
        })),
      ),
      findByMessage: (chatId, messageId) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
            const clean = cleanState(state, now)
            for (const entry of clean.entries.values()) {
              if (entry.chatId === chatId && entry.messageIds.includes(messageId)) {
                return [Option.some(entry), clean]
              }
            }
            return [Option.none(), clean]
          })),
      ),
      findByRequest: (chatId, sessionID, requestID) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
            const clean = cleanState(state, now)
            for (const entry of clean.entries.values()) {
              if (entry.chatId === chatId && entry.sessionID === sessionID && entry.requestID === requestID) {
                return [Option.some(entry), clean]
              }
            }
            return [Option.none(), clean]
          })),
      ),
      get: (token) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
            const clean = cleanState(state, now)
            const entry = clean.entries.get(token)
            return [entry === undefined || entry.replyingSince !== undefined ? Option.none() : Option.some(entry), clean]
          })),
      ),
      getForMessage: (token, questionIndex, chatId, messageId) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined || entry.chatId !== chatId || entry.messageIds[questionIndex] !== messageId) return [Option.none(), clean]
          return [Option.some(entry), clean]
        })),
      ),
      toggleSelection: (token, questionIndex, label) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined) return [Option.none(), clean]
          if (questionIndex < 0 || questionIndex >= entry.selections.length) {
            return [Option.none(), clean]
          }
          const current = entry.selections[questionIndex]
          const selections = [...entry.selections]
          selections[questionIndex] = current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label]
          const updated = { ...entry, selections }
          const entries = new Map(clean.entries).set(token, updated)
          return [Option.some(updated), { ...clean, entries }]
        })),
      ),
      answer: (token, questionIndex, value) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined || questionIndex < 0 || questionIndex >= entry.answers.length) {
            return [Option.none(), clean]
          }
          const answers = [...entry.answers]
          answers[questionIndex] = value
          const updated = { ...entry, answers }
          const entries = new Map(clean.entries).set(token, updated)
          return [Option.some(updated), { ...clean, entries }]
        })),
      ),
      claimComplete: (token) => Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => modify((state) => {
          const clean = cleanState(state, now)
          const entry = clean.entries.get(token)
          if (entry === undefined || entry.replyingSince !== undefined || !isComplete(entry)) return [Option.none(), clean]
          const generation = clean.nextClaim
          const entries = new Map(clean.entries).set(token, {
            ...entry,
            replyingSince: now,
            replyLeaseExpiresAt: now + 2 * 60 * 1000,
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
          entries: new Map(clean.entries).set(token, { ...entry, replyLeaseExpiresAt: now + 2 * 60 * 1000 }),
        }]
      }))),
      restoreClaim: (claim) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const current = state.entries.get(claim.entry.token)
        if (current?.replyGeneration !== claim.generation || hasExpired(claim.entry.timeCreated, now)) return [false, state]
        const restored: PendingQuestion = {
          ...claim.entry,
          // Keep prompts created at a replacement route while restoring the
          // locally recorded answers after a rejected OpenCode reply.
          chatId: current.chatId,
          messageIds: current.messageIds,
          selections: current.selections,
          deliveryClaimedAt: current.deliveryClaimedAt,
          deliveryGenerations: current.deliveryGenerations,
        }
        return [true, { ...state, entries: new Map(state.entries).set(claim.entry.token, restored) }]
      }))),
      completeClaim: (token, generation) => modify((state) => {
        const current = state.entries.get(token)
        if (current?.replyGeneration !== generation) return [false, state]
        const entries = new Map(state.entries)
        entries.delete(token)
        return [true, { ...state, entries }]
      }),
      retryUncertainDelivery: (token, questionIndex, chatId, sessionID) => modify((state) => {
        const entry = state.entries.get(token)
        const messageId = entry?.messageIds[questionIndex]
        if (entry === undefined || entry.chatId !== chatId || (sessionID !== undefined && entry.sessionID !== sessionID) || (messageId !== DELIVERY_UNCERTAIN_MESSAGE_ID && messageId !== DELIVERY_REJECTED_MESSAGE_ID)) return [false, state]
        const messageIds = [...entry.messageIds]
        messageIds[questionIndex] = 0
        const deliveryClaimedAt = [...entry.deliveryClaimedAt]
        deliveryClaimedAt[questionIndex] = undefined
        const deliveryGenerations = [...entry.deliveryGenerations]
        deliveryGenerations[questionIndex] = undefined
        return [true, { ...state, entries: new Map(state.entries).set(token, { ...entry, messageIds, deliveryClaimedAt, deliveryGenerations }) }]
      }),
      listUncertainDeliveries: (chatId, sessionID) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => modify((state) => {
        const clean = cleanState(state, now)
        const deliveries: Array<{ readonly token: number; readonly questionIndex: number; readonly entry: PendingQuestion; readonly failure: PromptDeliveryFailure }> = []
        for (const entry of clean.entries.values()) {
          if (entry.chatId !== chatId || (sessionID !== undefined && entry.sessionID !== sessionID)) continue
          for (const [questionIndex, messageId] of entry.messageIds.entries()) {
            if (messageId === DELIVERY_UNCERTAIN_MESSAGE_ID) deliveries.push({ token: entry.token, questionIndex, entry, failure: "uncertain" })
            else if (messageId === DELIVERY_REJECTED_MESSAGE_ID) deliveries.push({ token: entry.token, questionIndex, entry, failure: "rejected" })
          }
        }
        return [deliveries, clean]
      }))),
      remove: (token) =>
        update((state) => {
          if (!state.entries.has(token)) return state
          const entries = new Map(state.entries)
          entries.delete(token)
          return { ...state, entries }
        }),
    }
  }),
)
