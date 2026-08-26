import { Cause, Clock, Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, Queue, Ref, Schema, Semaphore } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Stream } from "effect"
import { AppConfigTag, ConfigError } from "../config.js"
import type { AppConfig } from "../config.js"

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly operation: string
  readonly code?: number
  readonly description?: string
  readonly cause?: unknown
  /** Telegram asked us to wait this many milliseconds before repeating (429). */
  readonly retryAfterMs?: number
  /** True when the failure is transient (network, 429, 5xx) and worth retrying. */
  readonly transient: boolean
}> {}

/** Status codes that are safe to retry with backoff. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

/** A Telegram 4xx response proves that the requested message was not accepted. */
export const isDefinitiveSendRejection = (error: Pick<ApiError, "code" | "transient">): boolean =>
  error.code !== undefined && error.code >= 400 && error.code < 500 && !error.transient

/** Record a durable rejected-send fence only when Telegram proves rejection. */
export const recordDefinitiveSendFailure = <A, E, R, R2>(
  send: Effect.Effect<A, ApiError, R>,
  reject: Effect.Effect<boolean, E, R2>,
): Effect.Effect<A, ApiError | E, R | R2> => send.pipe(Effect.catchTag("ApiError", (error) =>
  isDefinitiveSendRejection(error)
    ? reject.pipe(Effect.andThen(Effect.fail(error)))
    : Effect.fail(error)))

/** Minimum interval between message edits for the same chat (ms). */
export const EDIT_MIN_INTERVAL_MS = 1000

/**
 * Telegram caps group traffic near 20 messages per minute. Streaming runs
 * share that budget with replies, questions, notifications, and button
 * feedback, so group chats start from a thrifty 6s interval and let flood
 * feedback widen or tighten it around the real budget.
 */
export const EDIT_MIN_INTERVAL_GROUP_MS = 6000

/** Upper bound for the adaptive per-chat edit interval. */
export const EDIT_MAX_INTERVAL_MS = 20_000

export const editBaseInterval = (chatId: number): number =>
  chatId < 0 ? EDIT_MIN_INTERVAL_GROUP_MS : EDIT_MIN_INTERVAL_MS

/**
 * After a 429, widen the chat's edit interval: take the larger of the
 * current width doubled and Telegram's requested wait, capped at the max.
 */
export const penalizeEditInterval = (
  baseMs: number,
  currentMs: number,
  retryAfterMs: number | undefined,
): number => Math.min(EDIT_MAX_INTERVAL_MS, Math.max(currentMs * 2, retryAfterMs ?? 500, baseMs))

/** After a clean edit, relax the interval halfway back toward the base. */
export const relaxEditInterval = (baseMs: number, currentMs: number): number =>
  Math.max(baseMs, Math.floor(currentMs / 2))

/**
 * Milliseconds to wait before the next edit for a chat running at the given
 * interval, given the last edit time.
 */
export const editDelayFor = (lastEditAt: number, now: number, intervalMs: number): number =>
  lastEditAt === 0 ? 0 : Math.max(0, intervalMs - (now - lastEditAt))

export const editDelay = (chatId: number, lastEditAt: number, now: number): number =>
  editDelayFor(lastEditAt, now, editBaseInterval(chatId))

export interface EditThrottleState {
  readonly lastEditAt: number
  /** Do not send another edit before this Telegram flood-limit boundary. */
  readonly quietUntil: number
  readonly intervalMs: number
}

/**
 * Compute the remaining delay while a caller owns the chat's edit permit.
 * The function does not reserve future state, so interruption cannot leave an
 * unused slot that delays later edits.
 */
export const editThrottleDelay = (
  current: EditThrottleState | undefined,
  now: number,
  baseMs: number,
): number => {
  const intervalMs = current?.intervalMs ?? baseMs
  const lastEditAt = current?.lastEditAt ?? 0
  const afterLastEdit = lastEditAt === 0 ? now : lastEditAt + intervalMs
  return Math.max(0, Math.max(current?.quietUntil ?? 0, afterLastEdit) - now)
}

const RETRY_MAX_ATTEMPTS = 5
const RETRY_CAP_MS = 30_000
const backoffDelay = (attempt: number): number =>
  Math.min(RETRY_CAP_MS, Math.min(RETRY_CAP_MS, 500 * 2 ** Math.min(attempt, 6)))

interface RetryDetails {
  readonly attempt: number
  readonly waitMs: number
}

type RetryObserver = (error: ApiError, details: RetryDetails) => Effect.Effect<void>

const logRetry = (error: ApiError, details: RetryDetails): Effect.Effect<void> =>
  Effect.annotateLogs({
    component: "telegram/api",
    boundary: "telegram-bot-api-retry",
    operation: error.operation,
    code: error.code,
    retry: details.attempt,
    waitMs: details.waitMs,
    retryAfterMs: error.retryAfterMs,
  })(Effect.logWarning("telegram request will retry"))

/**
 * Retry failures matching shouldRetry, honoring Telegram's retry_after hint
 * when the error carries one (429 responses include it in seconds). Without
 * this the fixed exponential schedule hammers Telegram during a flood window
 * and the request fails after burning all attempts.
 */
const retryErrors = <A, R>(
  attempt: number,
  run: Effect.Effect<A, ApiError, R>,
  shouldRetry: (error: ApiError) => boolean,
  onRetry: RetryObserver = () => Effect.void,
): Effect.Effect<A, ApiError, R> =>
  run.pipe(
    Effect.catchTag("ApiError", (error) => {
      if (!shouldRetry(error) || attempt >= RETRY_MAX_ATTEMPTS) return Effect.fail(error)
      const wait = Math.min(RETRY_CAP_MS, error.retryAfterMs ?? backoffDelay(attempt))
      const details = { attempt: attempt + 1, waitMs: wait }
      return logRetry(error, details).pipe(
        Effect.andThen(onRetry(error, details)),
        Effect.andThen(Effect.sleep(Duration.millis(wait))),
        Effect.andThen(retryErrors(attempt + 1, run, shouldRetry, onRetry)),
      )
    }),
  )

const retryTransient = <A, R>(
  attempt: number,
  run: Effect.Effect<A, ApiError, R>,
  onRetry?: RetryObserver,
): Effect.Effect<A, ApiError, R> =>
  retryErrors(attempt, run, (error) => error.transient, onRetry)

export interface KeyboardButton {
  readonly text: string
  readonly callback_data: string
}

export interface KeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<KeyboardButton>>
}

export interface TelegramMediaInput {
  readonly chatId: number
  readonly bytes: Uint8Array
  readonly name: string
  readonly mime: string
  readonly caption?: string
  readonly messageThreadId?: number
  readonly replyToMessageId?: number
  /** Disable transport retries when a repeated upload could duplicate delivery. */
  readonly retryTransient?: boolean
}

const ChatSchema = Schema.Struct({ id: Schema.Number })

const PhotoSizeSchema = Schema.Struct({
  file_id: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  file_size: Schema.optional(Schema.Number),
})

const DocumentSchema = Schema.Struct({
  file_id: Schema.String,
  file_name: Schema.optional(Schema.String),
  mime_type: Schema.optional(Schema.String),
  file_size: Schema.optional(Schema.Number),
})

const MessageContentSchema = Schema.Struct({
  message_id: Schema.Number,
  chat: ChatSchema,
  from: Schema.optional(Schema.Struct({ id: Schema.Number })),
  message_thread_id: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  document: Schema.optional(DocumentSchema),
  photo: Schema.optional(Schema.Array(PhotoSizeSchema)),
})

export const MessageSchema = Schema.Struct({
  ...MessageContentSchema.fields,
  reply_to_message: Schema.optional(MessageContentSchema),
})

const CallbackQuerySchema = Schema.Struct({
  id: Schema.String,
  from: Schema.Struct({ id: Schema.Number }),
  message: Schema.optional(MessageSchema),
  data: Schema.optional(Schema.String),
})

const UpdateSchema = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(MessageSchema),
  callback_query: Schema.optional(CallbackQuerySchema),
})

const FileInfoSchema = Schema.Struct({
  file_id: Schema.String,
  file_unique_id: Schema.optional(Schema.String),
  file_size: Schema.optional(Schema.Number),
  file_path: Schema.optional(Schema.String),
})

export type Message = Schema.Schema.Type<typeof MessageSchema>
export type Update = Schema.Schema.Type<typeof UpdateSchema>
export type CallbackQuery = Schema.Schema.Type<typeof CallbackQuerySchema>
export type Document = Schema.Schema.Type<typeof DocumentSchema>
export type PhotoSize = Schema.Schema.Type<typeof PhotoSizeSchema>
export type FileInfo = Schema.Schema.Type<typeof FileInfoSchema>

export type TelegramEditPriority = "interactive" | "final" | "progress"
export type TelegramEditDelivery = "wait" | "background"

export interface EditMessageTextInput {
  readonly chatId: number
  readonly messageId: number
  readonly text: string
  readonly replyMarkup?: KeyboardMarkup
  /** Interactive and final edits run before queued streaming progress edits. */
  readonly priority?: TelegramEditPriority
  /** Background delivery returns after durable in-memory enqueueing. */
  readonly delivery?: TelegramEditDelivery
}

interface ScheduledEdit {
  readonly id: number
  readonly input: EditMessageTextInput
  readonly queuedAt: number
  readonly completion?: Deferred.Deferred<Message, ApiError>
  readonly cancellation?: Deferred.Deferred<void>
}

interface ScheduledEditState {
  readonly nextId: number
  readonly urgent: readonly ScheduledEdit[]
  readonly progress: readonly ScheduledEdit[]
}

interface ChatEditScheduler {
  readonly pending: Ref.Ref<ScheduledEditState>
  readonly wake: Queue.Queue<void>
}

const emptyScheduledEditState = (): ScheduledEditState => ({
  nextId: 1,
  urgent: [],
  progress: [],
})

const scheduledEditCount = (state: ScheduledEditState): number => state.urgent.length + state.progress.length

const appendScheduledEdit = (
  state: ScheduledEditState,
  request: ScheduledEdit,
): ScheduledEditState => request.input.priority === "progress"
  ? { ...state, nextId: request.id + 1, progress: [...state.progress, request] }
  : { ...state, nextId: request.id + 1, urgent: [...state.urgent, request] }

const takeScheduledEdit = (state: ScheduledEditState): readonly [Option.Option<ScheduledEdit>, ScheduledEditState] => {
  const urgent = state.urgent[0]
  if (urgent !== undefined) return [Option.some(urgent), { ...state, urgent: state.urgent.slice(1) }]
  const progress = state.progress[0]
  if (progress !== undefined) return [Option.some(progress), { ...state, progress: state.progress.slice(1) }]
  return [Option.none(), state]
}

const removeScheduledEdit = (
  state: ScheduledEditState,
  id: number,
): readonly [boolean, ScheduledEditState] => {
  const urgent = state.urgent.filter((request) => request.id !== id)
  const progress = state.progress.filter((request) => request.id !== id)
  const removed = urgent.length !== state.urgent.length || progress.length !== state.progress.length
  return [removed, removed ? { ...state, urgent, progress } : state]
}

const envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
  parameters: Schema.optional(Schema.Struct({
    retry_after: Schema.optional(Schema.Number),
  })),
})
type JsonValue = ReturnType<typeof JSON.parse>

export interface TelegramApiClient {
  readonly getUpdates: (offset: number, timeoutSeconds: number) =>
    Effect.Effect<readonly Update[], ApiError, HttpClient.HttpClient>
  readonly sendMessage: (input: {
    readonly chatId: number
    readonly text: string
    readonly replyMarkup?: KeyboardMarkup
    /** Forum topic thread id; replies into that thread when provided. */
    readonly messageThreadId?: number
    /** Reply to another Telegram message when provided. */
    readonly replyToMessageId?: number
  }) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
  readonly sendPhoto: (input: TelegramMediaInput) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
  readonly sendVideo: (input: TelegramMediaInput) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
  readonly sendDocument: (input: TelegramMediaInput) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
  readonly editMessageText: (input: EditMessageTextInput) =>
    Effect.Effect<Message | undefined, ApiError, HttpClient.HttpClient>
  readonly answerCallbackQuery: (input: {
    readonly queryId: string
    readonly text: string
  }) => Effect.Effect<boolean, ApiError, HttpClient.HttpClient>
  readonly getFile: (fileId: string) => Effect.Effect<FileInfo, ApiError, HttpClient.HttpClient>
  readonly downloadFile: (filePath: string) => Effect.Effect<Uint8Array<ArrayBufferLike>, ApiError, HttpClient.HttpClient>
}

export class TelegramApi extends Context.Service<TelegramApi, TelegramApiClient>()(
  "opencode2-uis/TelegramApi",
) {}

type SensitiveRedactor = (text: string) => string

/** Remove transport details that can carry the bot token before an ApiError leaves this module. */
const sanitizedApiError = (redact: SensitiveRedactor, error: ApiError): ApiError => new ApiError({
  operation: error.operation,
  code: error.code,
  description: error.description === undefined ? undefined : redact(error.description),
  cause: error.cause === undefined ? undefined : redact(Cause.pretty(Cause.fail(error.cause))),
  retryAfterMs: error.retryAfterMs,
  transient: error.transient,
})

const logRedactedBoundary = (redact: SensitiveRedactor, operation: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.annotateLogs({ component: "telegram/api", boundary: "telegram-bot-api" })(
    Effect.logError(`telegram ${operation} failed`, redact(Cause.pretty(cause))),
  )

export const decodeTelegramResponse = <A>(
  operation: string,
  schema: Schema.ConstraintCodec<A>,
  text: string,
): Effect.Effect<A, ApiError> => Effect.gen(function* () {
  const body = yield* Effect.try({
    try: (): JsonValue => JSON.parse(text),
    catch: (cause) => new ApiError({ operation, cause, transient: false }),
  }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(envelope)(json)),
    Effect.mapError((cause) => cause instanceof ApiError
      ? cause
      : new ApiError({ operation, cause, transient: false })),
  )
  if (!body.ok) {
    return yield* new ApiError({
      operation,
      code: body.error_code,
      description: body.description,
      transient: body.error_code !== undefined && isTransientStatus(body.error_code),
    })
  }
  return yield* Option.match(Option.fromNullishOr(body.result), {
    onNone: () => Effect.fail(new ApiError({ operation, description: "response has no result", transient: false })),
    onSome: (result) => Schema.decodeUnknownEffect(schema)(result).pipe(
      Effect.mapError((cause) => new ApiError({ operation, cause, transient: false })),
    ),
  })
})

/** Preserve Telegram's structured error details even when HTTP is non-2xx. */
export const decodeTelegramErrorResponse = (
  operation: string,
  status: number,
  text: string,
): ApiError => {
  const parsed = Effect.runSync(Effect.try({
    try: (): JsonValue => JSON.parse(text),
    catch: () => undefined,
  }))
  const decoded = Schema.decodeUnknownOption(envelope)(parsed)
  const code = Option.isSome(decoded) ? (decoded.value.error_code ?? status) : status
  const retryAfterRaw = Option.isSome(decoded) ? decoded.value.parameters?.retry_after : undefined
  const retryAfterMs = retryAfterRaw === undefined ? undefined : retryAfterRaw * 1000
  const details: { readonly description?: string } =
    Option.isSome(decoded) && decoded.value.description !== undefined
      ? { description: decoded.value.description }
      : {}
  return new ApiError({
    operation,
    code,
    ...details,
    retryAfterMs,
    transient: isTransientStatus(code),
  })
}

/**
 * Execute a request with backoff retry for transient failures.
 * Network errors and transient statuses retry; decode and business errors do not.
 */
const call = <A>(
  operation: string,
  schema: Schema.ConstraintCodec<A>,
  redact: SensitiveRedactor,
  options?: {
    readonly retryTransient?: boolean
    readonly onRetry?: RetryObserver
  },
) =>
  (request: HttpClientRequest.HttpClientRequest): Effect.Effect<A, ApiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const requestEffect = HttpClient.execute(request).pipe(
        Effect.mapError((cause) => new ApiError({ operation, cause, transient: true })),
        Effect.flatMap((response) => HttpClientResponse.stream(Effect.succeed(response)).pipe(
          Stream.runCollect,
          Effect.map(concatBytes),
          Effect.map((bytes) => new TextDecoder().decode(bytes)),
          Effect.mapError((cause) => new ApiError({ operation, cause, transient: true })),
          Effect.flatMap((text) => response.status >= 200 && response.status < 300
            ? decodeTelegramResponse(operation, schema, text)
            : Effect.fail(decodeTelegramErrorResponse(operation, response.status, text))),
        )),
      )
      return yield* options?.retryTransient === false
        ? requestEffect
        : retryTransient(0, requestEffect, options?.onRetry)
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Option.match(Cause.findErrorOption(cause), {
              onNone: () =>
                logRedactedBoundary(redact, operation)(cause).pipe(
                  Effect.andThen(Effect.fail(new ApiError({ operation, transient: false }))),
                ),
              onSome: (error) => {
                const safeError = sanitizedApiError(redact, error)
                const meta = {
                  component: "telegram/api",
                  boundary: "telegram-bot-api",
                  operation,
                  code: safeError.code,
                  description: safeError.description,
                  transient: safeError.transient,
                  retryAfterMs: safeError.retryAfterMs,
                }
                return Effect.annotateLogs(meta)(
                  Effect.logWarning(`telegram ${operation} failed`),
                ).pipe(Effect.andThen(Effect.fail(safeError)))
              },
            }),
      ),
    )

const jsonBody = <A>(operation: string, value: A) =>
  HttpBody.json(value).pipe(Effect.mapError((cause) => new ApiError({ operation, cause, transient: false })))

const mediaRequest = (
  base: string,
  operation: "sendPhoto" | "sendVideo" | "sendDocument",
  field: "photo" | "video" | "document",
  input: TelegramMediaInput,
) => {
  const bytes = new Uint8Array(input.bytes.byteLength)
  bytes.set(input.bytes)
  const file = new File([bytes.buffer], input.name, { type: input.mime })
  return HttpClientRequest.post(`${base}/${operation}`).pipe(
    HttpClientRequest.bodyFormDataRecord({
      chat_id: input.chatId,
      [field]: file,
      caption: input.caption,
      message_thread_id: input.messageThreadId,
      reply_parameters: input.replyToMessageId === undefined
        ? undefined
        : JSON.stringify({ message_id: input.replyToMessageId }),
    }),
  )
}

const concatBytes = (chunks: readonly Uint8Array<ArrayBufferLike>[]): Uint8Array => {
  const parts = Array.from(chunks)
  const total = parts.reduce((acc, part) => acc + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export const Live: Layer.Layer<TelegramApi, ConfigError, AppConfig | HttpClient.HttpClient> = Layer.effect(
  TelegramApi,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const httpClient = yield* HttpClient.HttpClient
    const schedulerScope = yield* Effect.scope
    const token = config.telegramBotToken
    if (token === undefined) return yield* new ConfigError({ message: "TELEGRAM_BOT_TOKEN is required by the Telegram API" })
    // Transport failures can echo the request URL, which contains the token.
    // Keep the redactor local to this client so concurrent layers cannot swap
    // credentials or sanitize each other's failures with the wrong token.
    const redact = (text: string): string => text.split(token).join("***")
    const base = `https://api.telegram.org/bot${token}`
    const fileBase = `https://api.telegram.org/file/bot${token}`
    // Adaptive per-chat edit throttle. The interval starts at the chat-type
    // base (DM 1s, group 6s), doubles on every 429 (respecting Telegram's
    // retry_after) and relaxes halfway after each operation with no 429.
    const editThrottle = yield* Ref.make<ReadonlyMap<number, EditThrottleState>>(new Map())
    const editSlotDelay = (chatId: number): Effect.Effect<number, never> => Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Ref.get(editThrottle).pipe(
        Effect.map((map) => editThrottleDelay(map.get(chatId), now, editBaseInterval(chatId))),
      )),
    )
    /** Record an accepted edit. Only a request with no 429 relaxes the interval. */
    const noteSuccessfulEdit = (chatId: number, clean: boolean): Effect.Effect<void> => Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Ref.update(editThrottle, (map) => {
        const base = editBaseInterval(chatId)
        const current = map.get(chatId)
        const previous = current?.intervalMs ?? base
        return new Map(map).set(chatId, {
          lastEditAt: now,
          quietUntil: current?.quietUntil ?? 0,
          intervalMs: clean ? relaxEditInterval(base, previous) : previous,
        })
      })),
    )
    /** Widen the interval and hold the chat quiet for Telegram's wait. */
    const penalizeFlood = (chatId: number, retryAfterMs: number | undefined): Effect.Effect<void> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.update(editThrottle, (map) => {
          const base = editBaseInterval(chatId)
          const current = map.get(chatId)
          const intervalMs = penalizeEditInterval(base, current?.intervalMs ?? base, retryAfterMs)
          const requestedWait = Math.min(RETRY_CAP_MS, retryAfterMs ?? 0)
          const quietUntil = now + Math.max(requestedWait, intervalMs)
          return new Map(map).set(chatId, {
            lastEditAt: current?.lastEditAt ?? 0,
            quietUntil: Math.max(current?.quietUntil ?? 0, quietUntil),
            intervalMs,
          })
        })),
      )
    const sendMedia = (
      operation: "sendPhoto" | "sendVideo" | "sendDocument",
      field: "photo" | "video" | "document",
      input: TelegramMediaInput,
    ): Effect.Effect<Message, ApiError, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        return yield* call(operation, MessageSchema, redact, { retryTransient: input.retryTransient })(
          mediaRequest(base, operation, field, input),
        )
      })
    // One worker per chat preserves Telegram's chat-wide flood budget. Workers
    // pick urgent interaction/final edits before progress only after the
    // throttle wait, so a button pressed during that wait can move ahead.
    // Different chats may still issue up to 16 edit requests in parallel.
    const editRequestPermits = yield* Semaphore.make(16)
    const performEdit = (input: EditMessageTextInput): Effect.Effect<Message, ApiError, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const sawFlood = yield* Ref.make(false)
        const result = yield* jsonBody("editMessageText", {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: input.text,
          reply_markup: input.replyMarkup,
        }).pipe(
          Effect.flatMap((body) =>
            call("editMessageText", MessageSchema, redact, {
              // Streaming progress is lossy. A failed progress edit is
              // superseded by the latest run state instead of blocking urgent
              // feedback through a long transport or flood retry sequence.
              retryTransient: input.priority !== "progress",
              onRetry: (error) => error.code === 429
                ? Ref.set(sawFlood, true).pipe(
                    Effect.andThen(penalizeFlood(input.chatId, error.retryAfterMs)),
                  )
                : Effect.void,
            })(
              HttpClientRequest.post(`${base}/editMessageText`).pipe(HttpClientRequest.setBody(body)),
            )
          ),
          Effect.catchTag("ApiError", (error) =>
            error.code === 429
              ? Ref.set(sawFlood, true).pipe(
                  Effect.andThen(penalizeFlood(input.chatId, error.retryAfterMs)),
                  Effect.andThen(Effect.fail(error)),
                )
              : Effect.fail(error)),
        )
        yield* noteSuccessfulEdit(input.chatId, !(yield* Ref.get(sawFlood)))
        return result
      })
    const logEditScheduler = (
      request: ScheduledEdit,
      stage: string,
      details: Readonly<Record<string, string | number | boolean | undefined>> = {},
      warning = false,
    ): Effect.Effect<void> => {
      const priority = request.input.priority ?? "interactive"
      const message = "telegram edit scheduler event"
      let event = Effect.logInfo(message)
      if (priority === "progress") event = Effect.logDebug(message)
      if (warning) event = Effect.logWarning(message)
      return Effect.annotateLogs({
        component: "telegram/api",
        boundary: "telegram-edit-scheduler",
        stage,
        chatId: request.input.chatId,
        messageId: request.input.messageId,
        priority,
        delivery: request.input.delivery ?? "wait",
        ...details,
      })(event)
    }
    const runEditWorker = (chatId: number, scheduler: ChatEditScheduler): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(scheduler.wake)
          while (scheduledEditCount(yield* Ref.get(scheduler.pending)) > 0) {
            let throttleWaitMs = 0
            while (true) {
              const delay = yield* editSlotDelay(chatId)
              if (delay <= 0) break
              throttleWaitMs += delay
              yield* Effect.sleep(Duration.millis(delay))
            }
            const processed = yield* editRequestPermits.withPermit(Effect.gen(function* () {
              // Select only after global capacity is available. An urgent edit
              // that arrives while this chat waits for a permit can still
              // overtake progress that was queued first.
              const next = yield* Ref.modify(scheduler.pending, (state) => {
                const [request, remaining] = takeScheduledEdit(state)
                return [{ request, queueDepth: scheduledEditCount(remaining) }, remaining]
              })
              if (Option.isNone(next.request)) return false
              const request = next.request.value
              const startedAt = yield* Clock.currentTimeMillis
              yield* logEditScheduler(request, "started", {
                queueDepth: next.queueDepth,
                queuedMs: Math.max(0, startedAt - request.queuedAt),
                throttleWaitMs,
              })
              const edit = performEdit(request.input).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
              )
              const cancellable = request.cancellation === undefined
                ? edit
                : Effect.raceFirst(
                    edit,
                    Deferred.await(request.cancellation).pipe(Effect.andThen(Effect.interrupt)),
                  )
              const exit = yield* Effect.exit(cancellable)
              const completedAt = yield* Clock.currentTimeMillis
              const cancelled = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              if (cancelled) {
                yield* logEditScheduler(request, "cancelled", {
                  durationMs: Math.max(0, completedAt - startedAt),
                })
              } else {
                const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none<ApiError>()
                yield* logEditScheduler(request, "completed", {
                  durationMs: Math.max(0, completedAt - startedAt),
                  success: Exit.isSuccess(exit),
                  code: Option.isSome(error) ? error.value.code : undefined,
                }, Exit.isFailure(exit))
              }
              if (request.completion !== undefined) yield* Deferred.done(request.completion, exit)
              return true
            }))
            if (!processed) continue
          }
        }
      })
    const schedulerLock = yield* Semaphore.make(1)
    const schedulers = yield* Ref.make<ReadonlyMap<number, ChatEditScheduler>>(new Map())
    const schedulerFor = (chatId: number): Effect.Effect<ChatEditScheduler> => schedulerLock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(schedulers)
        const existing = current.get(chatId)
        if (existing !== undefined) return existing
        const pending = yield* Ref.make(emptyScheduledEditState())
        const wake = yield* Queue.dropping<void>(1)
        const scheduler: ChatEditScheduler = { pending, wake }
        yield* Ref.update(schedulers, (values) => new Map(values).set(chatId, scheduler))
        yield* Effect.forkIn(runEditWorker(chatId, scheduler), schedulerScope)
        return scheduler
      }),
    )
    const scheduleEdit = (input: EditMessageTextInput): Effect.Effect<Message | undefined, ApiError> =>
      Effect.gen(function* () {
        const normalized: EditMessageTextInput = {
          ...input,
          priority: input.priority ?? "interactive",
          delivery: input.delivery ?? "wait",
        }
        const scheduler = yield* schedulerFor(normalized.chatId)
        const queuedAt = yield* Clock.currentTimeMillis
        const completion = normalized.delivery === "background"
          ? undefined
          : yield* Deferred.make<Message, ApiError>()
        const cancellation = normalized.delivery === "background"
          ? undefined
          : yield* Deferred.make<void>()
        const queued = yield* Ref.modify(scheduler.pending, (state) => {
          const request: ScheduledEdit = completion === undefined || cancellation === undefined
            ? { id: state.nextId, input: normalized, queuedAt }
            : { id: state.nextId, input: normalized, queuedAt, completion, cancellation }
          const next = appendScheduledEdit(state, request)
          return [{ request, queueDepth: scheduledEditCount(next) }, next]
        })
        yield* logEditScheduler(queued.request, "queued", { queueDepth: queued.queueDepth })
        yield* Queue.offer(scheduler.wake, undefined)
        if (completion === undefined || cancellation === undefined) return undefined
        return yield* Deferred.await(completion).pipe(
          Effect.onInterrupt(() => Ref.modify(scheduler.pending, (state) => removeScheduledEdit(state, queued.request.id)).pipe(
            Effect.flatMap((removed) => Deferred.succeed(cancellation, undefined).pipe(
              Effect.andThen(logEditScheduler(queued.request, "cancellation-requested", {
                location: removed ? "queued" : "selected",
              })),
            )),
          )),
        )
      })
    return {
      getUpdates: (offset, timeoutSeconds) =>
        call("getUpdates", Schema.Array(UpdateSchema), redact)(
          HttpClientRequest.get(`${base}/getUpdates`).pipe(
            HttpClientRequest.setUrlParams({ offset, timeout: timeoutSeconds }),
          ),
        ),
      sendMessage: (input) =>
        Effect.gen(function* () {
          const body = yield* jsonBody("sendMessage", {
            chat_id: input.chatId,
            text: input.text,
            reply_markup: input.replyMarkup,
            message_thread_id: input.messageThreadId,
            reply_parameters: input.replyToMessageId === undefined
              ? undefined
              : { message_id: input.replyToMessageId },
          })
          // A 429 proves Telegram did not create the message, so a bounded
          // retry cannot duplicate it. Transport retries stay disabled
          // because an ambiguous network failure may have been delivered.
          // Each 429 also widens this chat's edit throttle.
          const request = call("sendMessage", MessageSchema, redact, { retryTransient: false })(
            HttpClientRequest.post(`${base}/sendMessage`).pipe(HttpClientRequest.setBody(body)),
          ).pipe(
            Effect.catchTag("ApiError", (error) =>
              error.code === 429
                ? penalizeFlood(input.chatId, error.retryAfterMs).pipe(
                    Effect.andThen(Effect.fail(error)),
                  )
                : Effect.fail(error)),
          )
          return yield* retryErrors(0, request, (error) => error.code === 429)
        }),
      sendPhoto: (input) => sendMedia("sendPhoto", "photo", input),
      sendVideo: (input) => sendMedia("sendVideo", "video", input),
      sendDocument: (input) => sendMedia("sendDocument", "document", input),
      editMessageText: scheduleEdit,
      answerCallbackQuery: (input) =>
        Effect.gen(function* () {
          const body = yield* jsonBody("answerCallbackQuery", {
            callback_query_id: input.queryId,
            text: input.text,
          })
          return yield* call("answerCallbackQuery", Schema.Boolean, redact, { retryTransient: false })(
            HttpClientRequest.post(`${base}/answerCallbackQuery`).pipe(HttpClientRequest.setBody(body)),
          )
        }),
      getFile: (fileId) =>
        call("getFile", FileInfoSchema, redact)(
          HttpClientRequest.get(`${base}/getFile`).pipe(
            HttpClientRequest.setUrlParams({ file_id: fileId }),
          ),
        ),
      downloadFile: (filePath) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.execute(
            HttpClientRequest.get(`${fileBase}/${filePath}`),
          ).pipe(
            Effect.mapError((cause) => new ApiError({ operation: "downloadFile", cause, transient: true })),
            Effect.flatMap((result) => {
              const status = result.status
              return status >= 200 && status < 300
                ? Effect.succeed(result)
                : Effect.fail(new ApiError({ operation: "downloadFile", code: status, transient: isTransientStatus(status) }))
            }),
            (effect) => retryTransient(0, effect),
          )
          const chunks = yield* HttpClientResponse.stream(Effect.succeed(response)).pipe(
            Stream.runCollect,
            Effect.mapError((cause) => new ApiError({ operation: "downloadFile", cause, transient: false })),
          )
          return concatBytes(chunks)
        }).pipe(
          Effect.catchCause((cause) =>
            Option.match(Cause.findErrorOption(cause), {
              onNone: () =>
                logRedactedBoundary(redact, "downloadFile")(cause).pipe(
                  Effect.andThen(Effect.fail(new ApiError({ operation: "downloadFile", transient: false }))),
                ),
              onSome: (error) => Effect.fail(sanitizedApiError(redact, error)),
            }),
          ),
        ),
    }
  }),
)
