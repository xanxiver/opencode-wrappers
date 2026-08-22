import { Cause, Clock, Context, Data, Duration, Effect, Layer, Option, PartitionedSemaphore, Ref, Schema } from "effect"
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
 * editing once a second blow that budget on their own, so group chats pace
 * their edits at 3s and rely on retry_after when other senders compete.
 */
export const EDIT_MIN_INTERVAL_GROUP_MS = 3000

export const editIntervalFor = (chatId: number): number =>
  chatId < 0 ? EDIT_MIN_INTERVAL_GROUP_MS : EDIT_MIN_INTERVAL_MS

/** Milliseconds to wait before the next edit, given the last edit time. */
export const editDelay = (chatId: number, lastEditAt: number, now: number): number =>
  lastEditAt === 0 ? 0 : Math.max(0, editIntervalFor(chatId) - (now - lastEditAt))

const RETRY_MAX_ATTEMPTS = 5
const RETRY_CAP_MS = 30_000
const backoffDelay = (attempt: number): number =>
  Math.min(RETRY_CAP_MS, Math.min(RETRY_CAP_MS, 500 * 2 ** Math.min(attempt, 6)))

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
): Effect.Effect<A, ApiError, R> =>
  run.pipe(
    Effect.catchTag("ApiError", (error) => {
      if (!shouldRetry(error) || attempt >= RETRY_MAX_ATTEMPTS) return Effect.fail(error)
      const wait = Math.min(RETRY_CAP_MS, error.retryAfterMs ?? backoffDelay(attempt))
      return Effect.sleep(Duration.millis(wait)).pipe(
        Effect.andThen(retryErrors(attempt + 1, run, shouldRetry)),
      )
    }),
  )

const retryTransient = <A, R>(attempt: number, run: Effect.Effect<A, ApiError, R>): Effect.Effect<A, ApiError, R> =>
  retryErrors(attempt, run, (error) => error.transient)

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
  readonly editMessageText: (input: {
    readonly chatId: number
    readonly messageId: number
    readonly text: string
    readonly replyMarkup?: KeyboardMarkup
  }) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
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

/**
 * The bot token is part of every Telegram API URL, so transport failures can
 * carry it inside their cause text. The Live layer replaces this identity
 * function with a redactor that scrubs the configured token before logging.
 */
let redactToken = (text: string): string => text

const logRedactedBoundary = (operation: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.annotateLogs({ component: "telegram/api", boundary: "telegram-bot-api" })(
    Effect.logError(`telegram ${operation} failed`, redactToken(Cause.pretty(cause))),
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
  options?: { readonly retryTransient?: boolean },
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
        : retryTransient(0, requestEffect)
    }).pipe(
      Effect.catchCause((cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () =>
            logRedactedBoundary(operation)(cause).pipe(
              Effect.andThen(Effect.fail(new ApiError({ operation, transient: false }))),
            ),
          onSome: (error) => {
            const meta = {
              component: "telegram/api",
              boundary: "telegram-bot-api",
              operation,
              code: error.code,
              description: error.description,
              transient: error.transient,
              retryAfterMs: error.retryAfterMs,
            }
            return Effect.annotateLogs(meta)(
              Effect.logWarning(`telegram ${operation} failed`),
            ).pipe(Effect.andThen(Effect.fail(error)))
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

export const Live: Layer.Layer<TelegramApi, ConfigError, AppConfig> = Layer.effect(
  TelegramApi,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const token = config.telegramBotToken
    if (token === undefined) return yield* new ConfigError({ message: "TELEGRAM_BOT_TOKEN is required by the Telegram API" })
    // Transport failures can echo the request URL, which contains the token.
    redactToken = (text: string): string => text.split(token).join("***")
    const base = `https://api.telegram.org/bot${token}`
    const fileBase = `https://api.telegram.org/file/bot${token}`
    // Throttle edits per chat: at most one edit per second.
    const lastEdits = yield* Ref.make<ReadonlyMap<number, number>>(new Map())
    const waitForEditSlot = (chatId: number): Effect.Effect<void, never> => Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Ref.modify(lastEdits, (map) => {
        const last = map.get(chatId) ?? 0
        const delay = editDelay(chatId, last, now)
        const next = new Map(map).set(chatId, now + delay)
        return [delay, next]
      })),
      Effect.flatMap((delay) => (delay > 0 ? Effect.sleep(delay) : Effect.void)),
    )
    const sendMedia = (
      operation: "sendPhoto" | "sendVideo" | "sendDocument",
      field: "photo" | "video" | "document",
      input: TelegramMediaInput,
    ): Effect.Effect<Message, ApiError, HttpClient.HttpClient> =>
      Effect.gen(function* () {
        return yield* call(operation, MessageSchema, { retryTransient: input.retryTransient })(
          mediaRequest(base, operation, field, input),
        )
      })
    // Serialize edits per target message: the partition key is chat + message
    // id, so a streaming run only ever queues behind itself, while every
    // other chat, topic, and run edits in parallel. The shared permit pool
    // bounds total concurrent edit requests; FIFO within one partition keeps
    // a progress edit from landing after that message's newer final edit.
    // The per-chat rate slot is reserved before entering the partition.
    const editPartitions = yield* PartitionedSemaphore.make<string>({ permits: 16 })
    return {
      getUpdates: (offset, timeoutSeconds) =>
        call("getUpdates", Schema.Array(UpdateSchema))(
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
          // A 429 proves Telegram did not create the message, so a bounded
          // retry cannot duplicate it. Transport retries stay disabled
          // because an ambiguous network failure may have been delivered.
          return yield* retryErrors(
            0,
            call("sendMessage", MessageSchema, { retryTransient: false })(
              HttpClientRequest.post(`${base}/sendMessage`).pipe(HttpClientRequest.setBody(body)),
            ),
            (error) => error.code === 429,
          )
        }),
      sendPhoto: (input) => sendMedia("sendPhoto", "photo", input),
      sendVideo: (input) => sendMedia("sendVideo", "video", input),
      sendDocument: (input) => sendMedia("sendDocument", "document", input),
      editMessageText: (input) =>
        waitForEditSlot(input.chatId).pipe(
          Effect.andThen(
            editPartitions.withPermit(`${input.chatId}:${input.messageId}`)(
              Effect.gen(function* () {
                const body = yield* jsonBody("editMessageText", {
                  chat_id: input.chatId,
                  message_id: input.messageId,
                  text: input.text,
                  reply_markup: input.replyMarkup,
                })
                return yield* call("editMessageText", MessageSchema)(
                  HttpClientRequest.post(`${base}/editMessageText`).pipe(HttpClientRequest.setBody(body)),
                )
              }),
            ),
          ),
        ),
      answerCallbackQuery: (input) =>
        Effect.gen(function* () {
          const body = yield* jsonBody("answerCallbackQuery", {
            callback_query_id: input.queryId,
            text: input.text,
          })
          return yield* call("answerCallbackQuery", Schema.Boolean)(
            HttpClientRequest.post(`${base}/answerCallbackQuery`).pipe(HttpClientRequest.setBody(body)),
          )
        }),
      getFile: (fileId) =>
        call("getFile", FileInfoSchema)(
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
                logRedactedBoundary("downloadFile")(cause).pipe(
                  Effect.andThen(Effect.fail(new ApiError({ operation: "downloadFile", transient: false }))),
                ),
              onSome: (error) => Effect.fail(error),
            }),
          ),
        ),
    }
  }),
)
