import { Option } from "effect"

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

/** How much of the reasoning stream to show in the live message. */
export const REASONING_DISPLAY_LIMIT = 800

/** Truncate long text for Telegram; keep the head and the tail. */
export const truncate = (text: string, maxLength: number = MAX_MESSAGE_LENGTH): string => {
  if (text.length <= maxLength) return text
  const marker = maxLength >= 20 ? "\n… [truncated] …\n" : "…"
  const keep = maxLength - marker.length
  const head = Math.max(1, Math.ceil(keep * 0.6))
  const tail = Math.max(0, keep - head)
  return text.slice(0, head) + marker + text.slice(-tail)
}

/**
 * Live progress body: reasoning stream, accumulated text and activity line.
 * All updates land in the same message; nothing is sent separately.
 */
export const renderProgress = (state: {
  readonly text: string
  readonly reasoning: string
  readonly activity: Option.Option<string>
}): string => {
  // Reasoning deltas can contain adjacent Markdown bold blocks, for example
  // `**first****second**`. Keep separate updates readable in Telegram.
  const formattedReasoning = state.reasoning.replace(/\*\*\*\*/g, "**\n\n**")
  const reasoning = state.reasoning.length > 0
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

/** Short label for a model picker button. */
export const renderModelLabel = (modelID: string, providerID: string): string =>
  `${modelID} (${providerID})`

/** Models shown per page in the picker. */
export const MODEL_PAGE_SIZE = 10

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
): { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<ModelPageButton>> } => {
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
