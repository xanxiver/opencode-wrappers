import { Effect, Option } from "effect"
import type { ModelInfo } from "@opencode-ai/client"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store, type StoredModel } from "../../core/store.js"
import {
  AgentTemplates,
  isTemplateName,
  normalizeTemplateName,
} from "../agent-templates.js"
import { formatModelPreference } from "../models.js"
import {
  parseAgentTemplatePairingInput,
  parseAgentTemplateRemoveInput,
  parseAgentTemplateUseInput,
  parseAgentTemplatesListInput,
  truncate,
} from "../render.js"
import { SessionSelection } from "../session-selection.js"
import { conversationId } from "../conversation.js"
import { sendText } from "./shared.js"
import { resolveAgent, selectableAgents } from "./agent.js"

export const AGENT_TEMPLATES_USAGE = "Usage: /agent_templates [name]"
export const AGENT_TEMPLATE_ADD_USAGE = "Usage: /agent_template_add <template> <agent> <provider/model> [variant]"
export const AGENT_TEMPLATE_REPLACE_USAGE =
  "Usage: /agent_template_replace <template> <agent> <provider/model> [variant]"
export const AGENT_TEMPLATE_REMOVE_USAGE = "Usage: /agent_template_remove <template> [agent]"
export const AGENT_TEMPLATE_USE_USAGE = "Usage: /agent_template_use <template>"

const invalidNameText = (name: string): string =>
  `Invalid template name "${name}". Use lowercase letters, numbers, hyphens, and underscores (max 32).`

const notFoundText = (name: string): string => `Template not found: ${name}. Use /agent_templates to list templates.`

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

type ValidatedPairing =
  | { readonly kind: "ok"; readonly agentID: string; readonly model: StoredModel }
  | { readonly kind: "error"; readonly message: string }

/** Resolve an agent and a model reference against the current directory. */
const validatePairing = (input: {
  readonly agents: ReturnType<typeof selectableAgents>
  readonly models: readonly ModelInfo[]
  readonly agentQuery: string
  readonly modelReference: string
  readonly variantReference: string | undefined
}): ValidatedPairing => {
  const selected = resolveAgent(input.agents, input.agentQuery)
  if (Option.isNone(selected)) return { kind: "error", message: `Agent not found or ambiguous: ${input.agentQuery}` }
  const matched = matchModel(input.models, input.modelReference)
  if (matched.model === undefined) {
    return {
      kind: "error",
      message: matched.ambiguous ? "Model name is ambiguous; use provider/model." : `Model not found: ${input.modelReference}`,
    }
  }
  const variantError = matchVariantError(matched.model, input.modelReference, input.variantReference)
  if (variantError !== undefined) return { kind: "error", message: variantError }
  return {
    kind: "ok",
    agentID: selected.value.id,
    model: input.variantReference === undefined
      ? { id: matched.model.id, providerID: matched.model.providerID }
      : { id: matched.model.id, providerID: matched.model.providerID, variant: input.variantReference },
  }
}

/** Load selectable agents and models for the current directory. */
const loadDirectoryOptions = (directory: string) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const agents = selectableAgents(yield* opencode.listAgents(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list agents failed")(cause).pipe(
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    ))
    const models = yield* opencode.listModels(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list models failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly ModelInfo[]>([])),
        ),
      ),
    )
    return { agents, models }
  })

/** `/agent_templates [name]` — list templates or show one template. */
export const showAgentTemplates = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentTemplatesListInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_TEMPLATES_USAGE, threadId)
      return
    }
    const templates = yield* AgentTemplates
    if (parsed.value.name === undefined) {
      const summaries = yield* templates.list()
      if (summaries.length === 0) {
        yield* sendText(chatId, "No agent templates are stored.", threadId)
        return
      }
      yield* sendText(
        chatId,
        truncate([
          `Agent templates (${summaries.length}):`,
          ...summaries.map((summary) => `- ${summary.name} (${summary.pairings.length} pairing${summary.pairings.length === 1 ? "" : "s"})`),
        ].join("\n")),
        threadId,
      )
      return
    }
    const name = normalizeTemplateName(parsed.value.name)
    if (!isTemplateName(name)) {
      yield* sendText(chatId, invalidNameText(name), threadId)
      return
    }
    const pairings = yield* templates.get(name)
    if (Option.isNone(pairings)) {
      yield* sendText(chatId, notFoundText(name), threadId)
      return
    }
    const entries = Object.entries(pairings.value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0) {
      yield* sendText(chatId, `Template ${name} has no pairings.`, threadId)
      return
    }
    yield* sendText(
      chatId,
      truncate([
        `Template ${name} (${entries.length} pairing${entries.length === 1 ? "" : "s"}):`,
        ...entries.map(([agentID, model]) => `- ${agentID}: ${formatModelPreference(model)}`),
      ].join("\n")),
      threadId,
    )
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-templates", "show templates failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The templates could not be loaded. Please try again.", threadId)),
      ),
    ),
  )

/** `/agent_template_add <template> <agent> <provider/model> [variant]` — add one pairing. */
export const addAgentTemplatePairing = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentTemplatePairingInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_TEMPLATE_ADD_USAGE, threadId)
      return
    }
    const name = normalizeTemplateName(parsed.value.template)
    if (!isTemplateName(name)) {
      yield* sendText(chatId, invalidNameText(name), threadId)
      return
    }
    const sessions = yield* Sessions
    const directory = yield* sessions.directoryFor(conversationId({ chatId, threadId }))
    const options = yield* loadDirectoryOptions(directory)
    const validated = validatePairing({
      agents: options.agents,
      models: options.models,
      agentQuery: parsed.value.agent,
      modelReference: parsed.value.model,
      variantReference: parsed.value.variant,
    })
    if (validated.kind === "error") {
      yield* sendText(chatId, validated.message, threadId)
      return
    }
    const templates = yield* AgentTemplates
    const result = yield* templates.add({ template: name, agentID: validated.agentID, model: validated.model })
    switch (result) {
      case "created":
        yield* sendText(
          chatId,
          `Created template ${name} with pairing ${validated.agentID}: ${formatModelPreference(validated.model)}.`,
          threadId,
        )
        return
      case "added":
        yield* sendText(
          chatId,
          `Added pairing ${validated.agentID}: ${formatModelPreference(validated.model)} to template ${name}.`,
          threadId,
        )
        return
      case "exists":
        yield* sendText(
          chatId,
          `Template ${name} already has a pairing for ${validated.agentID}. Use /agent_template_replace to change it.`,
          threadId,
        )
        return
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-templates", "add template pairing failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The template could not be saved. Please try again.", threadId)),
      ),
    ),
  )

/** `/agent_template_replace <template> <agent> <provider/model> [variant]` — replace one pairing. */
export const replaceAgentTemplatePairing = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentTemplatePairingInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_TEMPLATE_REPLACE_USAGE, threadId)
      return
    }
    const name = normalizeTemplateName(parsed.value.template)
    if (!isTemplateName(name)) {
      yield* sendText(chatId, invalidNameText(name), threadId)
      return
    }
    const sessions = yield* Sessions
    const directory = yield* sessions.directoryFor(conversationId({ chatId, threadId }))
    const options = yield* loadDirectoryOptions(directory)
    const validated = validatePairing({
      agents: options.agents,
      models: options.models,
      agentQuery: parsed.value.agent,
      modelReference: parsed.value.model,
      variantReference: parsed.value.variant,
    })
    if (validated.kind === "error") {
      yield* sendText(chatId, validated.message, threadId)
      return
    }
    const templates = yield* AgentTemplates
    const result = yield* templates.replace({ template: name, agentID: validated.agentID, model: validated.model })
    switch (result) {
      case "replaced":
        yield* sendText(
          chatId,
          `Replaced pairing ${validated.agentID}: ${formatModelPreference(validated.model)} in template ${name}.`,
          threadId,
        )
        return
      case "template-missing":
        yield* sendText(chatId, notFoundText(name), threadId)
        return
      case "pairing-missing":
        yield* sendText(
          chatId,
          `Template ${name} has no pairing for ${validated.agentID}. Use /agent_template_add to add it.`,
          threadId,
        )
        return
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-templates", "replace template pairing failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The template could not be saved. Please try again.", threadId)),
      ),
    ),
  )

/** `/agent_template_remove <template> [agent]` — remove one pairing or one template. */
export const removeAgentTemplate = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentTemplateRemoveInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_TEMPLATE_REMOVE_USAGE, threadId)
      return
    }
    const name = normalizeTemplateName(parsed.value.template)
    if (!isTemplateName(name)) {
      yield* sendText(chatId, invalidNameText(name), threadId)
      return
    }
    const templates = yield* AgentTemplates
    if (parsed.value.agent === undefined) {
      const result = yield* templates.removeTemplate(name)
      yield* sendText(chatId, result === "removed" ? `Removed template ${name}.` : notFoundText(name), threadId)
      return
    }
    const agentKey = parsed.value.agent.trim()
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const directory = yield* sessions.directoryFor(conversationId({ chatId, threadId }))
    const agents = selectableAgents(yield* opencode.listAgents(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list agents failed")(cause).pipe(
          Effect.andThen(Effect.succeed([])),
        ),
      ),
    ))
    const agentID = Option.match(resolveAgent(agents, agentKey), {
      onNone: () => agentKey,
      onSome: (agent) => agent.id,
    })
    const result = yield* templates.removePairing({ template: name, agentID })
    switch (result) {
      case "removed":
        yield* sendText(chatId, `Removed pairing ${agentID} from template ${name}.`, threadId)
        return
      case "removed-template":
        yield* sendText(
          chatId,
          `Removed pairing ${agentID} from template ${name}. Template ${name} is now empty and was removed.`,
          threadId,
        )
        return
      case "template-missing":
        yield* sendText(chatId, notFoundText(name), threadId)
        return
      case "pairing-missing":
        yield* sendText(chatId, `Template ${name} has no pairing for ${agentID}.`, threadId)
        return
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-templates", "remove template failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The template could not be removed. Please try again.", threadId)),
      ),
    ),
  )

/** Check one stored pairing against the agents and models of one directory. */
const checkUsePairing = (input: {
  readonly agentIDs: ReadonlySet<string>
  readonly models: readonly ModelInfo[]
  readonly agentID: string
  readonly model: StoredModel
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (!input.agentIDs.has(input.agentID)) return { ok: false, reason: "unknown agent" }
  const match = input.models.find((model) => model.id === input.model.id && model.providerID === input.model.providerID)
  if (match === undefined) return { ok: false, reason: "unknown model" }
  if (input.model.variant !== undefined && !match.variants.some((variant) => variant.id === input.model.variant)) {
    return { ok: false, reason: "unknown variant" }
  }
  return { ok: true }
}

/** `/agent_template_use <template>` — store all pairings into the current session. */
export const useAgentTemplate = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const parsed = parseAgentTemplateUseInput(query)
    if (Option.isNone(parsed)) {
      yield* sendText(chatId, AGENT_TEMPLATE_USE_USAGE, threadId)
      return
    }
    const name = normalizeTemplateName(parsed.value.template)
    if (!isTemplateName(name)) {
      yield* sendText(chatId, invalidNameText(name), threadId)
      return
    }
    const templates = yield* AgentTemplates
    const stored = yield* templates.get(name)
    if (Option.isNone(stored)) {
      yield* sendText(chatId, notFoundText(name), threadId)
      return
    }
    const entries = Object.entries(stored.value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length === 0) {
      yield* sendText(chatId, `Template ${name} has no pairings.`, threadId)
      return
    }
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const selections = yield* SessionSelection
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* sessions.getOrCreate(conversation)
    const options = yield* loadDirectoryOptions(directory)
    const agentIDs = new Set(options.agents.map((agent) => agent.id))
    const valid: Array<{ readonly agentID: string; readonly model: StoredModel }> = []
    const skipped: Array<string> = []
    for (const [agentID, model] of entries) {
      const checked = checkUsePairing({ agentIDs, models: options.models, agentID, model })
      if (checked.ok) valid.push({ agentID, model })
      else skipped.push(`${agentID} (${checked.reason})`)
    }
    if (valid.length === 0) {
      yield* sendText(
        chatId,
        `Template ${name} has no applicable pairings in this directory. Skipped: ${skipped.join(", ")}.`,
        threadId,
      )
      return
    }
    const applied = yield* selections.withSession(sessionID, Effect.gen(function* () {
      const failures: Array<string> = []
      for (const pairing of valid) {
        const saved = yield* store.setSessionAgentModel(sessionID, pairing.agentID, pairing.model).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "agent-templates", "apply template pairing failed")(cause).pipe(
              Effect.as(false),
            ),
          ),
        )
        if (!saved) failures.push(pairing.agentID)
      }
      const session = yield* opencode.getSession(sessionID)
      let live: string | undefined
      if (session.agent !== undefined) {
        const active = valid.find((pairing) => pairing.agentID === session.agent)
        if (active !== undefined && !failures.includes(active.agentID)) {
          const switched = yield* opencode.switchModel({ sessionID, model: active.model }).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              logBoundary("telegram/handlers", "agent-templates", "apply live model failed")(cause).pipe(
                Effect.as(false),
              ),
            ),
          )
          live = switched
            ? `Active model switched to ${formatModelPreference(active.model)}.`
            : `Active model ${formatModelPreference(active.model)} could not be applied.`
        }
      }
      return { failures, live }
    }))
    const storedIDs = valid.filter((pairing) => !applied.failures.includes(pairing.agentID)).map((pairing) => pairing.agentID)
    const lines = [`Template ${name} applied to this session: ${storedIDs.length} pairing${storedIDs.length === 1 ? "" : "s"} stored (${storedIDs.join(", ")}).`]
    const unsaved = [...applied.failures, ...skipped]
    if (unsaved.length > 0) lines.push(`Skipped: ${unsaved.join(", ")}.`)
    if (applied.live !== undefined) lines.push(applied.live)
    yield* sendText(chatId, lines.join(" "), threadId)
  }).pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "agent-templates", "use template failed")(cause).pipe(
        Effect.andThen(sendText(chatId, "The template could not be applied. Please try again.", threadId)),
      ),
    ),
  )
