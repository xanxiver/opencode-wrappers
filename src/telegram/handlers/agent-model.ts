import { Effect, Option } from "effect"
import type { ModelInfo } from "@opencode-ai/client"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store, type StoredModel } from "../../core/store.js"
import { formatModelPreference, resolveEffectiveModel, type ModelPreferenceSource } from "../models.js"
import { parseAgentModelInput } from "../render.js"
import { SessionSelection } from "../session-selection.js"
import { conversationId } from "../conversation.js"
import { sendText } from "./shared.js"
import { resolveAgent, selectableAgents } from "./agent.js"

export const AGENT_MODEL_USAGE = "Usage: /agent_model [agent] [provider/model] [variant]"

/** One exact model match by id or provider id. */
interface ModelMatch {
  readonly model: ModelInfo | undefined
  readonly ambiguous: boolean
}

/** Match one exact model by id or provider id. */
const matchModel = (models: readonly ModelInfo[], reference: string): ModelMatch => {
  const matches = models.filter((model) => model.id === reference || `${model.providerID}/${model.id}` === reference)
  if (matches.length === 1) return { model: matches[0], ambiguous: false }
  return { model: undefined, ambiguous: matches.length > 1 }
}

/** Validate a variant against one model. Returns an error message or undefined. */
const matchVariantError = (model: ModelInfo, reference: string, variant: string | undefined): string | undefined => {
  if (variant === undefined) return undefined
  const available = model.variants.map((entry) => entry.id)
  if (available.includes(variant)) return undefined
  return available.length === 0
    ? `Model ${reference} has no variants.`
    : `Unknown variant "${variant}" for ${reference}. Available: ${available.join(", ")}`
}

/** Describe where an effective model comes from. */
const sourceLabel = (source: ModelPreferenceSource): string => {
  switch (source) {
    case "session-agent":
      return "stored"
    case "agent-config":
      return "agent default"
    case "session":
      return "session default"
    case "directory":
      return "directory default"
  }
}

/** Remember an explicit pairing for one session and agent. */
const rememberPairing = (input: { readonly sessionID: string; readonly agentID: string; readonly model: StoredModel }) =>
  Effect.gen(function* () {
    const store = yield* Store
    return yield* store.setSessionAgentModel(input.sessionID, input.agentID, input.model).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "agent-model", "remember agent model pairing failed")(cause).pipe(
          Effect.as(false),
        ),
      ),
    )
  })

/** Show the pairing for the current session agent. */
const showCurrentPairing = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* sessions.getOrCreate(conversation)
    const session = yield* opencode.getSession(sessionID)
    if (session.agent === undefined) {
      const fallback = session.model
      yield* sendText(
        chatId,
        fallback === undefined
          ? "Current agent: default. No model is available."
          : `Current agent: default. Model: ${formatModelPreference(fallback)}.`,
        threadId,
      )
      return
    }
    const agents = selectableAgents(yield* opencode.listAgents(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list agents failed")(cause).pipe(
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    ))
    const agentConfig = agents.find((agent) => agent.id === session.agent)?.model
    const stored = yield* store.getSessionAgentModel(sessionID, session.agent)
    const directoryFallback = yield* store.getDirectoryModelFallback(directory)
    const effective = resolveEffectiveModel({
      sessionAgent: Option.getOrUndefined(stored),
      agentConfig,
      session: session.model,
      directory: Option.getOrUndefined(directoryFallback),
    })
    yield* sendText(
      chatId,
      Option.match(effective, {
        onNone: () => `No model is available for ${session.agent} in this session.`,
        onSome: ({ model, source }) =>
          `Pairing for ${session.agent} in this session: ${formatModelPreference(model)} (${sourceLabel(source)}).`,
      }),
      threadId,
    )
  })

/** Show the stored pairing for one named agent. */
const showAgentPairing = (chatId: number, agentQuery: string, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* sessions.getOrCreate(conversation)
    const agents = selectableAgents(yield* opencode.listAgents(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list agents failed")(cause).pipe(
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    ))
    const selected = resolveAgent(agents, agentQuery)
    if (Option.isNone(selected)) {
      yield* sendText(chatId, `Agent not found or ambiguous: ${agentQuery}`, threadId)
      return
    }
    const session = yield* opencode.getSession(sessionID)
    const stored = yield* store.getSessionAgentModel(sessionID, selected.value.id)
    const directoryFallback = yield* store.getDirectoryModelFallback(directory)
    const effective = resolveEffectiveModel({
      sessionAgent: Option.getOrUndefined(stored),
      agentConfig: selected.value.model,
      session: session.model,
      directory: Option.getOrUndefined(directoryFallback),
    })
    yield* sendText(
      chatId,
      Option.match(effective, {
        onNone: () => `No model is available for ${selected.value.id} in this session.`,
        onSome: ({ model, source }) =>
          `Pairing for ${selected.value.id} in this session: ${formatModelPreference(model)} (${sourceLabel(source)}).`,
      }),
      threadId,
    )
  })

/** Switch the session to one agent and remember one model pairing. */
const setAgentPairing = (
  chatId: number,
  agentQuery: string,
  modelReference: string,
  variantReference: string | undefined,
  threadId?: number,
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* sessions.getOrCreate(conversation)
    const agents = selectableAgents(yield* opencode.listAgents(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list agents failed")(cause).pipe(
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    ))
    const selected = resolveAgent(agents, agentQuery)
    if (Option.isNone(selected)) {
      yield* sendText(chatId, `Agent not found or ambiguous: ${agentQuery}`, threadId)
      return
    }
    const models = yield* opencode.listModels(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list models failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly ModelInfo[]>([])),
        ),
      ),
    )
    const matched = matchModel(models, modelReference)
    if (matched.model === undefined) {
      yield* sendText(
        chatId,
        matched.ambiguous ? "Model name is ambiguous; use provider/model." : `Model not found: ${modelReference}`,
        threadId,
      )
      return
    }
    const variantError = matchVariantError(matched.model, modelReference, variantReference)
    if (variantError !== undefined) {
      yield* sendText(chatId, variantError, threadId)
      return
    }
    const agent = selected.value
    const model: StoredModel = variantReference === undefined
      ? { id: matched.model.id, providerID: matched.model.providerID }
      : { id: matched.model.id, providerID: matched.model.providerID, variant: variantReference }
    const selections = yield* SessionSelection
    const text = yield* selections.withSession(sessionID, Effect.gen(function* () {
      yield* opencode.switchAgent({ sessionID, agent: agent.id })
      yield* opencode.switchModel({ sessionID, model })
      const saved = yield* rememberPairing({ sessionID, agentID: agent.id, model })
      const base = `Agent switched to ${agent.name} (${agent.id}). Model for ${agent.id} switched to ${formatModelPreference(model)}.`
      return saved ? base : `${base} The preference could not be saved.`
    }))
    yield* sendText(chatId, text, threadId)
  })

/** `/agent_model [agent] [provider/model] [variant]` — show or switch one pairing. */
export const handleAgentModel = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentModelInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_MODEL_USAGE, threadId)
      return
    }
    const input = parsed.value
    if (input.agent === undefined) {
      yield* showCurrentPairing(chatId, threadId)
      return
    }
    if (input.model === undefined) {
      yield* showAgentPairing(chatId, input.agent, threadId)
      return
    }
    yield* setAgentPairing(chatId, input.agent, input.model, input.variant, threadId)
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-model", "agent model command failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The agent model command failed. Please try again.", threadId)),
      ),
    ),
  )
