import { Effect, Option } from "effect"
import type { Info as AgentInfo } from "@opencode-ai/schema/agent"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { AgentRegistry, type SelectableAgent } from "../agents.js"
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
  agents.filter((agent) => !agent.hidden && agent.mode !== "subagent").map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
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
      const opencode = yield* OpenCode
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
          yield* opencode.switchAgent({ sessionID: current.sessionID, agent: selected.id })
          yield* apiEdit(current.chatId, current.messageId, `Agent switched to ${selected.name} (${selected.id}).`)
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
