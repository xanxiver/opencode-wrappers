import { Effect, Option } from "effect"
import type { AgentInfo } from "@opencode-ai/client"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { AgentRegistry, isSelectableAgent, type SelectableAgent } from "../agents.js"
import { formatModelPreference, resolveEffectiveModel } from "../models.js"
import { SessionSelection } from "../session-selection.js"
import type { CallbackQuery, Message } from "../api.js"
import { conversationId } from "../conversation.js"
import {
  agentKeyboard,
  parseAgentCallback,
  parseAgentCancelCallback,
  truncate,
} from "../render.js"
import { answer, apiEdit, callbackFailure, sendMarkup, sendText } from "./shared.js"
import { runWithFiles } from "./run.js"

export const selectableAgents = (agents: readonly AgentInfo[]): readonly SelectableAgent[] =>
  agents.filter(isSelectableAgent).map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
  }))

export const resolveAgent = (
  agents: readonly SelectableAgent[],
  query: string,
): Option.Option<SelectableAgent> => {
  const normalized = query.trim().toLocaleLowerCase()
  const idMatch = agents.find((agent) => agent.id.toLocaleLowerCase() === normalized)
  if (idMatch !== undefined) return Option.some(idMatch)
  const nameMatches = agents.filter((agent) => agent.name.toLocaleLowerCase() === normalized)
  return nameMatches.length === 1 ? Option.fromNullishOr(nameMatches[0]) : Option.none()
}

const pickerIsCurrent = (entry: {
  readonly chatId: number
  readonly threadId?: number
  readonly directory: string
  readonly sessionID: string
}) => Effect.gen(function* () {
  const sessions = yield* Sessions
  const store = yield* Store
  const conversation = conversationId({ chatId: entry.chatId, threadId: entry.threadId })
  if ((yield* sessions.directoryFor(conversation)) !== entry.directory) return false
  return Option.contains(yield* store.getSessionIDForConversation(conversation), entry.sessionID)
})

const agentListText = (current: string | undefined, agents: readonly SelectableAgent[]): string => truncate([
  `Current agent: ${current ?? "default"}`,
  "",
  ...agents.map((agent) => {
    const identity = agent.name === agent.id ? agent.name : `${agent.name} (${agent.id})`
    return agent.description === undefined ? `- ${identity}` : `- ${identity}: ${agent.description}`
  }),
  "",
  "Select an agent:",
].join("\n"))

/** `/agents` — list selectable primary agents and switch the current session. */
export const showAgents = (chatId: number, threadId?: number) => Effect.gen(function* () {
  const sessions = yield* Sessions
  const opencode = yield* OpenCode
  const registry = yield* AgentRegistry
  const conversation = conversationId({ chatId, threadId })
  const sessionID = yield* sessions.getOrCreate(conversation)
  const directory = yield* sessions.directoryFor(conversation)
  const agents = selectableAgents(yield* opencode.listAgents(directory))
  if (agents.length === 0) {
    yield* sendText(chatId, "No selectable agents are available.", threadId)
    return
  }
  const session = yield* opencode.getSession(sessionID)
  const token = yield* registry.register({ sessionID, directory, agents, chatId, threadId })
  const message = yield* sendMarkup(chatId, agentListText(session.agent, agents), agentKeyboard(token, agents), threadId)
  yield* Option.match(message, {
    onNone: () => registry.cancel(token, chatId, 0).pipe(Effect.asVoid),
    onSome: (sent) => registry.attachMessageId(token, sent.message_id),
  })
}).pipe(Effect.catchCause((cause) =>
  logBoundary("telegram/handlers", "agent-picker", "show agents failed")(cause).pipe(
    Effect.andThen(sendText(chatId, "The agent list could not be loaded.", threadId)),
  ),
))

export const handleAgentCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseAgentCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) => Effect.gen(function* () {
      const message = query.message
      if (message === undefined) {
        yield* answer(query.id, "Invalid callback.")
        return
      }
      const registry = yield* AgentRegistry
      const entry = yield* registry.take(parsed.token, message.chat.id, message.message_id)
      yield* Option.match(entry, {
        onNone: () => answer(query.id, "Expired."),
        onSome: (current) => Effect.gen(function* () {
          if (!(yield* pickerIsCurrent(current))) {
            yield* answer(query.id, "This agent picker is no longer current.")
            return
          }
          const selected = current.agents[parsed.index]
          if (selected === undefined) {
            yield* answer(query.id, "Invalid agent.")
            return
          }
          yield* answer(query.id, "Switching…")
          const selections = yield* SessionSelection
          const text = yield* selections.withSession(current.sessionID, Effect.gen(function* () {
            if (!(yield* pickerIsCurrent(current))) return Option.none<string>()
            const opencode = yield* OpenCode
            const store = yield* Store
            const session = yield* opencode.getSession(current.sessionID)
            const pairModel = yield* store.getSessionAgentModel(current.sessionID, selected.id)
            const directoryFallback = yield* store.getDirectoryModelFallback(current.directory)
            const effectiveModel = resolveEffectiveModel({
              sessionAgent: Option.getOrUndefined(pairModel),
              agentConfig: selected.model,
              session: session.model,
              directory: Option.getOrUndefined(directoryFallback),
            })
            yield* opencode.switchAgent({ sessionID: current.sessionID, agent: selected.id })
            const modelApplied = yield* Option.match(effectiveModel, {
              onNone: () => Effect.succeed(true),
              onSome: ({ model }) => opencode.switchModel({
                sessionID: current.sessionID,
                model,
              }).pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  logBoundary("telegram/handlers", "agent-picker", "agent switched but model apply failed")(cause).pipe(
                    Effect.as(false),
                  ),
                ),
              ),
            })
            return Option.some(Option.match(effectiveModel, {
              onNone: () => `Agent switched to ${selected.name} (${selected.id}).`,
              onSome: ({ model }) => modelApplied
                ? `Agent switched to ${selected.name} (${selected.id}). Model: ${formatModelPreference(model)}.`
                : `Agent switched to ${selected.name} (${selected.id}), but model ${formatModelPreference(model)} could not be applied.`,
            }))
          }))
          yield* Option.match(text, {
            onNone: () => apiEdit(
              current.chatId,
              current.messageId,
              "This agent picker is no longer current. Run /agents again.",
            ),
            onSome: (value) => apiEdit(current.chatId, current.messageId, value),
          })
        }).pipe(Effect.catchCause((cause) =>
          logBoundary("telegram/handlers", "agent-picker", "agent switch failed")(cause).pipe(
            Effect.andThen(sendText(current.chatId, "The agent could not be switched.", current.threadId)),
          ),
        )),
      })
    }).pipe(Effect.catchCause(callbackFailure(query, "agent callback failed", "Failed."))),
  })

export const handleAgentCancelCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseAgentCancelCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) => Effect.gen(function* () {
      const message = query.message
      if (message === undefined) {
        yield* answer(query.id, "Invalid callback.")
        return
      }
      const registry = yield* AgentRegistry
      const entry = yield* registry.cancel(token, message.chat.id, message.message_id)
      yield* Option.match(entry, {
        onNone: () => answer(query.id, "Expired."),
        onSome: (current) => answer(query.id, "Cancelled.").pipe(
          Effect.andThen(apiEdit(current.chatId, current.messageId, "Agent selection cancelled.")),
        ),
      })
    }).pipe(Effect.catchCause(callbackFailure(query, "agent cancel callback failed", "Failed."))),
  })

/** Validate an exact agent, then submit a durable prompt with that agent snapshot. */
export const promptWithAgent = (chatId: number, message: Message, agentQuery: string, prompt: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const threadId = message.message_thread_id
    const directory = yield* sessions.directoryFor(conversationId({ chatId, threadId }))
    const agents = selectableAgents(yield* opencode.listAgents(directory))
    const selected = resolveAgent(agents, agentQuery)
    yield* Option.match(selected, {
      onNone: () => sendText(chatId, `Agent not found or ambiguous: ${agentQuery}`, threadId),
      onSome: (agent) => runWithFiles(chatId, message, prompt, agent.id),
    })
  }).pipe(Effect.catchCause((cause) =>
    logBoundary("telegram/handlers", "agent-prompt", "prompt with agent failed")(cause).pipe(
      Effect.andThen(sendText(chatId, "The agent prompt could not be started.", message.message_thread_id)),
    ),
  ))
