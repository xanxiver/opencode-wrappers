import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { TelegramApi, type CallbackQuery, type KeyboardMarkup, type Message } from "../api.js"

export const CLIENT_PREFIX = "tg:"

export const clientId = (chatId: number): string => `${CLIENT_PREFIX}${chatId}`

export const chatIdFromClient = (clientIdValue: string): Option.Option<number> => {
  if (!clientIdValue.startsWith(CLIENT_PREFIX)) return Option.none()
  const id = Number(clientIdValue.slice(CLIENT_PREFIX.length))
  return Number.isInteger(id) ? Option.some(id) : Option.none()
}

export const HELP_TEXT = [
  "OpenCode bot",
  "",
  "Send a message and I run it in an OpenCode session.",
  "Use /prompt to run a task: /prompt <text>.",
  "Attach a file (pdf, png, jpg, gif, webp, csv, xlsx, docx, md, mdx) to include it.",
  "Reply to a message with /prompt to use its attachments.",
  "",
  "Commands",
  "",
  "Help",
  "/start — show this help",
  "/help — show this help",
  "",
  "Run control",
  "/new — start a new session",
  "/stop — stop the current run",
  "/resume — attach to the active run",
  "/compact — compact the current session",
  "/review [focus] — review the current changes",
  "",
  "Models and sessions",
  "/model — choose the model for this session",
  "/status — show the directory, session, and model",
  "/sessions — list and switch sessions in this directory",
  "/session <id> — set the active session by ID",
  "",
  "Projects",
  "/projects — choose a project directory",
  "/project <path> — set the project directory",
  "",
  "Account",
  "/whoami — show your Telegram user ID",
  "",
  "When the agent asks a question, answer by tapping an option",
  "or by replying to the question message with your answer.",
].join("\n")

export const logTelegramFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.annotateLogs({ component: "telegram/handlers", boundary: "telegram-bot-api" })(
    Effect.logWarning(message, Cause.pretty(cause)),
  )

/** Log a callback failure at the boundary and answer the user. */
export const callbackFailure = (query: CallbackQuery, message: string, reply: string) =>
  (cause: Cause.Cause<unknown>) =>
    logBoundary("telegram/handlers", "callback", message)(cause).pipe(
      Effect.andThen(answer(query.id, reply)),
    )

/** Send a text message into the originating forum thread when provided. */
export const sendText = (chatId: number, text: string, threadId?: number) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    yield* api.sendMessage({
      chatId,
      text,
      messageThreadId: threadId,
    }).pipe(Effect.catchCause(logTelegramFailure("sendMessage failed")))
  })

/**
 * Send a message with an inline keyboard into the chat's current thread.
 * Returns the sent message, or none when the send failed.
 */
export const sendMarkup = (chatId: number, text: string, replyMarkup: KeyboardMarkup, threadId?: number) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    return yield* api.sendMessage({
      chatId,
      text,
      replyMarkup,
      messageThreadId: threadId,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        logTelegramFailure("sendMessage failed")(cause).pipe(
          Effect.andThen(Effect.succeed(Option.none())),
        ),
      ),
    )
  })

export const answer = (queryId: string, text: string) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    yield* api.answerCallbackQuery({ queryId, text }).pipe(
      Effect.catchCause(logTelegramFailure("answerCallbackQuery failed")),
    )
  })

export const apiEdit = (
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: KeyboardMarkup,
) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    yield* api.editMessageText({ chatId, messageId, text, replyMarkup }).pipe(
      Effect.catchCause(logTelegramFailure("editMessageText failed")),
    )
  })

export const chunk = <A>(items: readonly A[], size: number): ReadonlyArray<readonly A[]> => {
  const rows: A[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size))
  }
  return rows
}

export type { Message }
