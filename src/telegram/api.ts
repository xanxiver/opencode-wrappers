import { Cause, Context, Data, Effect, Layer, Option, Ref, Schedule, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Stream } from "effect"
import { AppConfigTag } from "../config.js"
import { logBoundary } from "../core/logging.js"
import type { AppConfig } from "../config.js"

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly operation: string
  readonly code?: number
  readonly description?: string
  readonly cause?: unknown
  /** True when the failure is transient (network, 429, 5xx) and worth retrying. */
  readonly transient: boolean
}> {}

/** Status codes that are safe to retry with backoff. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

/** Minimum interval between message edits for the same chat (ms). */
export const EDIT_MIN_INTERVAL_MS = 1000

/** Milliseconds to wait before the next edit, given the last edit time. */
export const editDelay = (lastEditAt: number, now: number): number =>
  lastEditAt === 0 ? 0 : Math.max(0, EDIT_MIN_INTERVAL_MS - (now - lastEditAt))

/** Exponential backoff, max 5 retries, hard cap at 30 seconds total. */
const retrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.upTo({ times: 5, duration: "30 seconds" }),
)

export interface KeyboardButton {
  readonly text: string
  readonly callback_data: string
}

export interface KeyboardMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<KeyboardButton>>
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
  document: Schema.optional(DocumentSchema),
  photo: Schema.optional(Schema.Array(PhotoSizeSchema)),
})

const MessageSchema = Schema.Struct({
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
})

export interface TelegramApiShape {
  readonly getUpdates: (offset: number, timeoutSeconds: number) =>
    Effect.Effect<readonly Update[], ApiError, HttpClient.HttpClient>
  readonly sendMessage: (input: {
    readonly chatId: number
    readonly text: string
    readonly replyMarkup?: KeyboardMarkup
    /** Forum topic thread id; replies into that thread when provided. */
    readonly messageThreadId?: number
  }) => Effect.Effect<Message, ApiError, HttpClient.HttpClient>
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

export class TelegramApi extends Context.Service<TelegramApi, TelegramApiShape>()(
  "opencode2-uis/TelegramApi",
) {}

const logApiBoundary = (operation: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  logBoundary("telegram/api", "telegram-bot-api", `telegram ${operation} failed`)(cause)

/**
 * Execute a request with backoff retry for transient failures.
 * Network errors and transient statuses retry; decode and business errors do not.
 */
const call = <A>(operation: string, schema: Schema.ConstraintCodec<A>) =>
  (request: HttpClientRequest.HttpClientRequest): Effect.Effect<A, ApiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(request).pipe(
        Effect.mapError((cause) => new ApiError({ operation, cause, transient: true })),
        Effect.flatMap((result) => {
          const status = result.status
          return status >= 200 && status < 300
            ? Effect.succeed(result)
            : Effect.fail(new ApiError({ operation, code: status, transient: isTransientStatus(status) }))
        }),
        Effect.retry({ schedule: retrySchedule, while: (error) => error.transient }),
      )
      const body = yield* HttpClientResponse.stream(Effect.succeed(response)).pipe(
        Stream.runCollect,
        Effect.map(concatBytes),
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
        Effect.map((text): unknown => JSON.parse(text)),
        Effect.flatMap((json) => Schema.decodeUnknownEffect(envelope)(json)),
        Effect.mapError((cause) => new ApiError({ operation, cause, transient: false })),
      )
      if (!body.ok) {
        return yield* Effect.fail(
          new ApiError({
            operation,
            code: body.error_code,
            description: body.description,
            transient: body.error_code !== undefined && isTransientStatus(body.error_code),
          }),
        )
      }
      return yield* Option.match(Option.fromNullishOr(body.result), {
        onNone: () =>
          Effect.fail(new ApiError({ operation, description: "response has no result", transient: false })),
        onSome: (result) =>
          Schema.decodeUnknownEffect(schema)(result).pipe(
            Effect.mapError((cause) => new ApiError({ operation, cause, transient: false })),
          ),
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () =>
            logApiBoundary(operation)(cause).pipe(
              Effect.andThen(Effect.fail(new ApiError({ operation, transient: false }))),
            ),
          onSome: (error) => Effect.fail(error),
        }),
      ),
    )

const jsonBody = (operation: string, value: unknown) =>
  HttpBody.json(value).pipe(Effect.mapError((cause) => new ApiError({ operation, cause, transient: false })))

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

export const Live: Layer.Layer<TelegramApi, never, AppConfig> = Layer.effect(
  TelegramApi,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const base = `https://api.telegram.org/bot${config.telegramBotToken}`
    const fileBase = `https://api.telegram.org/file/bot${config.telegramBotToken}`
    // Throttle edits per chat: at most one edit per second.
    const lastEdits = yield* Ref.make<ReadonlyMap<number, number>>(new Map())
    const waitForEditSlot = (chatId: number): Effect.Effect<void, never> =>
      Ref.modify(lastEdits, (map) => {
        const now = Date.now()
        const last = map.get(chatId) ?? 0
        const delay = editDelay(last, now)
        const next = new Map(map).set(chatId, now + delay)
        return [delay, next]
      }).pipe(
        Effect.flatMap((delay) => (delay > 0 ? Effect.sleep(delay) : Effect.void)),
      )
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
          })
          return yield* call("sendMessage", MessageSchema)(
            HttpClientRequest.post(`${base}/sendMessage`).pipe(HttpClientRequest.setBody(body)),
          )
        }),
      editMessageText: (input) =>
        waitForEditSlot(input.chatId).pipe(
          Effect.andThen(
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
            Effect.retry({ schedule: retrySchedule, while: (error) => error.transient }),
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
                logApiBoundary("downloadFile")(cause).pipe(
                  Effect.andThen(Effect.fail(new ApiError({ operation: "downloadFile", transient: false }))),
                ),
              onSome: (error) => Effect.fail(error),
            }),
          ),
        ),
    }
  }),
)
