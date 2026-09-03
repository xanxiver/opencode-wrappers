import { Cause, Clock, Duration, Effect, Option } from "effect"
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
  "Completed runs include a summary of the current git changes in the project.",
  "",
  "Commands",
  "",
  "Help",
  "/start — show this help",
  "/help — show this help",
  "",
  "Run control",
  "/new - start a new session when no task is running or queued",
  "/stop — stop the current run",
  "/reconnect — attach to the active run",
  "/forceReconnect — force attachment if the current worker stopped",
  "/compact — compact the current session",
  "/review [focus] — review the current changes",
  "",
  "Models and sessions",
  "/models [query] — choose provider, model, and variant",
  "/model <provider/model> [variant] — switch directly to an exact model",
  "/agents - list and select an agent for the current session",
  "/agent_model [agent] [provider/model] [variant] — show or switch one agent model pairing",
  "/agent_templates [name] — list global agent model templates",
  "/agent_template_add <template> <agent> <provider/model> [variant] — add a template pairing",
  "/agent_template_replace <template> <agent> <provider/model> [variant] — replace a template pairing",
  "/agent_template_remove <template> [agent] — remove a pairing or a template",
  "/agent_template_use <template> — apply a template to the current session",
  "/pwa <agent> <prompt> - run a prompt with a specific agent",
  "/status - show the directory, session, agent, model, git ref, and toggles",
  "/reviews — list ambiguous durable jobs for the current session",
  "/resolve_review <job-id> — resolve a durable review and remove retained data",
  "/queue - show the running and queued runs for this session",
  "/move <from> <to> - reorder queued tasks",
  "/queue_delete <pos> - remove one queued task",
  "/queue_clear - remove every queued task",
  "/loose on|off - plain messages start runs when on",
  "/continue on|off - failed runs auto-send continue (max 5)",
  "/verbosity quiet|normal|detailed - set live run content",
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
  "When exactly one custom-answer question is waiting in this topic,",
  "plain text answers it. Use /prompt to start a separate task.",
].join("\n")

export const logTelegramFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.annotateLogs({ component: "telegram/handlers", boundary: "telegram-bot-api" })(
    Effect.logWarning(message, Cause.pretty(cause)),
  )

export const CALLBACK_ACK_TIMEOUT_MS = 2_000

/** Log a callback failure at the boundary and answer the user. */
export const callbackFailure = (query: CallbackQuery, message: string, reply: string) =>
  (cause: Cause.Cause<unknown>) =>
    logBoundary("telegram/handlers", "callback", message)(cause).pipe(
      Effect.andThen(answer(query.id, reply)),
    )

/** Send a text message into the originating forum thread when provided. */
export const sendText = (chatId: number, text: string, threadId?: number, parseMode?: "HTML") =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    yield* api.sendMessage({
      chatId,
      text,
      parseMode,
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
    const startedAt = yield* Clock.currentTimeMillis
    const outcome = yield* api.answerCallbackQuery({ queryId, text }).pipe(
      Effect.timeoutOption(Duration.millis(CALLBACK_ACK_TIMEOUT_MS)),
      Effect.matchCauseEffect({
        onFailure: (cause) => logTelegramFailure("answerCallbackQuery failed")(cause).pipe(
          Effect.as<"failed">("failed"),
        ),
        onSuccess: Option.match({
          onNone: () => Effect.succeed<"timed-out">("timed-out"),
          onSome: () => Effect.succeed<"acknowledged">("acknowledged"),
        }),
      }),
    )
    const completedAt = yield* Clock.currentTimeMillis
    const log = outcome === "acknowledged"
      ? Effect.logInfo("telegram callback acknowledgement event")
      : Effect.logWarning("telegram callback acknowledgement event")
    yield* Effect.annotateLogs({
      component: "telegram/handlers",
      boundary: "telegram-callback-acknowledgement",
      outcome,
      durationMs: Math.max(0, completedAt - startedAt),
    })(log)
  })

export const apiEdit = (
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: KeyboardMarkup,
) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    yield* api.editMessageText({
      chatId,
      messageId,
      text,
      replyMarkup,
      priority: "interactive",
      delivery: "background",
    }).pipe(
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
