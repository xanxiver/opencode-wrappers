import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { GitChanges } from "../../core/git-changes.js"
import { TelegramDurableExecutor, AUTO_CONTINUE_MAX } from "../durable-executor.js"
import type { Message } from "../api.js"
import { sendText } from "./shared.js"
import { conversationId } from "../conversation.js"

const logHandlerFailure = (chatId: number, threadId: number | undefined, message: string) =>
  (cause: Cause.Cause<unknown>) => logBoundary("telegram/handlers", "durable-executor", message)(cause).pipe(
    Effect.andThen(sendText(chatId, "The durable review operation failed.", threadId)),
  )

export const runWithFiles = (chatId: number, message: Message, text: string, agent?: string) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.submit(chatId, message, text, agent)
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

/** `/queue` — show the durable run pipeline (running and queued runs). */
export const listRunQueue = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.listQueue(chatId, threadId)
  }).pipe(Effect.catchCause((cause) =>
    logBoundary("telegram/handlers", "durable-executor", "list run queue failed")(cause).pipe(
      Effect.andThen(sendText(chatId, "The run queue could not be listed.", threadId)),
    ),
  ))

/** `/move <from> <to>` — reorder queued tasks using positions from `/queue`. */
export const moveRunQueue = (chatId: number, from: number, to: number, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.moveQueue(chatId, from, to, threadId)
  }).pipe(Effect.catchCause((cause) =>
    logBoundary("telegram/handlers", "durable-executor", "move run queue failed")(cause).pipe(
      Effect.andThen(sendText(chatId, "The queued task could not be moved.", threadId)),
    ),
  ))

/** `/queue_delete <pos>` — remove one queued task by its `/queue` position. */
export const deleteRunQueue = (chatId: number, position: number, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.deleteQueue(chatId, position, threadId)
  }).pipe(Effect.catchCause((cause) =>
    logBoundary("telegram/handlers", "durable-executor", "delete run queue failed")(cause).pipe(
      Effect.andThen(sendText(chatId, "The queued task could not be deleted.", threadId)),
    ),
  ))

/** `/queue_clear` — remove every queued task for this session. */
export const clearRunQueue = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.clearQueue(chatId, threadId)
  }).pipe(Effect.catchCause((cause) =>
    logBoundary("telegram/handlers", "durable-executor", "clear run queue failed")(cause).pipe(
      Effect.andThen(sendText(chatId, "The queue could not be cleared.", threadId)),
    ),
  ))

/** `/continue [on|off]` — failed runs auto-send a continue prompt when enabled. */
export const setAutoContinue = (chatId: number, argument: string, threadId?: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const mode = argument.trim().toLocaleLowerCase()
    if (mode !== "on" && mode !== "off") {
      const current = yield* store.getAutoContinue(conversation)
      yield* sendText(
        chatId,
        current ? "Auto-continue is on." : "Auto-continue is off. Use /continue on or /continue off.",
        threadId,
      )
      return
    }
    const enabled = mode === "on"
    yield* store.setAutoContinue(conversation, enabled)
    yield* sendText(
      chatId,
      enabled
        ? `Auto-continue on. Failed runs resend "continue" up to ${AUTO_CONTINUE_MAX} times.`
        : "Auto-continue off.",
      threadId,
    )
  })

/** `/loose [on|off]` — plain messages start runs when enabled. */
export const setLoosePrompts = (chatId: number, argument: string, threadId?: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const mode = argument.trim().toLocaleLowerCase()
    if (mode !== "on" && mode !== "off") {
      const current = yield* store.getLoosePrompts(conversation)
      yield* sendText(
        chatId,
        current ? "Loose prompts are on." : "Loose prompts are off. Use /loose on or /loose off.",
        threadId,
      )
      return
    }
    const enabled = mode === "on"
    yield* store.setLoosePrompts(conversation, enabled)
    yield* Effect.annotateLogs({
      component: "telegram/handlers",
      boundary: "loose-prompts",
      conversation,
      enabled,
    })(Effect.logInfo("loose prompts toggled"))
    yield* sendText(
      chatId,
      enabled ? "Loose prompts on. Plain messages now start runs." : "Loose prompts off.",
      threadId,
    )
  })

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
    const gitChanges = yield* GitChanges
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* store.getSessionIDForConversation(conversation)
    const remembered = yield* store.getModel(directory)
    const modelLine = Option.match(remembered, {
      onNone: () => "Model: default",
      onSome: (model) =>
        `Model: ${model.id} (${model.providerID})${model.variant === undefined ? "" : ` [${model.variant}]`}`,
    })
    const gitLine = Option.getOrUndefined(yield* gitChanges.summarize(directory).pipe(
      Effect.map((result): Option.Option<string> => {
        if (result.kind !== "summary") return Option.none()
        const ref = Option.match(result.summary.commit, {
          onNone: () => "",
          onSome: (commit) => ` @ ${commit}`,
        })
        return Option.match(result.summary.branch, {
          onNone: () => (ref === "" ? Option.none() : Option.some(`Git: detached${ref}`)),
          onSome: (branch) => Option.some(`Git: ${branch}${ref}`),
        })
      }),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "git-changes", "status git lookup failed")(cause).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    ))
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
    const loose = yield* store.getLoosePrompts(conversation)
    const autoContinue = yield* store.getAutoContinue(conversation)
    const lines: string[] = [
      `Directory: ${directory}`,
      sessionLine,
      modelLine,
      sessionStatus.contextLine,
      runLine,
    ]
    if (gitLine !== undefined) lines.push(gitLine)
    lines.push(`Loose prompts: ${loose ? "on" : "off"}`)
    lines.push(`Auto-continue: ${autoContinue ? "on" : "off"}`)
    yield* sendText(chatId, lines.join("\n"), threadId)
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
