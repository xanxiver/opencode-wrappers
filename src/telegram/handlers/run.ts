import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store, type StoredModel } from "../../core/store.js"
import { GitChanges } from "../../core/git-changes.js"
import type { StreamVerbosity } from "../../core/stream-verbosity.js"
import { TelegramDurableExecutor, AUTO_CONTINUE_MAX } from "../durable-executor.js"
import {
  DeliveryOwnerBusyUnavailable,
  LegacyDeliveryOwnerUnavailable,
  NoDeliveryBotAvailable,
} from "../delivery-assignments.js"
import { isSelectableAgent } from "../agents.js"
import type { Message } from "../api.js"
import { formatModelPreference, resolveEffectiveModel } from "../models.js"
import { sendText } from "./shared.js"
import { conversationId } from "../conversation.js"
import { TelegramDeliveryStatus } from "../delivery-assignments.js"

const logHandlerFailure = (chatId: number, threadId: number | undefined, message: string) =>
  (cause: Cause.Cause<unknown>) => logBoundary("telegram/handlers", "durable-executor", message)(cause).pipe(
    Effect.andThen(sendText(chatId, "The durable review operation failed.", threadId)),
  )

export const runWithFiles = (chatId: number, message: Message, text: string, agent?: string) =>
  Effect.gen(function* () {
    const executor = yield* TelegramDurableExecutor
    yield* executor.submit(chatId, message, text, agent).pipe(
      Effect.catchTags({
        OpenCodeError: (error) =>
          logBoundary("telegram/handlers", "opencode-client", "prompt snapshot resolution failed")(Cause.fail(error)).pipe(
            Effect.andThen(sendText(
              chatId,
              "The prompt was not accepted because its agent and model could not be resolved. Try again.",
              message.message_thread_id,
            )),
          ),
        NoDeliveryBotAvailable: (error: NoDeliveryBotAvailable) =>
          Effect.annotateLogs({
            component: "telegram/handlers",
            boundary: "telegram-delivery-assignment",
            chatId: error.chatId,
          })(Effect.logWarning(error.message)).pipe(
            Effect.andThen(sendText(
              chatId,
              "No delivery bot can send to this group. Check bot membership and send permissions.",
              message.message_thread_id,
            )),
          ),
        DeliveryOwnerBusyUnavailable: (error: DeliveryOwnerBusyUnavailable) =>
          Effect.annotateLogs({
            component: "telegram/handlers",
            boundary: "telegram-delivery-assignment",
            deliveryBotKey: error.botKey,
            sessionID: error.sessionID,
          })(Effect.logWarning(error.message)).pipe(
            Effect.andThen(sendText(
              chatId,
              "The assigned delivery bot is unavailable while this session still has active work. Try again after it becomes idle.",
              message.message_thread_id,
            )),
          ),
        LegacyDeliveryOwnerUnavailable: (error: LegacyDeliveryOwnerUnavailable) =>
          Effect.annotateLogs({
            component: "telegram/handlers",
            boundary: "telegram-delivery-assignment",
            deliveryBotKey: error.botKey,
            sessionID: error.sessionID,
            legacyOwnership: true,
          })(Effect.logWarning(error.message)).pipe(
            Effect.andThen(sendText(
              chatId,
              "This existing session still belongs to the controller delivery bot, which is unavailable. Select another session or use /new after current work finishes.",
              message.message_thread_id,
            )),
          ),
      }),
    )
  })

export const setProjectDirectory = (chatId: number, directory: string, threadId?: number, notify = true) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const assignments = yield* TelegramDeliveryStatus
    const conversation = conversationId({ chatId, threadId })
    const updated = yield* sessions.setDirectory(conversation, directory).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "sessions", "set directory failed")(cause).pipe(
          Effect.andThen(Effect.succeed(false)),
        ),
      ),
    )
    if (updated) {
      yield* assignments.clear(conversation).pipe(
        Effect.catchCause((cause) => logBoundary(
          "telegram/handlers",
          "delivery-assignment",
          "clear assignment after directory change failed",
        )(cause)),
      )
    }
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
    const executor = yield* TelegramDurableExecutor
    const result = yield* executor.resetConversation(chatId, threadId).pipe(
      Effect.map((status) => Option.some(status)),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "durable-executor", "reset failed")(cause).pipe(
          Effect.andThen(Effect.succeed(Option.none<"reset" | "blocked">())),
        )
      ),
    )
    yield* sendText(
      chatId,
      Option.match(result, {
        onNone: () => "The session could not be reset.",
        onSome: (status) => status === "reset"
          ? "New session started. Your next message starts fresh."
          : "The current session still has running or queued tasks. Use /queue, /stop, and /queue_clear before /new.",
      }),
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

const streamVerbosityMessage = {
  quiet: "Stream verbosity set to quiet. Only the final result will replace the working message.",
  normal: "Stream verbosity set to normal. Response text and activity will stream without reasoning.",
  detailed: "Stream verbosity set to detailed. Response text, activity, and reasoning will stream.",
} satisfies Record<StreamVerbosity, string>

/** `/verbosity [quiet|normal|detailed]` controls live run content. */
export const setStreamVerbosity = (chatId: number, argument: string, threadId?: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const mode = argument.trim().toLocaleLowerCase()
    if (mode !== "quiet" && mode !== "normal" && mode !== "detailed") {
      const current = yield* store.getStreamVerbosity(conversation)
      yield* sendText(
        chatId,
        `Stream verbosity is ${current}. Use /verbosity quiet, /verbosity normal, or /verbosity detailed.`,
        threadId,
      )
      return
    }
    yield* store.setStreamVerbosity(conversation, mode)
    yield* sendText(chatId, streamVerbosityMessage[mode], threadId)
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

interface StatusSession {
  readonly id: string
  readonly agent?: string
  readonly model?: StoredModel
}

interface StatusSelection {
  readonly agentModels: readonly StatusAgentModel[]
  readonly agentModelsMessage?: string
}

interface StatusAgentModel {
  readonly name: string
  readonly id: string
  readonly model: string
  readonly active: boolean
}

interface StatusMessageInput {
  readonly directoryLine: string
  readonly gitLine?: string
  readonly sessionLine: string
  readonly contextLine: string
  readonly runLine: string
  readonly agentModels: readonly StatusAgentModel[]
  readonly agentModelsMessage?: string
  readonly looseLine: string
  readonly autoContinueLine: string
  readonly verbosityLine: string
  readonly deliveryLine?: string
  readonly poolLine?: string
  readonly deliveryWarning?: string
}

const escapeTelegramHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => {
  switch (character) {
    case "&": return "&amp;"
    case "<": return "&lt;"
    case ">": return "&gt;"
    case "\"": return "&quot;"
    default: return "&#39;"
  }
})

const statusField = (line: string, code = false): string => {
  const separator = line.indexOf(":")
  if (separator < 0) return escapeTelegramHtml(line)
  const label = escapeTelegramHtml(line.slice(0, separator + 1))
  const value = escapeTelegramHtml(line.slice(separator + 1).trimStart())
  return `<b>${label}</b> ${code ? `<code>${value}</code>` : value}`
}

const statusSection = (title: string, lines: readonly string[]): string =>
  `<b>${title}</b>\n<blockquote>${lines.join("\n")}</blockquote>`

const renderStatusAgentModel = (entry: StatusAgentModel): string => {
  const id = escapeTelegramHtml(entry.id)
  const identity = entry.name === entry.id
    ? `<code>${id}</code>`
    : `<b>${escapeTelegramHtml(entry.name)}</b> (<code>${id}</code>)`
  const active = entry.active ? " <b>[ACTIVE]</b>" : ""
  return `${identity}${active}\n<code>${escapeTelegramHtml(entry.model)}</code>`
}

export const renderStatusMessage = (input: StatusMessageInput): string => {
  const workspace = [statusField(input.directoryLine, true)]
  if (input.gitLine !== undefined) workspace.push(statusField(input.gitLine, true))
  const agentModels = input.agentModels.length === 0
    ? [`<i>${escapeTelegramHtml(input.agentModelsMessage ?? "No selectable agents")}</i>`]
    : input.agentModels.map(renderStatusAgentModel)
  const sections = [
    "<b>OpenCode status</b>",
    statusSection("Workspace", workspace),
    statusSection("Session", [
      statusField(input.sessionLine),
      statusField(input.contextLine),
      statusField(input.runLine, true),
    ]),
    statusSection("Agent models", [agentModels.join("\n\n")]),
    statusSection("Automation", [
      statusField(input.verbosityLine, true),
      statusField(input.looseLine, true),
      statusField(input.autoContinueLine, true),
    ]),
  ]
  if (input.deliveryLine !== undefined || input.poolLine !== undefined || input.deliveryWarning !== undefined) {
    const delivery = []
    if (input.deliveryLine !== undefined) delivery.push(statusField(input.deliveryLine, true))
    if (input.poolLine !== undefined) delivery.push(statusField(input.poolLine))
    if (input.deliveryWarning !== undefined) delivery.push(`<b>${escapeTelegramHtml(input.deliveryWarning)}</b>`)
    sections.splice(3, 0, statusSection("Telegram delivery", delivery))
  }
  return sections.join("\n\n")
}

const statusSelection = (session: StatusSession, directory: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const store = yield* Store
    const directoryFallback = yield* store.getDirectoryModelFallback(directory)
    const activePair = session.agent === undefined
      ? Option.none<StoredModel>()
      : yield* store.getSessionAgentModel(session.id, session.agent)
    const agents = yield* opencode.listAgents(directory).pipe(
      Effect.map((values) => Option.some(values.filter(isSelectableAgent))),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "status agent lookup failed")(cause).pipe(
          Effect.andThen(Effect.succeed(Option.none())),
        ),
      ),
    )
    if (Option.isNone(agents)) {
      return {
        agentModels: [],
        agentModelsMessage: "Unavailable",
      } satisfies StatusSelection
    }
    const agentModels = yield* Effect.forEach(agents.value, (agent) => {
      const pair = agent.id === session.agent
        ? Effect.succeed(activePair)
        : store.getSessionAgentModel(session.id, agent.id)
      return pair.pipe(Effect.map((preference) => {
        const effective = resolveEffectiveModel({
          sessionAgent: Option.getOrUndefined(preference),
          agentConfig: agent.model,
          session: session.model,
          directory: Option.getOrUndefined(directoryFallback),
        })
        const agentID = String(agent.id)
        const agentName = String(agent.name)
        const model = Option.match(effective, {
          onNone: () => "default",
          onSome: ({ model: selected }) => formatModelPreference(selected),
        })
        return {
          name: agentName,
          id: agentID,
          model,
          active: agent.id === session.agent,
        } satisfies StatusAgentModel
      }))
    })
    return {
      agentModels,
      agentModelsMessage: agentModels.length === 0 ? "No selectable agents" : undefined,
    } satisfies StatusSelection
  })

/** `/status` — show the session, current model, and model for each agent. */
export const showStatus = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const gitChanges = yield* GitChanges
    const deliveryStatusService = yield* TelegramDeliveryStatus
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* store.getSessionIDForConversation(conversation)
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
    const selectionStatus = yield* Option.match(sessionStatus.session, {
      onNone: () => Effect.succeed({
        agentModels: [],
        agentModelsMessage: Option.isSome(sessionID) ? "Unavailable" : "No active session",
      }),
      onSome: (session) => statusSelection(session, directory),
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
    const verbosity = yield* store.getStreamVerbosity(conversation)
    const deliveryStatus = yield* deliveryStatusService.get({
      conversationId: conversation,
      sessionID: Option.getOrUndefined(sessionID),
      chatId,
    })
    const deliveryFields = Option.match(deliveryStatus, {
      onNone: () => ({}),
      onSome: ({ assignment, members }) => {
        const healthyCount = members.filter((member) =>
          member.health === "healthy" && (chatId >= 0 || member.groupEligible === true)
        ).length
        const assignedMember = Option.isNone(assignment)
          ? undefined
          : members.find((member) => member.botKey === assignment.value.deliveryBotKey)
        const deliveryName = Option.match(assignment, {
          onNone: () => "unassigned",
          onSome: (current) => {
            const username = assignedMember?.username
            const identity = username === undefined ? current.deliveryBotKey : `@${username} (${current.deliveryBotKey})`
            return current.legacy ? `${identity} [legacy]` : identity
          },
        })
        const unavailable = Option.isSome(assignment) && (
          assignedMember === undefined ||
          assignedMember.health !== "healthy" ||
          (chatId < 0 && assignedMember.groupEligible !== true)
        )
        return {
          deliveryLine: `Delivery bot: ${deliveryName}`,
          poolLine: `Delivery pool: ${healthyCount}/${members.length} available`,
          deliveryWarning: unavailable
            ? "Warning: the assigned delivery bot is unavailable."
            : undefined,
        }
      },
    })
    yield* sendText(chatId, renderStatusMessage({
      directoryLine: `Directory: ${directory}`,
      gitLine,
      sessionLine,
      contextLine: sessionStatus.contextLine,
      runLine,
      agentModels: selectionStatus.agentModels,
      agentModelsMessage: selectionStatus.agentModelsMessage,
      verbosityLine: `Stream verbosity: ${verbosity}`,
      looseLine: `Loose prompts: ${loose ? "on" : "off"}`,
      autoContinueLine: `Auto-continue: ${autoContinue ? "on" : "off"}`,
      ...deliveryFields,
    }), threadId, "HTML")
  })

/** `/session <id>` — validate and set the active session for this directory. */
export const setSessionById = (chatId: number, sessionID: string, threadId?: number) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const sessions = yield* Sessions
    const store = yield* Store
    const assignments = yield* TelegramDeliveryStatus
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const session = yield* opencode.getSession(sessionID)
    if (session.location.directory !== directory) {
      yield* sendText(chatId, "That session belongs to another directory.", threadId)
      return
    }
    yield* store.setSessionIDForConversation(conversation, sessionID)
    yield* assignments.clear(conversation).pipe(
      Effect.catchCause((cause) => logBoundary(
        "telegram/handlers",
        "delivery-assignment",
        "clear assignment after session change failed",
      )(cause)),
    )
    yield* sendText(chatId, `Active session set to ${sessionID}.`, threadId)
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "session", "set session by id failed")(cause).pipe(
        Effect.andThen(sendText(chatId, `Session not found: ${sessionID}.`, threadId)),
      ),
    ),
  )
