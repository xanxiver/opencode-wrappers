import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions, SessionsError } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { collectAttachments, FileValidationError } from "../files.js"
import { runPrompt } from "../run.js"
import type { ApiError, Message } from "../api.js"
import { RunCoordinator } from "./services.js"
import { clientId, sendText } from "./shared.js"

const onRunFailure = (chatId: number, threadId?: number) =>
  (cause: FileValidationError | SessionsError | ApiError) => {
    switch (cause._tag) {
      case "FileValidationError":
        return sendText(chatId, `Error: ${cause.message}`, threadId)
      case "SessionsError":
      case "ApiError":
        return logBoundary("telegram/handlers", "run", "run failed")(Cause.fail(cause)).pipe(
          Effect.andThen(sendText(chatId, "An error occurred.", threadId)),
        )
    }
  }

/** Run one prompt and all its error handling. */
const runOne = (chatId: number, message: Message, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const store = yield* Store
    const attachments = yield* collectAttachments(message)
    const sessionID = yield* sessions.getOrCreate(clientId(chatId))
    const directory = yield* sessions.directoryFor(clientId(chatId))
    const model = yield* store.getModel(directory)
    yield* runPrompt({
      chatId,
      sessionID,
      text,
      files: attachments,
      threadId: message.message_thread_id,
      model: Option.getOrUndefined(model),
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () =>
          logBoundary("telegram/handlers", "run", "run failed")(cause).pipe(
            Effect.andThen(sendText(chatId, "An error occurred.", message.message_thread_id)),
          ),
        onSome: (error) => onRunFailure(chatId, message.message_thread_id)(error),
      }),
    ),
  )

/** Release the busy claim and run queued items until the queue is empty. */
const drainQueue = (chatId: number) =>
  Effect.gen(function* () {
    const runs = yield* RunCoordinator
    let next = yield* runs.nextOrRelease(chatId)
    while (Option.isSome(next)) {
      yield* runOne(chatId, next.value.message, next.value.text)
      next = yield* runs.nextOrRelease(chatId)
    }
  })

export const runWithFiles = (chatId: number, message: Message, text: string) =>
  Effect.gen(function* () {
    const runs = yield* RunCoordinator
    const claimed = yield* runs.submit(chatId, { message, text })
    if (!claimed) {
      yield* sendText(chatId, "Queued. It runs when the current task finishes.", message.message_thread_id)
      return
    }
    yield* runOne(chatId, message, text).pipe(Effect.ensuring(drainQueue(chatId)))
  })

export const setProjectDirectory = (chatId: number, directory: string, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const updated = yield* sessions.setDirectory(clientId(chatId), directory).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "sessions", "set directory failed")(cause).pipe(
          Effect.andThen(Effect.succeed(false)),
        ),
      ),
    )
    yield* sendText(
      chatId,
      updated ? `Directory set to ${directory}.` : "The directory could not be changed.",
      threadId,
    )
    return updated
  })

export const resetSession = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const reset = yield* sessions.reset(clientId(chatId)).pipe(
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
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const directory = yield* sessions.directoryFor(clientId(chatId))
    const store = yield* Store
    const sessionID = yield* store.getSessionIDForDirectory(directory)
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

/** `/resume` — attach to the active run in the current session. */
export const resumeRun = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const runs = yield* RunCoordinator
    const claimed = yield* runs.claim(chatId)
    if (!claimed) {
      yield* sendText(chatId, "This chat is already tracking a run.", threadId)
      return
    }

    yield* Effect.gen(function* () {
      const sessions = yield* Sessions
      const store = yield* Store
      const opencode = yield* OpenCode
      const directory = yield* sessions.directoryFor(clientId(chatId))
      const sessionID = yield* store.getSessionIDForDirectory(directory)
      yield* Option.match(sessionID, {
        onNone: () => sendText(chatId, "No session yet.", threadId),
        onSome: (id) =>
          Effect.gen(function* () {
            const active = yield* opencode.activeSessions()
            if (!active.includes(id)) {
              yield* sendText(chatId, "The current session has no active run.", threadId)
              return
            }
            yield* runPrompt({ chatId, sessionID: id, files: [], threadId, resume: true })
          }).pipe(
            Effect.catchCause((cause) =>
              logBoundary("telegram/handlers", "opencode-client", "resume failed")(cause).pipe(
                Effect.andThen(sendText(chatId, "The active run could not be resumed.", threadId)),
              ),
            ),
          ),
      })
    }).pipe(Effect.ensuring(drainQueue(chatId)))
  })

/** `/compact` — compact the current session without starting a prompt. */
export const compactSession = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const store = yield* Store
    const opencode = yield* OpenCode
    const directory = yield* sessions.directoryFor(clientId(chatId))
    const sessionID = yield* store.getSessionIDForDirectory(directory)
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
    const directory = yield* sessions.directoryFor(clientId(chatId))
    const sessionID = yield* store.getSessionIDForDirectory(directory)
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
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const directory = yield* sessions.directoryFor(clientId(chatId))
    yield* opencode.getSession(sessionID)
    yield* store.setSessionIDForDirectory(directory, sessionID)
    yield* sendText(chatId, `Active session set to ${sessionID}.`, threadId)
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "session", "set session by id failed")(cause).pipe(
        Effect.andThen(sendText(chatId, `Session not found: ${sessionID}.`, threadId)),
      ),
    ),
  )
