import { Option } from "effect"
import type { ChangesSummaryResult } from "../core/git-changes.js"
import type { StreamVerbosity } from "../core/stream-verbosity.js"

export const MAX_MESSAGE_LENGTH = 4096

/**
 * Normalize a Telegram command: strip the bot mention so `/model@MyBot`
 * matches `/model`. Non-command text is unchanged.
 */
export const normalizeCommand = (text: string): string =>
  text.startsWith("/") ? text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, "$1") : text

/**
 * Parse a `/prompt` command: `/prompt` or `/prompt <text>`. Returns the
 * prompt text (possibly empty). Other text returns none — only messages
 * under `/prompt` are relayed as prompts.
 */
export const parsePromptCommand = (text: string | undefined): Option.Option<string> => {
  if (text === undefined) return Option.none()
  if (text === "/prompt") return Option.some("")
  if (text.startsWith("/prompt ")) return Option.some(text.slice("/prompt ".length).trim())
  return Option.none()
}

/** Parse `/pwa <agent> <prompt>` without allowing an empty agent or prompt. */
export const parseAgentPromptCommand = (
  text: string | undefined,
): Option.Option<{ readonly agent: string; readonly prompt: string }> => {
  if (text === undefined || !text.startsWith("/pwa ")) return Option.none()
  const argument = text.slice("/pwa ".length).trim()
  const separator = argument.indexOf(" ")
  if (separator <= 0) return Option.none()
  const agent = argument.slice(0, separator).trim()
  const prompt = argument.slice(separator + 1).trim()
  return agent.length === 0 || prompt.length === 0 ? Option.none() : Option.some({ agent, prompt })
}

/** Check for a space or tab in a model reference part. */
const hasModelReferenceWhitespace = (value: string): boolean =>
  value.includes(" ") || value.includes("\t")

/** Parse a `model [variant]` reference with brackets. */
const parseBracketedModelReference = (
  trimmed: string,
): Option.Option<{ readonly model: string; readonly variant: string }> | undefined => {
  const bracketed = trimmed.match(/^(.*?)\s*\[([^[\]]+)\]\s*$/)
  if (bracketed === null) return undefined
  const model = (bracketed[1] ?? "").trim()
  const variant = (bracketed[2] ?? "").trim()
  if (model.length === 0 || variant.length === 0) return Option.none()
  if (hasModelReferenceWhitespace(model) || hasModelReferenceWhitespace(variant)) return Option.none()
  return Option.some({ model, variant })
}

/** Parse a `model variant` reference with a space separator. */
const parseSpacedModelReference = (
  trimmed: string,
): Option.Option<{ readonly model: string; readonly variant?: string }> => {
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) {
    const model = parts[0]?.trim() ?? ""
    if (model.length === 0) return Option.none()
    return Option.some({ model })
  }
  if (parts.length !== 2) return Option.none()
  const model = parts[0]?.trim() ?? ""
  const rawVariant = parts[1]?.trim() ?? ""
  const variant = rawVariant.startsWith("[") && rawVariant.endsWith("]")
    ? rawVariant.slice(1, -1).trim()
    : rawVariant
  if (model.length === 0 || variant.length === 0) return Option.none()
  if (variant.includes("[") || variant.includes("]")) return Option.none()
  return Option.some({ model, variant })
}

/** Parse an exact model reference with an optional variant. */
export const parseExactModelReference = (
  text: string,
): Option.Option<{ readonly model: string; readonly variant?: string }> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return Option.none()
  const bracketed = parseBracketedModelReference(trimmed)
  if (bracketed !== undefined) return bracketed
  return parseSpacedModelReference(trimmed)
}

export interface AgentModelInput {
  readonly agent?: string
  readonly model?: string
  readonly variant?: string
}

/** Parse `/agent_model` input into an agent and an optional model reference. */
export const parseAgentModelInput = (text: string): Option.Option<AgentModelInput> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return Option.some({})
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return Option.some({ agent: parts[0] })
  const agent = parts[0] ?? ""
  const reference = parseExactModelReference(parts.slice(1).join(" "))
  if (agent.length === 0 || Option.isNone(reference)) return Option.none()
  return Option.some({ agent, model: reference.value.model, variant: reference.value.variant })
}

export interface AgentTemplatePairingInput {
  readonly template: string
  readonly agent: string
  readonly model: string
  readonly variant?: string
}

/** Parse template add and replace input into a template, agent, and model. */
export const parseAgentTemplatePairingInput = (text: string): Option.Option<AgentTemplatePairingInput> => {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 3) return Option.none()
  const template = parts[0] ?? ""
  const agent = parts[1] ?? ""
  const reference = parseExactModelReference(parts.slice(2).join(" "))
  if (template.length === 0 || agent.length === 0 || Option.isNone(reference)) return Option.none()
  return Option.some({ template, agent, model: reference.value.model, variant: reference.value.variant })
}

export interface AgentTemplateRemoveInput {
  readonly template: string
  readonly agent?: string
}

/** Parse template remove input into a template and an optional agent. */
export const parseAgentTemplateRemoveInput = (text: string): Option.Option<AgentTemplateRemoveInput> => {
  const parts = text.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 1) return Option.some({ template: parts[0] ?? "" })
  if (parts.length === 2) return Option.some({ template: parts[0] ?? "", agent: parts[1] })
  return Option.none()
}

/** Parse `/agent_template_use` input into one template name. */
export const parseAgentTemplateUseInput = (text: string): Option.Option<{ readonly template: string }> => {
  const parts = text.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length !== 1) return Option.none()
  return Option.some({ template: parts[0] ?? "" })
}

/** Parse `/agent_templates` input into an optional template name. */
export const parseAgentTemplatesListInput = (text: string): Option.Option<{ readonly name?: string }> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return Option.some({})
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 1) return Option.none()
  return Option.some({ name: parts[0] })
}

/** Include the replied message as context for a prompt reply. */
export const promptWithReply = (prompt: string, repliedText: string | undefined): string => {
  const context = repliedText?.trim() ?? ""
  if (context.length === 0) return prompt
  if (prompt.length === 0) return `Message to respond to:\n\n${context}`
  return `Message to respond to:\n\n${context}\n\nTask:\n${prompt}`
}

/** How much of the reasoning stream to show in the live message. */
export const REASONING_DISPLAY_LIMIT = 800

/**
 * Truncate long text for Telegram; keep the head and the tail. Cuts fall on
 * code-point boundaries so surrogate pairs survive, while the result stays
 * within the UTF-16 unit budget Telegram enforces.
 */
export const truncate = (text: string, maxLength: number = MAX_MESSAGE_LENGTH): string => {
  const units = (chars: readonly string[]): number => chars.reduce((sum, char) => sum + char.length, 0)
  const chars = Array.from(text)
  if (units(chars) <= maxLength) return text
  const marker = maxLength >= 20 ? "\n… [truncated] …\n" : "…"
  const budget = Math.max(2, maxLength - marker.length)
  const headTarget = Math.max(1, Math.ceil(budget * 0.6))
  const head: string[] = []
  let used = 0
  let index = 0
  for (; index < chars.length; index += 1) {
    const char = chars[index]
    const width = char?.length ?? 0
    if (used > 0 && used + width > headTarget) break
    if (char !== undefined) head.push(char)
    used += width
  }
  const remaining = chars.slice(index)
  const tailTarget = Math.max(0, budget - used)
  const tail: string[] = []
  let tailUsed = 0
  for (let cursor = remaining.length - 1; cursor >= 0; cursor -= 1) {
    const char = remaining[cursor]
    const width = char?.length ?? 0
    if (tailUsed + width > tailTarget) break
    if (char !== undefined) tail.unshift(char)
    tailUsed += width
  }
  return head.join("") + marker + tail.join("")
}

/**
 * Live progress body: reasoning stream, accumulated text and activity line.
 * All updates land in the same message; nothing is sent separately.
 */
export const renderProgress = (state: {
  readonly text: string
  readonly reasoning: string
  readonly activity: Option.Option<string>
  readonly verbosity: StreamVerbosity
}): string => {
  if (state.verbosity === "quiet") return "Working…"
  // Reasoning deltas can contain adjacent Markdown bold blocks, for example
  // `**first****second**`. Keep separate updates readable in Telegram.
  const formattedReasoning = state.reasoning.replace(/\*\*\*\*/g, "**\n\n**")
  const showReasoning = state.verbosity === "detailed" && state.reasoning.length > 0
  const reasoning = showReasoning
    ? `Thinking: ${truncate(formattedReasoning, REASONING_DISPLAY_LIMIT)}`
    : ""
  const body = Option.match(state.activity, {
    onNone: () => state.text,
    onSome: (activity) => (state.text.length > 0 ? `${state.text}\n\n${activity}` : activity),
  })
  const parts: string[] = []
  if (reasoning.length > 0) parts.push(reasoning)
  if (body.length > 0) parts.push(body)
  return parts.length === 0 ? "Working…" : parts.join("\n\n")
}

export const renderPermission = (action: string, resources: readonly string[]): string =>
  ["Permission requested.", `Action: ${action}`, ...resources.map((resource) => `- ${resource}`)].join(
    "\n",
  )

export type RunOutcome = "done" | "failed" | "interrupted" | "timeout" | "error"

export const renderFinal = (text: string, outcome: RunOutcome): string => {
  const body = text.length > 0 ? text : "(no text output)"
  switch (outcome) {
    case "done":
      return `${body}\n\nDone.`
    case "failed":
      return `${body}\n\nFailed.`
    case "interrupted":
      return `${body}\n\nInterrupted.`
    case "timeout":
      return `${body}\n\nTimed out.`
    case "error":
      return `${body}\n\nError.`
  }
}


export const renderPermissionDecision = (reply: "once" | "always" | "reject"): string => {
  switch (reply) {
    case "once":
      return "Allowed once."
    case "always":
      return "Always allowed."
    case "reject":
      return "Rejected."
  }
}

/**
 * Parse callback data of the form `perm:<token>:<once|always|reject>`.
 * The token is a short registry id, so the payload stays under Telegram's
 * 64-byte callback_data limit.
 */
export const parsePermissionCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly reply: "once" | "always" | "reject" }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "perm") return Option.none()
  const token = Number(parts[1])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  const reply = parts[2]
  if (reply !== "once" && reply !== "always" && reply !== "reject") return Option.none()
  return Option.some({ token, reply })
}

/** Parse callback data of the form `model:<token>:<modelIndex>`. */
export const parseModelCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly index: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "model") return Option.none()
  const token = Number(parts[1])
  const index = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  if (!Number.isInteger(index) || index < 0) return Option.none()
  return Option.some({ token, index })
}

/** Parse callback data of the form `modelp:<token>:<page>`. */
export const parseModelPageCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly page: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "modelp") return Option.none()
  const token = Number(parts[1])
  const page = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  if (!Number.isInteger(page) || page < 0) return Option.none()
  return Option.some({ token, page })
}

/** Parse callback data of the form `modelpr:<token>:<providerIndex>`. */
export const parseModelProviderCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly index: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "modelpr") return Option.none()
  const token = Number(parts[1])
  const index = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0 || !Number.isInteger(index) || index < 0) return Option.none()
  return Option.some({ token, index })
}

/** Parse callback data of the form `modelv:<token>:<variantIndex>`. */
export const parseModelVariantCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly index: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "modelv") return Option.none()
  const token = Number(parts[1])
  const index = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  if (!Number.isInteger(index) || index < 0) return Option.none()
  return Option.some({ token, index })
}

/** Parse callback data of the form `modelc:<token>`. */
export const parseModelCancelCallback = (data: string): Option.Option<number> => {
  const parts = data.split(":")
  if (parts.length !== 2 || parts[0] !== "modelc") return Option.none()
  const token = Number(parts[1])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  return Option.some(token)
}

export const parseSessionPageCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly direction: "next" | "previous" }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "sesp") return Option.none()
  const token = Number(parts[1])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  if (parts[2] !== "next" && parts[2] !== "previous") return Option.none()
  return Option.some({ token, direction: parts[2] })
}

/** Parse callback data of the form `dirp:<token>:<page>`. */
export const parseDirectoryPageCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly page: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "dirp") return Option.none()
  const token = Number(parts[1])
  const page = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0 || !Number.isInteger(page) || page < 0) return Option.none()
  return Option.some({ token, page })
}

/** Short label for a model picker button. */
export const renderModelLabel = (modelID: string, providerID: string): string =>
  `${modelID} (${providerID})`

/** Models shown per page in the picker. */
export const MODEL_PAGE_SIZE = 5

export const modelProviderKeyboard = (
  token: number,
  providers: readonly { readonly id: string }[],
) => ({
  inline_keyboard: [
    ...chunkButtons(providers.map((provider, index) => ({
      text: provider.id,
      callback_data: `modelpr:${token}:${index}`,
    })), 2),
    [{ text: "Cancel", callback_data: `modelc:${token}` }],
  ],
})

export const agentKeyboard = (
  token: number,
  agents: readonly { readonly name: string }[],
) => ({
  inline_keyboard: [
    ...chunkButtons(agents.map((agent, index) => ({
      text: agent.name,
      callback_data: `agent:${token}:${index}`,
    })), 2),
    [{ text: "Cancel", callback_data: `agentc:${token}` }],
  ],
})

export const parseAgentCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly index: number }> => {
  const parts = data.split(":")
  if (parts.length !== 3 || parts[0] !== "agent") return Option.none()
  const token = Number(parts[1])
  const index = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0 || !Number.isInteger(index) || index < 0) return Option.none()
  return Option.some({ token, index })
}

export const parseAgentCancelCallback = (data: string): Option.Option<number> => {
  const parts = data.split(":")
  if (parts.length !== 2 || parts[0] !== "agentc") return Option.none()
  const token = Number(parts[1])
  return Number.isInteger(token) && token > 0 ? Option.some(token) : Option.none()
}

const chunkButtons = <A>(items: readonly A[], size: number): A[][] => {
  const result: A[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

export interface ModelPageButton {
  readonly text: string
  readonly callback_data: string
}

/**
 * Keyboard for one page of the model picker: model buttons plus
 * Prev/Next navigation when more pages exist.
 */
export const modelPageKeyboard = (
  token: number,
  models: readonly { readonly id: string; readonly providerID: string }[],
  page: number,
  total: number,
) => {
  const rows: ModelPageButton[][] = []
  for (let i = 0; i < models.length; i += 2) {
    rows.push(
      models.slice(i, i + 2).map((model, index) => ({
        text: renderModelLabel(model.id, model.providerID),
        callback_data: `model:${token}:${page * MODEL_PAGE_SIZE + i + index}`,
      })),
    )
  }
  const pageCount = Math.ceil(total / MODEL_PAGE_SIZE)
  const navigation: ModelPageButton[] = []
  if (page > 0) {
    navigation.push({ text: "Previous", callback_data: `modelp:${token}:${page - 1}` })
  }
  if (page + 1 < pageCount) {
    navigation.push({ text: "Next", callback_data: `modelp:${token}:${page + 1}` })
  }
  if (navigation.length > 0) {
    rows.push(navigation)
  }
  rows.push([{ text: "Cancel", callback_data: `modelc:${token}` }])
  return { inline_keyboard: rows }
}

/** Picker header for the current page. */
export const renderModelPageHeader = (page: number, total: number): string => {
  const pageCount = Math.ceil(total / MODEL_PAGE_SIZE)
  if (pageCount <= 1) return `Select a model (${total}):`
  const from = page * MODEL_PAGE_SIZE + 1
  const to = Math.min((page + 1) * MODEL_PAGE_SIZE, total)
  return `Select a model (page ${page + 1} of ${pageCount}, ${from}-${to} of ${total}):`
}

export interface UsageView {
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
  }
}

/** One-line usage summary for the final message. */
export const renderUsage = (usage: UsageView): string => {
  const tokens = `${usage.tokens.input} in, ${usage.tokens.output} out`
  const reasoning = usage.tokens.reasoning > 0 ? ` (${usage.tokens.reasoning} reasoning)` : ""
  return `Usage: ${tokens}${reasoning}. Cost: USD ${usage.cost.toFixed(4)}.`
}

export interface QuestionView {
  readonly header: string
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
  /** True when a free-text reply is allowed. */
  readonly custom?: boolean
}

/** Render one question from the agent. */
export const renderQuestion = (view: QuestionView): string => {
  const body = view.header.length > 0 ? `${view.header}\n${view.question}` : view.question
  if (view.options.length === 0) {
    return `Question: ${body}\n\nReply to this message with your answer.`
  }
  const hint = view.custom === true
    ? "\n\nOr reply to this message with your answer."
    : ""
  return `Question: ${body}${hint}`
}

export type QuestionChoice =
  | { readonly kind: "option"; readonly index: number }
  | { readonly kind: "skip" }
  | { readonly kind: "confirm" }

/**
 * Parse callback data of the form `q:<token>:<questionIndex>:<optionIndex|skip|confirm>`.
 */
export const parseQuestionCallback = (
  data: string,
): Option.Option<{ readonly token: number; readonly questionIndex: number; readonly choice: QuestionChoice }> => {
  const parts = data.split(":")
  if (parts.length !== 4 || parts[0] !== "q") return Option.none()
  const token = Number(parts[1])
  const questionIndex = Number(parts[2])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  if (!Number.isInteger(questionIndex) || questionIndex < 0) return Option.none()
  if (parts[3] === "skip") return Option.some({ token, questionIndex, choice: { kind: "skip" } })
  if (parts[3] === "confirm") return Option.some({ token, questionIndex, choice: { kind: "confirm" } })
  const optionIndex = Number(parts[3])
  if (!Number.isInteger(optionIndex) || optionIndex < 0) return Option.none()
  return Option.some({ token, questionIndex, choice: { kind: "option", index: optionIndex } })
}

/** Question text with the current multi-select state appended. */
export const renderQuestionWithSelection = (view: QuestionView, selected: readonly string[]): string =>
  `${renderQuestion(view)}\n\nSelected: ${selected.length === 0 ? "(none)" : selected.join(", ")}`

/** One run in the durable pipeline for a session. */
export interface RunQueueItem {
  readonly id: string
  readonly state: string
  readonly text: string
  readonly movable: boolean
}

/** Human state label for a run in the queue. */
export const runQueueStateLabel = (state: string): string => {
  switch (state) {
    case "dispatching":
      return "Starting"
    case "running":
      return "Running"
    case "finalizing":
      return "Finishing"
    case "pending":
      return "Queued"
    default:
      return state
  }
}

/** Render active work separately from one-based movable queue positions. */
export const renderRunQueue = (items: readonly RunQueueItem[]): string => {
  if (items.length === 0) return "No runs queued for this session."
  const preview = (item: RunQueueItem): string => {
    const prompt = item.text.replace(/\s+/g, " ").trim()
    return prompt.length === 0 ? "(empty prompt)" : `"${truncate(prompt, 200)}"`
  }
  const active = items.filter((item) => !item.movable)
  const queued = items.filter((item) => item.movable)
  const lines: string[] = [`Queue for this session (${queued.length} queued)`]
  for (const item of active) {
    const state = item.state === "pending" ? "Starting" : runQueueStateLabel(item.state)
    lines.push(`${state}: ${preview(item)}`)
  }
  queued.forEach((item, index) => lines.push(`${index + 1}. ${preview(item)}`))
  if (queued.length === 0) lines.push("No queued tasks.")
  return lines.join("\n")
}

/** Maximum number of changed files shown in a changes summary. */
export const CHANGES_MAX_FILES = 8

/** Soft size budget for the changes block; far below Telegram's limit. */
export const CHANGES_BLOCK_LIMIT = 800

const sanitizeFileName = (path: string): string =>
  Array.from(path, (char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127 ? "?" : char
  }).join("")

/**
 * Render the working-tree changes block. The summary is a snapshot of the
 * current tree, not an attribution of the listed changes to one run.
 */
export const renderChangesSummary = (result: ChangesSummaryResult): Option.Option<string> => {
  switch (result.kind) {
    case "none":
      return Option.none()
    case "unavailable":
      return Option.some("Changes: unavailable.")
    case "summary": {
      const summary = result.summary
      const lines: string[] = ["Current changes"]
      const branch = Option.getOrElse(summary.branch, () => "detached HEAD")
      lines.push(Option.match(summary.commit, {
        onNone: () => `Branch: ${branch}`,
        onSome: (commit) => `Branch: ${branch} @ ${commit}`,
      }))
      if (summary.files.length === 0) {
        lines.push("Clean working tree")
      } else {
        lines.push(`Files: ${summary.files.length} changed`)
        if (Option.isSome(summary.insertions) && Option.isSome(summary.deletions)) {
          lines.push(`Tracked diff: +${summary.insertions.value} -${summary.deletions.value}`)
        }
        if (summary.binaryFiles > 0) lines.push(`Binary files: ${summary.binaryFiles}`)
        lines.push("")
        const shown = summary.files.slice(0, CHANGES_MAX_FILES)
        for (const file of shown) {
          lines.push(`${file.status} ${sanitizeFileName(file.path)}`)
        }
        if (summary.files.length > shown.length) {
          lines.push(`… and ${summary.files.length - shown.length} more`)
        }
      }
      const block = lines.join("\n")
      return Option.some(block.length <= CHANGES_BLOCK_LIMIT ? block : truncate(block, CHANGES_BLOCK_LIMIT))
    }
  }
}

/**
 * Append the changes block to a final response. The block lands after the
 * existing head-and-tail truncation, so both the response start and the
 * summary remain visible within Telegram's message limit.
 */
export const appendChangesSummary = (text: string, result: ChangesSummaryResult): string =>
  Option.match(renderChangesSummary(result), {
    onNone: () => text,
    onSome: (block) => truncate(`${text}\n\n${block}`),
  })
