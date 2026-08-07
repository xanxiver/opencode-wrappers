import { Context, Effect, Layer, Option, Ref } from "effect"

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
}

export const hasExpired = (timeCreated: number, now: number, ttlMs: number = QUESTION_TTL_MS): boolean =>
  now - timeCreated > ttlMs

/** True when every question in the request has an answer. */
export const isComplete = (entry: PendingQuestion): boolean =>
  entry.answers.every((answer) => answer !== undefined)

export interface QuestionRegistryShape {
  readonly register: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly chatId: number
    readonly questions: readonly string[]
    readonly options: ReadonlyArray<readonly string[]>
    readonly customs: readonly boolean[]
    readonly multiples: readonly boolean[]
  }) => Effect.Effect<number, never>
  readonly attachMessageId: (token: number, questionIndex: number, messageId: number) =>
    Effect.Effect<void, never>
  /** Find a pending request by its question message (does not remove it). */
  readonly findByMessage: (chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PendingQuestion>, never>
  /** Read a pending request by token (does not remove it). */
  readonly get: (token: number) => Effect.Effect<Option.Option<PendingQuestion>, never>
  /** Read a request only from its original Telegram question message. */
  readonly getForMessage: (token: number, questionIndex: number, chatId: number, messageId: number) =>
    Effect.Effect<Option.Option<PendingQuestion>, never>
  /** Toggle a selection for a multi-select question; returns the updated entry. */
  readonly toggleSelection: (token: number, questionIndex: number, label: string) =>
    Effect.Effect<Option.Option<PendingQuestion>, never>
  /** Record an answer; returns the updated entry, or none when the token is gone. */
  readonly answer: (token: number, questionIndex: number, value: readonly string[]) =>
    Effect.Effect<Option.Option<PendingQuestion>, never>
  readonly remove: (token: number) => Effect.Effect<void, never>
}

export class QuestionRegistry extends Context.Service<QuestionRegistry, QuestionRegistryShape>()(
  "opencode2-uis/QuestionRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly entries: ReadonlyMap<number, PendingQuestion>
}

export const Live: Layer.Layer<QuestionRegistry> = Layer.effect(
  QuestionRegistry,
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
            timeCreated: now,
          }
          const entries = new Map(clean.entries).set(token, entry)
          return [token, { next: token + 1, entries }]
        }),
      attachMessageId: (token, questionIndex, messageId) =>
        Ref.update(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || entry.messageIds[questionIndex] === undefined) return state
          if (hasExpired(entry.timeCreated, Date.now())) return state
          const messageIds = [...entry.messageIds]
          messageIds[questionIndex] = messageId
          const entries = new Map(state.entries).set(token, { ...entry, messageIds })
          return { ...state, entries }
        }),
      findByMessage: (chatId, messageId) =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            for (const entry of state.entries.values()) {
              if (hasExpired(entry.timeCreated, Date.now())) continue
              if (entry.chatId === chatId && entry.messageIds.includes(messageId)) {
                return Option.some(entry)
              }
            }
            return Option.none()
          }),
        ),
      get: (token) =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            const entry = state.entries.get(token)
            if (entry === undefined || hasExpired(entry.timeCreated, Date.now())) return Option.none()
            return Option.some(entry)
          }),
        ),
      getForMessage: (token, questionIndex, chatId, messageId) =>
        Ref.get(ref).pipe(
          Effect.map((state) => {
            const entry = state.entries.get(token)
            if (entry === undefined || hasExpired(entry.timeCreated, Date.now())) return Option.none()
            if (entry.chatId !== chatId || entry.messageIds[questionIndex] !== messageId) return Option.none()
            return Option.some(entry)
          }),
        ),
      toggleSelection: (token, questionIndex, label) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || hasExpired(entry.timeCreated, Date.now())) {
            return [Option.none(), state]
          }
          if (questionIndex < 0 || questionIndex >= entry.selections.length) {
            return [Option.none(), state]
          }
          const current = entry.selections[questionIndex]
          const selections = [...entry.selections]
          selections[questionIndex] = current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label]
          const updated = { ...entry, selections }
          const entries = new Map(state.entries).set(token, updated)
          return [Option.some(updated), { ...state, entries }]
        }),
      answer: (token, questionIndex, value) =>
        Ref.modify(ref, (state) => {
          const entry = state.entries.get(token)
          if (entry === undefined || questionIndex < 0 || questionIndex >= entry.answers.length) {
            return [Option.none(), state]
          }
          if (hasExpired(entry.timeCreated, Date.now())) {
            return [Option.none(), state]
          }
          const answers = [...entry.answers]
          answers[questionIndex] = value
          const updated = { ...entry, answers }
          const entries = new Map(state.entries).set(token, updated)
          return [Option.some(updated), { ...state, entries }]
        }),
      remove: (token) =>
        Ref.update(ref, (state) => {
          if (!state.entries.has(token)) return state
          const entries = new Map(state.entries)
          entries.delete(token)
          return { ...state, entries }
        }),
    }
  }),
)
