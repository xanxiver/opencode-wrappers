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
  "<b>OpenCode · Command guide</b>",
  "Your coding workspace, from Telegram.",
  "",
  "<b>✨ Start here</b>",
  "<blockquote>/prompt &lt;text&gt; — run a task",
  "Example: <code>/prompt explain this project</code>",
  "Attach files, or reply with /prompt to use a message’s attachments.</blockquote>",
  "Plain messages start tasks when /loose is on.",
  "",
  "<b>▶️ Run control</b>",
  "/new — new session when nothing is running or queued",
  "/stop — stop the current run",
  "/reconnect — reattach to the active run",
  "/forceReconnect — force reattachment after a worker stops",
  "/compact — compact session context",
  "/review [focus] — review current changes",
  "/status — workspace, session, models, git and settings",
  "",
  "<b>🤖 Agents &amp; models</b>",
  "/agents — choose an agent",
  "/models [query] — browse models and variants",
  "/model &lt;provider/model&gt; [variant] — switch model",
  "/agent_model [agent] [provider/model] [variant] — view or set a pairing",
  "/pwa &lt;agent&gt; &lt;prompt&gt; — run with a specific agent",
  "",
  "<b>🧩 Agent templates</b>",
  "Save model pairings globally; apply them to this session.",
  "/agent_templates [name] — list or inspect templates",
  "/agent_template_use &lt;template&gt; — apply a template",
  "/agent_template_add &lt;template&gt; &lt;agent&gt; &lt;provider/model&gt; [variant] — add a pairing",
  "/agent_template_replace &lt;template&gt; &lt;agent&gt; &lt;provider/model&gt; [variant] — update a pairing",
  "/agent_template_remove &lt;template&gt; [agent] — delete a pairing or template",
  "",
  "<b>📋 Queue &amp; recovery</b>",
  "/queue — running and queued tasks",
  "/move &lt;from&gt; &lt;to&gt; — reorder queued tasks",
  "/queue_delete &lt;pos&gt; — remove one queued task",
  "/queue_clear — clear queued tasks",
  "/reviews — jobs needing a recovery decision",
  "/resolve_review &lt;job-id&gt; — resolve a review and remove retained data",
  "",
  "<b>📁 Projects &amp; sessions</b>",
  "/projects — choose a directory",
  "/project &lt;path&gt; — switch directory directly",
  "/sessions — browse sessions in this directory",
  "/session &lt;id&gt; — switch session by ID",
  "",
  "<b>⚙️ Preferences</b>",
  "/loose on|off — let plain messages start tasks",
  "/continue on|off — auto-continue failed runs, up to 5 times",
  "/verbosity quiet|normal|detailed — live output detail",
  "",
  "<b>💡 Working together</b>",
  "Answer questions by tapping an option or replying to the question. If one custom-answer question is waiting in this topic, plain text answers it; /prompt starts a separate task.",
  "Files: pdf, png, jpg, gif, webp, csv, xlsx, docx, md, mdx.",
  "Completed runs include a summary of current git changes.",
  "",
  "/whoami — your Telegram user ID",
  "/help · /start — this guide",
  "<i>&lt;…&gt; required · […] optional</i>",
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
