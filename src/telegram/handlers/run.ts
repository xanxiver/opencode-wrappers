import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { TelegramDurableExecutor } from "../durable-executor.js"
import type { Message } from "../api.js"
import { sendText } from "./shared.js"
import { conversationId } from "../conversation.js"

const logHandlerFailure = (chatId: number, threadId: number | undefined, message: string) =>
  (cause: Cause.Cause<unknown>) => logBoundary("telegram/handlers", "durable-executor", message)(cause).pipe(
    Effect.andThen(sendText(chatId, "The durable review operation failed.", threadId)),
  )

export const runWithFiles = (chatId: number, message: Message, text: string) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.submit(chatId, message, text)
  })

export const setProjectDirectory = (chatId: number, directory: string, threadId?: number, notify = true) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const updated = yield* sessions.setDirectory(conversationId({ chatId, threadId }), directory).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "sessions", "set directory failed")(cause).pipe(
          Effect.andThen(Effect.succeed(false)),
        ),
      ),
    )
    if (notify) {
      yield* sendText(
        chatId,
        updated ? `Directory set to ${directory}.` : "The directory could not be changed.",
        threadId,
      )
    }
    return updated
  })

export const resetSession = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const reset = yield* sessions.reset(conversationId({ chatId, threadId })).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "sessions", "reset failed")(cause).pipe(
          Effect.andThen(Effect.succeed(false)),
        )
      ),
    )
    yield* sendText(
      chatId,
      reset
        ? "New session started. Your next message starts fresh."
        : "The session could not be reset.",
      threadId,
    )
  })

export const stopRun = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const conversation = conversationId({ chatId, threadId })
    const store = yield* Store
    const sessionID = yield* store.getSessionIDForConversation(conversation)
    yield* Option.match(sessionID, {
      onNone: () => sendText(chatId, "No session yet.", threadId),
      onSome: (id) =>
        opencode.interrupt(id).pipe(
          Effect.andThen(sendText(chatId, "Stopping…", threadId)),
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "opencode-client", "interrupt failed")(cause).pipe(
              Effect.andThen(sendText(chatId, "The run could not be stopped.", threadId)),
            ),
          ),
        ),
    })
  })

/** `/reconnect` — attach to the active run in the current session. */
export const reconnectRun = (chatId: number, message: Message, force = false) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.reconnect(chatId, message, force)
  })

export const listDurableReviews = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.listReviews(chatId, threadId)
  }).pipe(Effect.catchCause(logHandlerFailure(chatId, threadId, "list durable reviews failed")))

export const resolveDurableReview = (chatId: number, jobID: string, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.resolveReview(chatId, jobID, threadId)
  }).pipe(Effect.catchCause(logHandlerFailure(chatId, threadId, "resolve durable review failed")))

/** `/compact` — compact the current session without starting a prompt. */
export const compactSession = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const opencode = yield* OpenCode
    const conversation = conversationId({ chatId, threadId })
    const sessionID = yield* store.getSessionIDForConversation(conversation)
    yield* Option.match(sessionID, {
      onNone: () => sendText(chatId, "No session yet.", threadId),
      onSome: (id) =>
        opencode.compact(id).pipe(
          Effect.andThen(sendText(chatId, "Session compacted.", threadId)),
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "opencode-client", "compact failed")(cause).pipe(
              Effect.andThen(sendText(chatId, "The session could not be compacted.", threadId)),
            ),
          ),
        ),
    })
  })

/** `/status` — show the directory, the active session and the current model. */
export const showStatus = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* store.getSessionIDForConversation(conversation)
    const remembered = yield* store.getModel(directory)
    const modelLine = Option.match(remembered, {
      onNone: () => "Model: default",
      onSome: (model) =>
        `Model: ${model.id} (${model.providerID})${model.variant === undefined ? "" : ` [${model.variant}]`}`,
    })
    const sessionStatus = yield* Option.match(sessionID, {
      onNone: () => Effect.succeed({ session: Option.none(), contextLine: "Context: none" }),
      onSome: (id) =>
        opencode.getSession(id).pipe(
          Effect.map((session) => ({
            session: Option.some(session),
            contextLine: `Context: ${session.tokens.input.toLocaleString()} input tokens`,
          })),
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "opencode-client", "session status failed")(cause).pipe(
              Effect.andThen(Effect.succeed({ session: Option.none(), contextLine: "Context: unavailable" })),
            ),
          ),
        ),
    })
    const runLine = yield* Option.match(sessionID, {
      onNone: () => Effect.succeed("Run: none"),
      onSome: (id) =>
        opencode.activeSessions().pipe(
          Effect.map((active) => active.includes(id) ? "Run: active" : "Run: idle"),
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "opencode-client", "active session status failed")(cause).pipe(
              Effect.andThen(Effect.succeed("Run: unavailable")),
            ),
          ),
        ),
    })
    const sessionLine = Option.match(sessionID, {
      onNone: () => "Session: none",
      onSome: (id) =>
        Option.match(sessionStatus.session, {
          onNone: () => `Session: ${id}`,
          onSome: (session) => session.title === undefined ? `Session: ${id}` : `Session: ${session.title} (${id})`,
        }),
    })
    yield* sendText(
      chatId,
      `Directory: ${directory}\n${sessionLine}\n${modelLine}\n${sessionStatus.contextLine}\n${runLine}`,
      threadId,
    )
  })

/** `/session <id>` — validate and set the active session for this directory. */
export const setSessionById = (chatId: number, sessionID: string, threadId?: number) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const sessions = yield* Sessions
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const session = yield* opencode.getSession(sessionID)
    if (session.location.directory !== directory) {
      yield* sendText(chatId, "That session belongs to another directory.", threadId)
      return
    }
    yield* store.setSessionIDForConversation(conversation, sessionID)
    yield* sendText(chatId, `Active session set to ${sessionID}.`, threadId)
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "session", "set session by id failed")(cause).pipe(
        Effect.andThen(sendText(chatId, `Session not found: ${sessionID}.`, threadId)),
      ),
    ),
  )
