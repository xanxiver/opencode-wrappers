import { Atom, AtomRegistry } from "effect/unstable/reactivity"
import { Cause, Effect, Fiber, Schema, Stream } from "effect"
import {
  appendStreamTextDelta,
  appendStreamTextRecoveryDelta,
  beginStreamTextPart,
  beginStreamTextRecoveryPart,
  joinTextParts,
  makeStreamTextRecoveryState,
  recoverStreamText,
  restartStreamTextRecovery,
  type StreamTextPartIdentity,
  type StreamTextPartSnapshot,
  type StreamTextRecoveryState,
} from "../../core/stream-text.js"
import { AppViewModelError, json, refreshAccessToken, WebAppRuntime, type AppEffectRunner, type WebApiClient } from "./api-client"

export interface Session {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly projectName?: string
  readonly projectDirectory?: string
  readonly time?: { readonly updated?: number }
  readonly model?: { readonly id?: string; readonly providerID?: string; readonly variant?: string }
  readonly agent?: string
}

export type ThemeFamily = "cosmic" | "amethyst" | "meadow" | "komorebi" | "coffee" | "tokyo" | "spring" | "summer" | "autumn" | "winter" | "monochrome" | "paper"

const themeFamilies: readonly ThemeFamily[] = ["cosmic", "amethyst", "meadow", "komorebi", "coffee", "tokyo", "spring", "summer", "autumn", "winter", "monochrome", "paper"]

const isThemeFamily = (value: string | undefined): value is ThemeFamily =>
  value !== undefined && themeFamilies.some((family) => family === value)

const nextThemeFamily = (current: ThemeFamily): ThemeFamily => {
  const index = themeFamilies.indexOf(current)
  return themeFamilies[(index + 1) % themeFamilies.length] ?? "cosmic"
}

export interface ProjectOption {
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly source?: "opencode" | "custom" | "filesystem"
  readonly opencodeProject?: { readonly id: string; readonly name: string }
}

export interface ObservabilityPeriod {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
  readonly sessions: number
}

export interface ObservabilityBreakdown {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly sessions: number
  readonly tokens: number
  readonly active: number
}

export interface ObservabilitySnapshot {
  readonly available: boolean
  readonly source: "sqlite"
  readonly warning?: string
  readonly sessions: number
  readonly primarySessions: number
  readonly subagentSessions: number
  readonly archivedSessions: number
  readonly activeSessions: number
  readonly workspaces: number
  readonly models: number
  readonly agents: number
  readonly tokens: ObservabilityPeriod & { readonly total: number }
  readonly today: ObservabilityPeriod
  readonly lastWeek: ObservabilityPeriod
  readonly lastMonth: ObservabilityPeriod
  readonly daily: readonly { readonly date: number; readonly sessions: number; readonly tokens: number; readonly cost: number }[]
  readonly topModels: readonly ObservabilityBreakdown[]
  readonly topAgents: readonly ObservabilityBreakdown[]
  readonly topWorkspaces: readonly ObservabilityBreakdown[]
  readonly databaseBytes: number
  readonly generatedAt: number
}

export interface ModelOption {
  readonly id: string
  readonly modelID?: string
  readonly providerID: string
  readonly name: string
  readonly variants?: ReadonlyArray<{ readonly id: string }>
}

export interface AgentOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly mode?: string
  readonly hidden?: boolean
}

export interface ChatMessage {
  readonly id?: string
  readonly role: "user" | "assistant" | "system"
  readonly text: string
  /** Reasoning is kept with the assistant message and shown on demand. */
  readonly reasoning?: string
  /** Tool activity is kept with the assistant message and shown on demand. */
  readonly tools?: readonly string[]
  readonly retryable?: boolean
}

export interface PendingAttachment {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly content: string
}

export interface QueuedPrompt {
  readonly id: string
  readonly sessionID: string
  readonly text: string
  readonly attachments: readonly PendingAttachment[]
}

export interface UsageState {
  readonly cost?: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
}

export interface SessionStatusState {
  readonly active: boolean
  readonly contextTokens?: number
}

export interface PendingPermission {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
}

export interface QuestionOption {
  readonly label: string
  readonly description: string
}

export interface AgentQuestion {
  readonly header: string
  readonly question: string
  readonly options: readonly QuestionOption[]
  readonly custom: boolean
  readonly multiple: boolean
}

export interface PendingQuestion {
  readonly id: string
  readonly sessionID: string
  readonly questions: readonly AgentQuestion[]
}

export interface AppLoadingState {
  readonly preferences: boolean
  readonly projects: boolean
  readonly sessions: boolean
  readonly models: boolean
  readonly agents: boolean
  readonly creatingSession: boolean
  readonly switchingModel: boolean
  readonly switchingVariant: boolean
  readonly switchingAgent: boolean
  readonly compacting: boolean
  readonly interrupting: boolean
  readonly loadingStatus: boolean
  readonly replying: boolean
  readonly reverting: boolean
  readonly loadingOlderMessages: boolean
  readonly observability: boolean
}

export interface AppState {
  readonly sessions: readonly Session[]
  readonly subagents: readonly Session[]
  readonly projects: readonly ProjectOption[]
  readonly directory: string
  readonly models: readonly ModelOption[]
  readonly modelProviderKey: string
  readonly modelKey: string
  readonly variantKey: string
  readonly agents: readonly AgentOption[]
  readonly agentKey: string
  readonly agentPickerOpen: boolean
  readonly pickerMode: "quickOpen" | "command" | "project" | "model" | "agent" | "control" | "theme" | "settings"
  readonly favoriteSessionIDs: readonly string[]
  readonly activeSessionIDs: readonly string[]
  readonly userSettings: Readonly<Record<string, string>>
  readonly revertTarget?: ChatMessage
  readonly selectedID?: string
  readonly messages: readonly ChatMessage[]
  readonly hasOlderMessages: boolean
  readonly olderMessageCursor?: string
  readonly text: string
  readonly busy: boolean
  readonly attachments: readonly PendingAttachment[]
  readonly queuedPrompts: readonly QueuedPrompt[]
  readonly observability?: ObservabilitySnapshot
  readonly activity?: string
  readonly reasoning: string
  readonly streamedText: string
  readonly streamedTextPartPending: boolean
  readonly streamedTextPartIdentity: StreamTextPartIdentity | undefined
  readonly streamedTextRecovery: StreamTextRecoveryState
  readonly activityHistory: readonly string[]
  readonly usage?: UsageState
  readonly sessionStatus?: SessionStatusState
  readonly permissions: readonly PendingPermission[]
  readonly questions: readonly PendingQuestion[]
  readonly questionDrafts: Readonly<Record<string, readonly (readonly string[])[]>>
  readonly directDirectory: string
  readonly directSessionID: string
  readonly reviewFocus: string
  readonly loading: AppLoadingState
  readonly connection: "connected" | "reconnecting" | "disconnected"
  readonly theme: "dark" | "light"
  readonly themeFamily: ThemeFamily
  readonly error?: string
}

export const retainPromptEvidenceAfterFailure = (state: AppState, error: string): AppState => ({
  ...state,
  error,
})

const ApiOkResponse = Schema.Struct({ ok: Schema.Boolean })
const ApiSession = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  time: Schema.optional(Schema.Struct({ updated: Schema.optional(Schema.Number) })),
  model: Schema.optional(Schema.Struct({
    id: Schema.optional(Schema.String),
    providerID: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String),
  })),
  agent: Schema.optional(Schema.String),
})
const ApiSessionList = Schema.Struct({ data: Schema.Array(ApiSession) })
const ApiMessagePart = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Struct({
    status: Schema.optional(Schema.String),
    content: Schema.optional(Schema.Array(Schema.Unknown)),
  })),
})
const ApiMessage = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ApiMessagePart)])),
  files: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.optional(Schema.String) }))),
  finish: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  retry: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  time: Schema.optional(Schema.Struct({ completed: Schema.optional(Schema.Number) })),
})
const ApiMessagesPage = Schema.Struct({
  messages: Schema.Array(ApiMessage),
  hasMore: Schema.Boolean,
  nextBefore: Schema.optional(Schema.String),
})
const ApiProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  source: Schema.optional(Schema.Literals(["opencode", "custom", "filesystem"])),
  opencodeProject: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
})
const ApiModel = Schema.Struct({
  id: Schema.String,
  modelID: Schema.optional(Schema.String),
  providerID: Schema.String,
  name: Schema.String,
  variants: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
})
const ApiAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
})
const ApiPreferences = Schema.Struct({
  lastProject: Schema.optional(Schema.String),
  lastSessions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  favoriteSessionIDs: Schema.optional(Schema.Array(Schema.String)),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const ApiSessionStatus = Schema.Struct({
  session: Schema.Struct({
    tokens: Schema.optional(Schema.Struct({ input: Schema.optional(Schema.Number) })),
  }),
  active: Schema.Boolean,
})
const ApiPendingPermission = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
})
const ApiQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
const ApiAgentQuestion = Schema.Struct({
  header: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.optional(Schema.Array(ApiQuestionOption)),
  custom: Schema.optional(Schema.Boolean),
  multiple: Schema.optional(Schema.Boolean),
})
const ApiPendingQuestion = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  questions: Schema.Array(ApiAgentQuestion),
})
const ApiPending = Schema.Struct({
  permissions: Schema.Array(ApiPendingPermission),
  questions: Schema.Array(ApiPendingQuestion),
})
const ApiPromptResult = Schema.Struct({
  queued: Schema.Boolean,
  id: Schema.String,
})
const ApiQueuedPrompt = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("user"),
  delivery: Schema.Literal("queue"),
  data: Schema.Struct({
    text: Schema.String,
    files: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
  }),
})
const ApiObservabilityPeriod = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cost: Schema.Number,
  sessions: Schema.Number,
})
const ApiObservabilityBreakdown = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  sessions: Schema.Number,
  tokens: Schema.Number,
  active: Schema.Number,
})
const ApiObservabilityDaily = Schema.Struct({
  date: Schema.Number,
  sessions: Schema.Number,
  tokens: Schema.Number,
  cost: Schema.Number,
})
const ApiObservability = Schema.Struct({
  available: Schema.Boolean,
  source: Schema.Literal("sqlite"),
  warning: Schema.optional(Schema.String),
  sessions: Schema.optional(Schema.Number),
  primarySessions: Schema.optional(Schema.Number),
  subagentSessions: Schema.optional(Schema.Number),
  archivedSessions: Schema.optional(Schema.Number),
  activeSessions: Schema.optional(Schema.Number),
  workspaces: Schema.optional(Schema.Number),
  models: Schema.optional(Schema.Number),
  agents: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Struct({ ...ApiObservabilityPeriod.fields, total: Schema.Number })),
  today: Schema.optional(ApiObservabilityPeriod),
  lastWeek: Schema.optional(ApiObservabilityPeriod),
  lastMonth: Schema.optional(ApiObservabilityPeriod),
  daily: Schema.optional(Schema.Array(ApiObservabilityDaily)),
  topModels: Schema.optional(Schema.Array(ApiObservabilityBreakdown)),
  topAgents: Schema.optional(Schema.Array(ApiObservabilityBreakdown)),
  topWorkspaces: Schema.optional(Schema.Array(ApiObservabilityBreakdown)),
  databaseBytes: Schema.optional(Schema.Number),
  generatedAt: Schema.Number,
})
const ApiEventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  assistantMessageID: Schema.optional(Schema.String),
  ordinal: Schema.optional(Schema.Int),
  delta: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  tool: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  tokens: Schema.optional(Schema.Struct({
    input: Schema.optional(Schema.Number),
    output: Schema.optional(Schema.Number),
    reasoning: Schema.optional(Schema.Number),
  })),
  form: Schema.optional(Schema.Struct({ sessionID: Schema.String })),
  questions: Schema.optional(Schema.Array(ApiAgentQuestion)),
})
const ApiEvent = Schema.Struct({ type: Schema.String, data: ApiEventData })
type ApiEvent = typeof ApiEvent.Type
type ApiMessage = typeof ApiMessage.Type
type ApiAgentQuestion = typeof ApiAgentQuestion.Type
type ApiPendingQuestion = typeof ApiPendingQuestion.Type
type ApiSession = typeof ApiSession.Type
type ModelRequest = { readonly id: string; readonly providerID: string; readonly variant?: string }
type MutableChatMessage = { id?: string; role: ChatMessage["role"]; text: string; reasoning?: string; tools?: readonly string[]; retryable?: boolean }
type MutableRecoveredStream = { text: string; textParts: readonly StreamTextPartSnapshot[]; reasoning: string; activity?: string }
type MutableSession = { id: string; parentID?: string; title?: string; projectName?: string; projectDirectory?: string; time?: { updated?: number }; model?: { id?: string; providerID?: string; variant?: string }; agent?: string }

type EventSourceSignal =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Message"; readonly event: ApiEvent }

const eventSourceSignals = (): Stream.Stream<EventSourceSignal, AppViewModelError> =>
  Stream.unwrap(Effect.acquireRelease(
    Effect.try({
      try: () => new EventSource("/api/events"),
      catch: (cause) => new AppViewModelError("connect to server events", cause),
    }),
    (source) => Effect.sync(() => source.close()),
  ).pipe(Effect.map((source) => Stream.mergeAll([
    Stream.fromEventListener<Event>(source, "open").pipe(
      Stream.map((): EventSourceSignal => ({ _tag: "Open" })),
    ),
    Stream.fromEventListener<MessageEvent<string>>(source, "message").pipe(
      Stream.mapEffect((message) => Schema.decodeUnknownEffect(Schema.fromJsonString(ApiEvent))(message.data).pipe(
        Effect.map((event): EventSourceSignal => ({ _tag: "Message", event })),
        Effect.mapError((cause) => new AppViewModelError("decode server event", cause)),
      )),
    ),
    Stream.fromEventListener<Event>(source, "error").pipe(
      Stream.mapEffect(() => Effect.fail(new AppViewModelError(
        "receive server events",
        new Error("The server event connection closed"),
      ))),
    ),
  ], { concurrency: 3 }))))

const initialState: AppState = {
  sessions: [], subagents: [], projects: [], directory: "", models: [], modelProviderKey: "", modelKey: "", variantKey: "",
  agents: [], agentKey: "", agentPickerOpen: false, pickerMode: "command", favoriteSessionIDs: [], activeSessionIDs: [], userSettings: {}, messages: [], text: "", busy: false,
  attachments: [], queuedPrompts: [], observability: undefined, reasoning: "", streamedText: "", streamedTextPartPending: false, streamedTextPartIdentity: undefined, streamedTextRecovery: makeStreamTextRecoveryState(), activityHistory: [], permissions: [], questions: [], questionDrafts: {}, hasOlderMessages: false,
  directDirectory: "", directSessionID: "", reviewFocus: "",
  loading: { preferences: true, projects: true, sessions: false, models: false, agents: false, creatingSession: false, switchingModel: false, switchingVariant: false, switchingAgent: false, compacting: false, interrupting: false, loadingStatus: false, replying: false, reverting: false, loadingOlderMessages: false, observability: false },
  connection: "disconnected", theme: "dark", themeFamily: "cosmic",
}

export const appStateAtom = Atom.make(initialState)

const stateHasSession = (sessions: readonly Session[], sessionID: string | undefined): sessionID is string =>
  sessionID !== undefined && sessions.some((session) => session.id === sessionID)

interface MessageParts {
  readonly text: string
  readonly textParts: readonly StreamTextPartSnapshot[]
  readonly reasoning: string
  readonly tools: readonly string[]
}

const messageParts = (message: ApiMessage): MessageParts => {
  if (message.text !== undefined) return { text: message.text, textParts: [], reasoning: "", tools: [] }
  if (message.content === undefined) return { text: "", textParts: [], reasoning: "", tools: [] }
  if (Array.isArray(message.content)) {
    const textParts: string[] = []
    const textPartSnapshots: StreamTextPartSnapshot[] = []
    const reasoningParts: string[] = []
    const tools: string[] = []
    for (const [ordinal, partValue] of message.content.entries()) {
      const part = partValue
      if (part.type === "text" && part.text !== undefined) {
        textParts.push(part.text)
        if (message.id !== undefined) textPartSnapshots.push({ assistantMessageID: message.id, ordinal, text: part.text })
      }
      if (part.type === "reasoning" && part.text !== undefined) reasoningParts.push(part.text)
      if (part.type === "tool") {
        let name = "tool"
        if (part.name !== undefined) name = part.name
        else if (part.tool !== undefined) name = part.tool
        const status = part.state?.status ?? "called"
        tools.push(`${name} · ${status}`)
      }
    }
    return { text: joinTextParts(textParts), textParts: textPartSnapshots, reasoning: joinTextParts(reasoningParts), tools }
  }
  return { text: "", textParts: [], reasoning: "", tools: [] }
}

const joinContent = (left: string | undefined, right: string): string | undefined => {
  if (right.length === 0) return left
  return left === undefined || left.length === 0 ? right : `${left}\n\n${right}`
}

const mergeAdjacentMessages = (messages: readonly ChatMessage[]): readonly ChatMessage[] => {
  const merged: ChatMessage[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (previous?.role !== "assistant" || message.role !== "assistant") {
      merged.push(message)
      continue
    }
    const next = {
      ...previous,
      text: joinContent(previous.text, message.text) ?? "",
      tools: [...(previous.tools ?? []), ...(message.tools ?? [])],
    }
    const reasoning = joinContent(previous.reasoning, message.reasoning ?? "")
    if (message.id !== undefined) next.id = message.id
    if (reasoning !== undefined) next.reasoning = reasoning
    merged[merged.length - 1] = next
  }
  return merged
}

/** Convert OpenCode event records into user-visible conversational turns. */
export const normalizeChatMessages = (values: readonly ApiMessage[], includeRetry = true): readonly ChatMessage[] => {
  const messages = values.flatMap((item, index): ChatMessage[] => {
    const message = item
    const type = message.type
    if (type === "synthetic" || type === "shell" || type === "agent-selected" || type === "model-selected") return []
    if (type === "compaction") {
      const summary = message.summary ?? ""
      if (summary.length === 0) return []
      const result: MutableChatMessage = { role: "system", text: summary }
      if (message.id !== undefined) result.id = message.id
      return [result]
    }
    const parts = messageParts(item)
    const role = messageRole(item)
    const attachmentCount = Array.isArray(message.files) ? message.files.length : 0
    let text = parts.text
    if (text.length === 0 && role === "user" && attachmentCount > 0) {
      text = `[${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}]`
    }
    const failure = role === "assistant" && messageHasFailure(item)
    if (text.length === 0 && parts.reasoning.length === 0 && parts.tools.length === 0 && !failure) return []
    const result: MutableChatMessage = {
      role,
      text: failure && text.length === 0 ? "Response failed." : text,
    }
    if (message.id !== undefined) result.id = message.id
    if (parts.reasoning.length > 0) result.reasoning = parts.reasoning
    if (parts.tools.length > 0) result.tools = parts.tools
    if (includeRetry && role === "user" && isRetryableUserMessage(values, index)) result.retryable = true
    return [result]
  })
  return mergeAdjacentMessages(messages)
}

interface RecoveredStream {
  readonly text: string
  readonly textParts: readonly StreamTextPartSnapshot[]
  readonly reasoning: string
  readonly activity?: string
}

const recoverStream = (message: ApiMessage): RecoveredStream | undefined => {
  if (message.type !== "assistant" || message.time?.completed !== undefined || !Array.isArray(message.content)) return undefined
  let text = ""
  let reasoning = ""
  let activity: string | undefined
  const parts = messageParts(message)
  text = parts.text
  reasoning = parts.reasoning
  const latestTool = parts.tools.at(-1)
  if (latestTool !== undefined) {
    activity = latestTool.includes("· running") ? `Using ${latestTool.split(" · ")[0]}` : `Preparing ${latestTool.split(" · ")[0]}`
  }
  const result: MutableRecoveredStream = { text, textParts: parts.textParts, reasoning }
  if (activity !== undefined) result.activity = activity
  return result
}

const messageRole = (message: ApiMessage): ChatMessage["role"] => {
  if (message.role === "user" || message.role === "assistant" || message.role === "system") return message.role
  if (message.type === "user") return "user"
  if (message.type === "assistant") return "assistant"
  return "system"
}

const messageHasFailure = (message: ApiMessage): boolean => {
  return message.finish === "error" || Object.keys(message.error ?? {}).length > 0 || Object.keys(message.retry ?? {}).length > 0
}

/** A retry belongs to the latest user prompt before its failed response. */
export const isRetryableUserMessage = (values: readonly ApiMessage[], index: number): boolean => {
  const message = values[index]
  if (index < 0 || index >= values.length || messageRole(message) !== "user") return false
  const nextUser = values.findIndex((value, candidateIndex) => {
    return candidateIndex > index && messageRole(value) === "user"
  })
  const hasFailure = values
    .slice(index + 1, nextUser === -1 ? undefined : nextUser)
    .some((value) => {
      return messageRole(value) === "assistant" && messageHasFailure(value)
    })
  return hasFailure && nextUser === -1
}

const agentQuestion = (item: ApiAgentQuestion): AgentQuestion => {
  const options = (item.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" }))
  return {
    header: item.header ?? "",
    question: item.question,
    options,
    custom: item.custom === true,
    multiple: item.multiple === true,
  }
}

const pendingQuestion = (item: ApiPendingQuestion): PendingQuestion => {
  return { id: item.id, sessionID: item.sessionID, questions: item.questions.map(agentQuestion) }
}

const eventSessionID = (value: ApiEvent): string | undefined => value.data.sessionID ?? value.data.form?.sessionID

const eventTextPartIdentity = (data: ApiEvent["data"]): StreamTextPartIdentity | undefined =>
  data.assistantMessageID === undefined || data.ordinal === undefined
    ? undefined
    : { assistantMessageID: data.assistantMessageID, ordinal: data.ordinal }

const activityForEvent = (type: string): string | undefined => ({
  "session.execution.started": "Execution started",
  "session.text.started": "Writing response",
  "session.reasoning.started": "Thinking",
  "session.reasoning.ended": "Thinking finished",
  "session.tool.called": "Using a tool",
  "session.tool.input.started": "Preparing tool input",
  "session.tool.progress": "Tool in progress",
  "session.compaction.started": "Compacting session",
  "session.retry.scheduled": "Retry scheduled",
  "session.step.started": "Step started",
  "session.step.ended": "Step finished",
}[type])

export function createAppViewModel(registry: AtomRegistry.AtomRegistry, runner: AppEffectRunner) {
  const run = <A>(
    effect: Effect.Effect<A, AppViewModelError, WebApiClient | WebAppRuntime>,
    onFailure: (error: AppViewModelError) => void,
    onSuccess?: (value: A) => void,
  ): void => {
    runner.run(effect, onFailure, onSuccess)
  }
  let nextLocalIdentifier = 0
  const localIdentifier = (kind: "prompt" | "attachment"): string => `${kind}-${++nextLocalIdentifier}`
  let reconnectEvents: (() => void) | undefined
  let savedSessions: Readonly<Record<string, string>> = {}
  const update = (f: (state: AppState) => AppState): void => registry.update(appStateAtom, f)
  const fail = (error: AppViewModelError): void => update((state) => ({ ...state, error: error.message, busy: false }))

  const persistProject = (directory: string): void => run(json("/api/preferences/project", ApiOkResponse, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory }),
  }), (error) => fail(new AppViewModelError("save project preference", error)))

  const persistSession = (directory: string, sessionID: string): void => run(json("/api/preferences/session", ApiOkResponse, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory, sessionID }),
  }), (error) => fail(new AppViewModelError("save session preference", error)))

  const persistFavorite = (sessionID: string, pinned: boolean): void => run(json("/api/preferences/favorite", ApiOkResponse, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID, pinned }),
  }), (error) => fail(new AppViewModelError("save favorite session", error)))

  const persistSetting = (key: string, value: string, onSuccess?: () => void): void => {
    const request = json("/api/preferences/setting", ApiOkResponse, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }),
    })
    run(Effect.flatMap(WebAppRuntime, ({ preferenceWrites }) => preferenceWrites.withPermits(1)(request.pipe(
      Effect.tap(() => onSuccess === undefined ? Effect.void : Effect.sync(onSuccess)),
      Effect.asVoid,
    ))), (error) => fail(new AppViewModelError("save user preference", error)))
  }

  const loadMessages = (sessionID: string): void => run(
    json(`/api/sessions/${encodeURIComponent(sessionID)}/messages`, ApiMessagesPage).pipe(
      Effect.map((data) => {
        const values = data.messages
    const last = values.at(-1)
    const recovered = last === undefined ? undefined : recoverStream(last)
        const stable = recovered === undefined ? values : values.slice(0, -1)
        const messages = normalizeChatMessages(stable)
        return {
          messages,
          recovered,
          hasOlderMessages: data.hasMore,
          olderMessageCursor: data.nextBefore,
        }
      }),
      Effect.tap(({ messages, recovered, hasOlderMessages, olderMessageCursor }) => Effect.sync(() => {
        if (registry.get(appStateAtom).selectedID === sessionID) update((state) => {
          const next = { ...state, messages, hasOlderMessages, olderMessageCursor }
          if (recovered !== undefined) {
            const recoveredStream = recoverStreamText(
              { text: state.streamedText, startsNewPart: state.streamedTextPartPending, activePartIdentity: state.streamedTextPartIdentity },
              state.streamedTextRecovery,
              recovered.text,
              recovered.textParts,
            )
            Object.assign(next, {
              streamedText: recoveredStream.stream.text,
              streamedTextPartPending: recoveredStream.stream.startsNewPart,
              streamedTextPartIdentity: recoveredStream.stream.activePartIdentity,
              streamedTextRecovery: recoveredStream.recovery,
              reasoning: recovered.reasoning,
              activity: recovered.activity ?? (recovered.reasoning.length > 0 ? "Thinking" : "Writing response"),
            })
          }
          return next
        })
      })),
    ),
    (error) => fail(new AppViewModelError("load messages", error)),
  )

  const loadOlderMessages = (): void => {
    const current = registry.get(appStateAtom)
    const sessionID = current.selectedID
    const cursor = current.olderMessageCursor
    if (sessionID === undefined || !current.hasOlderMessages || cursor === undefined || current.loading.loadingOlderMessages) return
    update((state) => ({ ...state, loading: { ...state.loading, loadingOlderMessages: true } }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/messages?before=${encodeURIComponent(String(cursor))}`, ApiMessagesPage).pipe(
      Effect.tap((data) => Effect.sync(() => {
        const messages = normalizeChatMessages(data.messages, false)
        if (registry.get(appStateAtom).selectedID !== sessionID) return
        update((state) => ({
          ...state,
          messages: mergeAdjacentMessages([...messages, ...state.messages]),
          hasOlderMessages: data.hasMore,
           ...(data.nextBefore === undefined ? { olderMessageCursor: undefined } : { olderMessageCursor: data.nextBefore }),
          loading: { ...state.loading, loadingOlderMessages: false },
        }))
      })),
    ), (error) => update((state) => ({ ...state, error: error.message, loading: { ...state.loading, loadingOlderMessages: false } })))
  }

  const loadSubagents = (sessionID: string): void => run(
    json(`/api/sessions/${encodeURIComponent(sessionID)}/subagents`, Schema.Array(ApiSession)).pipe(
      Effect.tap((subagents) => Effect.sync(() => {
        if (registry.get(appStateAtom).selectedID === sessionID) update((state) => ({ ...state, subagents }))
      })),
    ),
    (error) => fail(new AppViewModelError("load subagents", error)),
  )

  const loadStatus = (sessionID: string): void => run(
    Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, loadingStatus: true } }))).pipe(
      Effect.andThen(json(`/api/sessions/${encodeURIComponent(sessionID)}/status`, ApiSessionStatus)),
      Effect.tap((value) => Effect.sync(() => {
        if (registry.get(appStateAtom).selectedID !== sessionID) return
        update((state) => ({
          ...state,
          busy: value.active,
          sessionStatus: {
            active: value.active,
            contextTokens: value.session.tokens?.input,
          },
          loading: { ...state.loading, loadingStatus: false },
        }))
         if (!value.active) queueMicrotask(() => drainQueue(sessionID))
         loadQueue(sessionID)
      })),
    ),
    (error) => update((state) => ({ ...state, error: new AppViewModelError("load status", error).message, loading: { ...state.loading, loadingStatus: false } })),
  )

  let queueLoad: { readonly sessionID: string; readonly fiber: Fiber.Fiber<void> } | undefined
  let queueLoadGeneration = 0
  const loadQueue = (sessionID: string): void => {
    if (queueLoad?.sessionID === sessionID) return
    if (queueLoad !== undefined) runner.fork(Fiber.interrupt(queueLoad.fiber))
    const generation = ++queueLoadGeneration
    const fiber = runner.run(json(`/api/sessions/${encodeURIComponent(sessionID)}/queue`, Schema.Array(ApiQueuedPrompt)).pipe(
      Effect.tap((value) => Effect.sync(() => {
        if (registry.get(appStateAtom).selectedID !== sessionID) return
        const queuedPrompts = value.map((item): QueuedPrompt => ({
          id: item.id,
          sessionID,
          text: item.data.text,
          attachments: (item.data.files ?? []).map(({ name }) => ({ id: `${item.id}:${name}`, name, size: 0, content: "" })),
        }))
        update((state) => ({
          ...state,
          queuedPrompts,
          error: state.error?.startsWith("load task queue failed:") ? undefined : state.error,
        }))
      })),
      Effect.ensuring(Effect.sync(() => {
        if (queueLoadGeneration === generation) queueLoad = undefined
      })),
    ),
    (error) => update((state) => ({ ...state, error: new AppViewModelError("load task queue", error).message })))
    queueLoad = { sessionID, fiber }
  }

  let pendingLoadFiber: Fiber.Fiber<void> | undefined
  const loadPending = (selectedDirectory = registry.get(appStateAtom).directory): void => {
    if (selectedDirectory.length === 0) return
    if (pendingLoadFiber !== undefined) runner.fork(Fiber.interrupt(pendingLoadFiber))
    pendingLoadFiber = runner.run(json(`/api/pending?directory=${encodeURIComponent(selectedDirectory)}`, ApiPending).pipe(
      Effect.tap((value) => Effect.sync(() => {
        if (registry.get(appStateAtom).directory !== selectedDirectory) return
        const permissions = value.permissions.map((item): PendingPermission => ({ ...item }))
        const questions = value.questions.map((item): PendingQuestion => ({
          ...item,
          questions: item.questions.map((question): AgentQuestion => ({
            header: question.header ?? "",
            question: question.question,
            options: (question.options ?? []).map((option) => ({ ...option, description: option.description ?? "" })),
            custom: question.custom === true,
            multiple: question.multiple === true,
          })),
        }))
        update((state) => ({ ...state, permissions, questions, questionDrafts: Object.fromEntries(Object.entries(state.questionDrafts).filter(([id]) => questions.some((question) => question.id === id))) }))
      })),
    ), (error) => fail(new AppViewModelError("load pending requests", error)))
  }

  const loadActiveSessions = (): void => run(
    json("/api/sessions/active", Schema.Array(Schema.String)).pipe(Effect.tap((activeSessionIDs) => Effect.sync(() => {
      update((state) => {
        const next = { ...state, activeSessionIDs }
        if (state.selectedID !== undefined) next.busy = activeSessionIDs.includes(state.selectedID)
        return next
      })
    }))),
    (error) => fail(new AppViewModelError("load active sessions", error)),
  )

  const sessionDirectory = (session: Session | undefined, fallback: string): string => session?.projectDirectory ?? fallback

  const selectSession = (sessionID: string): void => {
    const currentState = registry.get(appStateAtom)
    const session = currentState.sessions.find((item) => item.id === sessionID)
    const directory = sessionDirectory(session, currentState.directory)
    if (queueLoad !== undefined) runner.fork(Fiber.interrupt(queueLoad.fiber))
    queueLoad = undefined
    if (directory.length > 0) persistSession(directory, sessionID)
    const model = session?.model
    update((state) => {
      const next = {
       ...state,
       selectedID: sessionID,
       modelProviderKey: model?.providerID ?? state.modelProviderKey,
       modelKey: model?.id !== undefined && model.providerID !== undefined ? `${model.providerID}/${model.id}` : state.modelKey,
       variantKey: model?.variant ?? "",
       agentKey: session?.agent ?? "",
      busy: state.activeSessionIDs.includes(sessionID),
        activity: undefined,
        streamedText: "",
        streamedTextPartPending: false,
        streamedTextPartIdentity: undefined,
        streamedTextRecovery: makeStreamTextRecoveryState(),
        reasoning: "",
      activityHistory: [],
      usage: undefined,
      sessionStatus: undefined,
       messages: [],
       permissions: [],
       questions: [],
       queuedPrompts: [],
       error: undefined,
      }
      if (directory !== state.directory) {
        next.directory = directory
        next.directDirectory = directory
      }
      return next
    })
    loadMessages(sessionID)
    loadSubagents(sessionID)
    loadStatus(sessionID)
    // A session can be selected before the project-level model request
    // finishes. Refresh here so the model picker does not remain disabled.
     if (directory.length > 0) {
       loadModels(directory)
       loadAgents(directory)
       loadPending(directory)
     }
  }

  const toggleFavoriteSession = (sessionID: string): void => {
    update((state) => {
      const favoriteSessionIDs = state.favoriteSessionIDs.includes(sessionID)
        ? state.favoriteSessionIDs.filter((id) => id !== sessionID)
        : [...state.favoriteSessionIDs, sessionID]
      persistFavorite(sessionID, !state.favoriteSessionIDs.includes(sessionID))
      return { ...state, favoriteSessionIDs }
    })
  }

  const parseSession = (session: ApiSession, project?: ProjectOption): Session => {
    const result: MutableSession = {
      id: session.id,
    }
    if (session.parentID !== undefined) result.parentID = session.parentID
    if (session.title !== undefined) result.title = session.title
    if (session.time !== undefined) result.time = session.time
    if (session.model !== undefined) result.model = session.model
    if (session.agent !== undefined) result.agent = session.agent
    if (project !== undefined) {
      result.projectName = project.name
      result.projectDirectory = project.directory
    }
    return result
  }

  const loadSessions = (selectedDirectory: string): void => {
    const showAll = registry.get(appStateAtom).userSettings.showAllSessions === "true"
    const projects = registry.get(appStateAtom).projects
    if (showAll && projects.length > 0) {
      run(Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, sessions: true } }))).pipe(
        Effect.andThen(Effect.forEach(projects, (project) => json(`/api/sessions?directory=${encodeURIComponent(project.directory)}`, ApiSessionList).pipe(
          Effect.map((data) => {
            return data.data.map((item) => parseSession(item, project))
          }),
        ), { concurrency: 4 })),
        Effect.map((groups) => {
          const unique = new Map<string, Session>()
          for (const session of groups.flat()) unique.set(session.id, session)
          return [...unique.values()].sort((left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0))
        }),
        Effect.tap((sessions) => Effect.sync(() => {
          const current = registry.get(appStateAtom)
          if (current.directory !== selectedDirectory) return
          update((state) => ({ ...state, sessions, loading: { ...state.loading, sessions: false } }))
          if (stateHasSession(sessions, savedSessions[selectedDirectory]) && current.selectedID === undefined) selectSession(savedSessions[selectedDirectory]!)
        })),
      ), (error) => update((state) => state.directory === selectedDirectory ? { ...state, error: new AppViewModelError("load sessions", error).message, loading: { ...state.loading, sessions: false } } : state))
      return
    }
    const project = projects.find((item) => item.directory === selectedDirectory)
    run(
    Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, sessions: true } }))).pipe(Effect.andThen(
    json(`/api/sessions?directory=${encodeURIComponent(selectedDirectory)}`, ApiSessionList).pipe(
      Effect.map((data) => {
        return data.data.map((item) => parseSession(item, project))
      }),
      Effect.tap((sessions) => Effect.sync(() => {
         const current = registry.get(appStateAtom)
         if (current.directory !== selectedDirectory) return
         // OpenCode owns the session list. Favorites only affect ordering and
         // decoration for sessions that OpenCode still returns.
         update((state) => ({ ...state, sessions, loading: { ...state.loading, sessions: false } }))
         const savedSessionID = savedSessions[selectedDirectory]
         if (stateHasSession(sessions, savedSessionID) && registry.get(appStateAtom).selectedID === undefined) selectSession(savedSessionID)
       })),
    ))),
    (error) => update((state) => state.directory === selectedDirectory ? { ...state, error: new AppViewModelError("load sessions", error).message, loading: { ...state.loading, sessions: false } } : state),
   )
  }

  const loadModels = (selectedDirectory: string): void => run(
    Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, models: true } }))).pipe(Effect.andThen(
    json(`/api/models?directory=${encodeURIComponent(selectedDirectory)}`, Schema.Array(ApiModel)).pipe(
      Effect.tap((models) => Effect.sync(() => update((state) => state.directory === selectedDirectory ? { ...state, models, loading: { ...state.loading, models: false } } : state))),
    ))),
    (error) => update((state) => state.directory === selectedDirectory ? { ...state, error: new AppViewModelError("load models", error).message, loading: { ...state.loading, models: false } } : state),
  )

  const loadAgents = (selectedDirectory: string): void => run(
    Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, agents: true } }))).pipe(Effect.andThen(
    json(`/api/agents?directory=${encodeURIComponent(selectedDirectory)}`, Schema.Array(ApiAgent)).pipe(
      Effect.map((data) => data.filter((agent) => agent.hidden !== true)),
      Effect.tap((agents) => Effect.sync(() => update((state) => state.directory === selectedDirectory ? { ...state, agents, loading: { ...state.loading, agents: false } } : state))),
    ))),
    (error) => update((state) => state.directory === selectedDirectory ? { ...state, error: new AppViewModelError("load agents", error).message, loading: { ...state.loading, agents: false } } : state),
  )

  const emptyObservabilityPeriod = (): ObservabilityPeriod => ({
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0,
  })

  const loadObservability = (): void => {
    run(Effect.sync(() => update((state) => ({ ...state, loading: { ...state.loading, observability: true } }))).pipe(Effect.andThen(json("/api/observability", ApiObservability).pipe(
      Effect.map((value): ObservabilitySnapshot => {
        const tokens = value.tokens ?? { ...emptyObservabilityPeriod(), total: 0 }
        return {
          available: value.available,
          source: "sqlite",
          warning: value.warning,
          sessions: value.sessions ?? 0,
          primarySessions: value.primarySessions ?? 0,
          subagentSessions: value.subagentSessions ?? 0,
          archivedSessions: value.archivedSessions ?? 0,
          activeSessions: value.activeSessions ?? 0,
          workspaces: value.workspaces ?? 0,
          models: value.models ?? 0,
          agents: value.agents ?? 0,
          tokens,
          today: value.today ?? emptyObservabilityPeriod(),
          lastWeek: value.lastWeek ?? emptyObservabilityPeriod(),
          lastMonth: value.lastMonth ?? emptyObservabilityPeriod(),
          daily: value.daily ?? [],
          topModels: value.topModels ?? [],
          topAgents: value.topAgents ?? [],
          topWorkspaces: value.topWorkspaces ?? [],
          databaseBytes: value.databaseBytes ?? 0,
          generatedAt: value.generatedAt,
        }
      }),
      Effect.tap((snapshot) => Effect.sync(() => update((state) => ({ ...state, observability: snapshot, loading: { ...state.loading, observability: false } })))),
    ))), (error) => update((state) => ({ ...state, error: new AppViewModelError("load observability", error).message, loading: { ...state.loading, observability: false } })))
  }

  const selectProject = (selectedDirectory: string): void => {
    if (selectedDirectory.length > 0) persistProject(selectedDirectory)
    update((state) => ({ ...state, directory: selectedDirectory, directDirectory: selectedDirectory, selectedID: undefined, sessions: [], subagents: [], messages: [], hasOlderMessages: false, olderMessageCursor: undefined, modelProviderKey: "", modelKey: "", variantKey: "", agentKey: "", busy: false, queuedPrompts: [], permissions: [], questions: [], error: undefined, agentPickerOpen: false }))
    loadModels(selectedDirectory)
    loadAgents(selectedDirectory)
    loadSessions(selectedDirectory)
    loadPending(selectedDirectory)
    loadActiveSessions()
  }

  const createSession = (): void => {
    const currentState = registry.get(appStateAtom)
    const directory = currentState.directory
    if (directory.length === 0 || currentState.loading.creatingSession) return
    update((state) => ({ ...state, error: undefined, loading: { ...state.loading, creatingSession: true } }))
    run(json("/api/sessions", ApiSession, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    }).pipe(
      Effect.map((value): Session | undefined => {
        return value
      }),
      Effect.filterOrFail(
        (session): session is Session => session !== undefined,
        () => new AppViewModelError("create session", "invalid response"),
      ),
      Effect.tap((session) => Effect.sync(() => {
        update((state) => ({ ...state, sessions: [session, ...state.sessions], loading: { ...state.loading, creatingSession: false } }))
        selectSession(session.id)
      })),
    ), (error) => update((state) => ({ ...state, error: new AppViewModelError("create session", error).message, loading: { ...state.loading, creatingSession: false } })))
  }

  const selectAgent = (agent: string): void => {
    const state = registry.get(appStateAtom)
    const sessionID = state.selectedID
    if (sessionID === undefined || agent.length === 0 || state.loading.switchingAgent) return
    update((current) => ({ ...current, error: undefined, loading: { ...current.loading, switchingAgent: true } }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/agent`, ApiOkResponse, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }) }).pipe(
      Effect.tap(() => Effect.sync(() => update((current) => current.selectedID === sessionID
        ? { ...current, agentKey: agent, agentPickerOpen: false, loading: { ...current.loading, switchingAgent: false } }
        : { ...current, loading: { ...current.loading, switchingAgent: false } }))),
    ), (error) => update((current) => ({ ...current, error: new AppViewModelError("switch agent", error).message, loading: { ...current.loading, switchingAgent: false } })))
  }

  const selectModel = (key: string): void => {
    const state = registry.get(appStateAtom)
    const model = state.models.find((item) => `${item.providerID}/${item.id}` === key)
    if (state.selectedID === undefined || model === undefined || state.loading.switchingModel || state.loading.switchingVariant) return
    const sessionID = state.selectedID
    update((current) => ({ ...current, error: undefined, loading: { ...current.loading, switchingModel: true } }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/model`, ApiOkResponse, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: model.id, providerID: model.providerID }) }).pipe(
      Effect.tap(() => Effect.sync(() => update((current) => current.selectedID === sessionID
        ? { ...current, modelProviderKey: model.providerID, modelKey: key, variantKey: "", loading: { ...current.loading, switchingModel: false } }
        : { ...current, loading: { ...current.loading, switchingModel: false } }))),
    ), (error) => update((current) => ({ ...current, error: new AppViewModelError("switch model", error).message, loading: { ...current.loading, switchingModel: false } })))
  }

  const selectVariant = (variant: string): void => {
    const state = registry.get(appStateAtom)
    const model = state.models.find((item) => `${item.providerID}/${item.id}` === state.modelKey)
    if (state.selectedID === undefined || model === undefined || state.loading.switchingModel || state.loading.switchingVariant) return
    if (variant.length > 0 && !(model.variants ?? []).some((item) => item.id === variant)) return
    const sessionID = state.selectedID
    update((current) => ({ ...current, error: undefined, loading: { ...current.loading, switchingVariant: true } }))
    const body: ModelRequest = { id: model.id, providerID: model.providerID }
    const requestBody: ModelRequest = variant.length > 0 ? { ...body, variant } : body
    const request = json(`/api/sessions/${encodeURIComponent(sessionID)}/model`, ApiOkResponse, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }).pipe(
      Effect.tap(() => Effect.sync(() => update((current) => ({
        ...current,
        variantKey: current.selectedID === sessionID ? variant : current.variantKey,
        loading: { ...current.loading, switchingVariant: false },
      })))),
    )
    run(request, (error) => update((current) => ({ ...current, error: new AppViewModelError("switch variant", error).message, loading: { ...current.loading, switchingVariant: false } })))
  }

  const cycleVariant = (): void => {
    const state = registry.get(appStateAtom)
    const model = state.models.find((item) => `${item.providerID}/${item.id}` === state.modelKey)
    const variants = model?.variants ?? []
    if (state.selectedID === undefined || model === undefined || variants.length === 0 || state.loading.switchingModel || state.loading.switchingVariant) return
    const next = variants[(variants.findIndex((variant) => variant.id === state.variantKey) + 1) % variants.length]
    if (next === undefined) return
    selectVariant(next.id)
  }

  const cycleAgent = (): void => {
    const state = registry.get(appStateAtom)
    const availableAgents = state.agents.filter((agent) => agent.hidden !== true && agent.mode !== "subagent")
    if (state.selectedID === undefined || availableAgents.length === 0 || state.loading.switchingAgent) return
    const currentIndex = availableAgents.findIndex((agent) => agent.id === state.agentKey)
    const next = availableAgents[(currentIndex + 1) % availableAgents.length]
    if (next !== undefined) selectAgent(next.id)
  }

  const sendPrompt = (sessionID: string, prompt: QueuedPrompt, delivery: "auto" | "queue" = "auto"): void => {
    const wasBusy = registry.get(appStateAtom).busy
    const shouldQueue = delivery === "queue" || wasBusy
    update((current) => ({
      ...current,
      busy: true,
      activity: shouldQueue ? "Queueing prompt" : "Sending prompt",
      streamedText: wasBusy ? current.streamedText : "",
      streamedTextPartPending: wasBusy ? current.streamedTextPartPending : false,
      streamedTextPartIdentity: wasBusy ? current.streamedTextPartIdentity : undefined,
      streamedTextRecovery: wasBusy ? current.streamedTextRecovery : makeStreamTextRecoveryState(),
      reasoning: wasBusy ? current.reasoning : "",
      activityHistory: wasBusy ? current.activityHistory : [],
      error: undefined,
      messages: shouldQueue ? current.messages : [...current.messages, { role: "user", text: prompt.text || `[${prompt.attachments.length} attachment${prompt.attachments.length === 1 ? "" : "s"}]` }],
      queuedPrompts: shouldQueue && !current.queuedPrompts.some((item) => item.id === prompt.id) ? [...current.queuedPrompts, prompt] : current.queuedPrompts,
    }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/prompt`, ApiPromptResult, {
      method: "POST",
      headers: { "content-type": "application/json" },
       body: JSON.stringify({ text: prompt.text, delivery: shouldQueue ? "queue" : "steer", attachments: prompt.attachments.map(({ name, content }) => ({ name, content })) }),
    }).pipe(
      Effect.tap((value) => Effect.sync(() => {
         const queued = value.queued
         const pendingID = value.id
        update((current) => {
          const hasPrompt = current.queuedPrompts.some((item) => item.id === prompt.id)
          let queuedPrompts = current.queuedPrompts.filter((item) => item.id !== prompt.id)
          if (queued && hasPrompt) queuedPrompts = current.queuedPrompts.map((item) => item.id === prompt.id ? { ...item, id: pendingID } : item)
          else if (queued) queuedPrompts = [...current.queuedPrompts, { ...prompt, id: pendingID }]
          return {
            ...current,
            activity: queued ? "Queued" : current.activity,
            queuedPrompts,
          }
        })
      })),
    ), (error) => {
      const failure = new AppViewModelError("send prompt", error)
      update((current) => retainPromptEvidenceAfterFailure(current, failure.message))
      loadStatus(sessionID)
      loadQueue(sessionID)
    })
  }

  const drainQueue = (sessionID: string): void => loadQueue(sessionID)

  const submit = (delivery: "auto" | "queue" = "auto"): void => {
    const state = registry.get(appStateAtom)
    const prompt = state.text.trim()
    if (state.selectedID === undefined || (prompt.length === 0 && state.attachments.length === 0)) return
    const item: QueuedPrompt = { id: localIdentifier("prompt"), sessionID: state.selectedID, text: prompt, attachments: state.attachments }
    update((current) => ({ ...current, text: "", attachments: [], error: undefined }))
    const sessionID = state.selectedID
    if (delivery === "queue" || state.busy) update((current) => ({ ...current, queuedPrompts: [...current.queuedPrompts, item] }))
    sendPrompt(sessionID, item, delivery)
  }

  const interrupt = (): void => {
    const state = registry.get(appStateAtom)
    if (state.selectedID === undefined || state.loading.interrupting) return
    const sessionID = state.selectedID
    update((current) => ({ ...current, loading: { ...current.loading, interrupting: true }, error: undefined }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/interrupt`, ApiOkResponse, { method: "POST" }).pipe(
      Effect.andThen(json(`/api/sessions/${encodeURIComponent(sessionID)}/queue`, ApiOkResponse, { method: "DELETE" })),
      Effect.tap(() => Effect.sync(() => update((current) => ({ ...current, busy: false, activity: "Interrupted", queuedPrompts: current.queuedPrompts.filter((item) => item.sessionID !== sessionID), loading: { ...current.loading, interrupting: false } })))),
    ), (error) => update((current) => ({ ...current, error: new AppViewModelError("stop run", error).message, loading: { ...current.loading, interrupting: false } })))
  }

  const compact = (): void => {
    const state = registry.get(appStateAtom)
    if (state.selectedID === undefined || state.loading.compacting) return
    const sessionID = state.selectedID
    update((current) => ({ ...current, loading: { ...current.loading, compacting: true }, error: undefined }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/compact`, ApiOkResponse, { method: "POST" }).pipe(
      Effect.tap(() => Effect.sync(() => {
        update((current) => ({ ...current, activity: "Compaction requested", loading: { ...current.loading, compacting: false } }))
        loadStatus(sessionID)
      })),
    ), (error) => update((current) => ({ ...current, error: new AppViewModelError("compact session", error).message, loading: { ...current.loading, compacting: false } })))
  }

  const confirmRevert = (): void => {
    const state = registry.get(appStateAtom)
    const messageID = state.revertTarget?.id
    const sessionID = state.selectedID
    if (messageID === undefined || sessionID === undefined || state.busy || state.loading.reverting) return
    update((current) => ({ ...current, error: undefined, loading: { ...current.loading, reverting: true } }))
    run(json(`/api/sessions/${encodeURIComponent(sessionID)}/revert`, ApiOkResponse, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageID }),
    }).pipe(Effect.tap(() => Effect.sync(() => {
      update((current) => ({ ...current, revertTarget: undefined, streamedText: "", streamedTextPartPending: false, streamedTextPartIdentity: undefined, streamedTextRecovery: makeStreamTextRecoveryState(), reasoning: "", activity: "Revert completed", loading: { ...current.loading, reverting: false } }))
      loadMessages(sessionID)
      loadStatus(sessionID)
    }))), (error) => update((current) => ({ ...current, error: new AppViewModelError("revert session", error).message, loading: { ...current.loading, reverting: false } })))
  }

  const replyPermission = (permission: PendingPermission, reply: "once" | "always" | "reject"): void => {
    update((state) => ({ ...state, loading: { ...state.loading, replying: true }, error: undefined }))
    run(json(`/api/sessions/${encodeURIComponent(permission.sessionID)}/permissions/${encodeURIComponent(permission.id)}`, ApiOkResponse, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply }),
    }).pipe(Effect.tap(() => Effect.sync(() => {
      update((state) => ({ ...state, permissions: state.permissions.filter((item) => item.id !== permission.id), loading: { ...state.loading, replying: false } }))
    }))), (error) => update((state) => ({ ...state, error: new AppViewModelError("reply to permission", error).message, loading: { ...state.loading, replying: false } })))
  }

  const setQuestionAnswer = (requestID: string, questionIndex: number, answers: readonly string[]): void => update((state) => {
    const current = state.questionDrafts[requestID] ?? []
    const next = [...current]
    next[questionIndex] = answers
    return { ...state, questionDrafts: { ...state.questionDrafts, [requestID]: next } }
  })

  const replyQuestion = (request: PendingQuestion): void => {
    const answers = registry.get(appStateAtom).questionDrafts[request.id] ?? request.questions.map(() => [])
    update((state) => ({ ...state, loading: { ...state.loading, replying: true }, error: undefined }))
    run(json(`/api/sessions/${encodeURIComponent(request.sessionID)}/questions/${encodeURIComponent(request.id)}`, ApiOkResponse, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }),
    }).pipe(Effect.tap(() => Effect.sync(() => update((state) => ({ ...state, questions: state.questions.filter((item) => item.id !== request.id), loading: { ...state.loading, replying: false } }))))),
    (error) => update((state) => ({ ...state, error: new AppViewModelError("answer question", error).message, loading: { ...state.loading, replying: false } })))
  }

  const addAttachments = (files: FileList | readonly File[]): void => {
    const existing = registry.get(appStateAtom).attachments
    const available = Math.max(0, 8 - existing.length)
    const selected = Array.from(files).slice(0, available)
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) {
      update((state) => ({ ...state, error: "Each attachment must be 10 MB or smaller." }))
      return
    }
    const attachments = Effect.forEach(selected, (file) =>
      Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (cause) => cause,
      }).pipe(
        Effect.map((buffer) => {
          const bytes = new Uint8Array(buffer)
          let binary = ""
          for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
          return { id: localIdentifier("attachment"), name: file.name, size: file.size, content: btoa(binary) }
        }),
      ),
    )
    run(attachments.pipe(
      Effect.tap((items) => Effect.sync(() => update((state) => ({ ...state, attachments: [...state.attachments, ...items], error: undefined })))),
      Effect.mapError((cause) => new AppViewModelError("read attachments", cause)),
    ), fail)
  }

  const submitReview = (): void => {
    const focus = registry.get(appStateAtom).reviewFocus.trim()
    update((state) => ({ ...state, text: focus.length === 0
      ? "Review the current changes in this repository. Report bugs, security issues, and missing tests."
      : `Review the current changes in this repository, with focus on: ${focus}`, agentPickerOpen: false }))
    queueMicrotask(submit)
  }

  const mount = (): (() => void) => {
    let savedProject: string | undefined
    let projects: readonly ProjectOption[] = []
    let preferencesReady = false
    const restoreProject = (): void => {
      if (!preferencesReady || registry.get(appStateAtom).directory.length > 0) return
      const project = projects.find((item) => item.directory === savedProject)
      if (project !== undefined) selectProject(project.directory)
    }
    update((state) => ({ ...state, loading: { ...state.loading, preferences: true, projects: true } }))
    run(json("/api/preferences", ApiPreferences).pipe(
      Effect.tap((value) => Effect.sync(() => {
        savedProject = value.lastProject
        savedSessions = value.lastSessions ?? {}
        const favorites = value.favoriteSessionIDs ?? []
        const settings = value.settings ?? {}
        const savedTheme = settings.theme === "light" || settings.theme === "dark" ? settings.theme : undefined
        let savedThemeFamily: ThemeFamily | undefined
        if (isThemeFamily(settings.themeFamily)) savedThemeFamily = settings.themeFamily
        else if (settings.themeFamily === "sakura") savedThemeFamily = "spring"
        preferencesReady = true
        update((state) => {
          const next = { ...state, favoriteSessionIDs: favorites, userSettings: settings, loading: { ...state.loading, preferences: false } }
          if (savedTheme !== undefined) next.theme = savedTheme
          if (savedThemeFamily !== undefined) next.themeFamily = savedThemeFamily
          return next
        })
        restoreProject()
      })),
    ), (error) => update((state) => ({ ...state, error: new AppViewModelError("load web preferences", error).message, loading: { ...state.loading, preferences: false } })))
    run(json("/api/projects", Schema.Array(ApiProject)).pipe(
      Effect.map((data) => {
        const unique = new Map<string, ProjectOption>()
        for (const project of data) unique.set(project.directory, project)
        return [...unique.values()]
      }),
       Effect.tap((loadedProjects) => Effect.sync(() => {
         projects = loadedProjects
         update((state) => ({ ...state, projects: loadedProjects, loading: { ...state.loading, projects: false } }))
         restoreProject()
       })),
    ), (error) => update((state) => ({ ...state, error: new AppViewModelError("load projects", error).message, loading: { ...state.loading, projects: false } })))
    const pollingFiber = runner.fork(Effect.forever(Effect.sleep("2 seconds").pipe(
      Effect.andThen(Effect.sync(() => {
        const directory = registry.get(appStateAtom).directory
        if (directory.length > 0) {
          loadPending(directory)
          loadActiveSessions()
          const state = registry.get(appStateAtom)
          if (state.selectedID !== undefined && (state.busy || state.queuedPrompts.some((prompt) => prompt.sessionID === state.selectedID))) loadQueue(state.selectedID)
        }
      })),
    )))
    const handleEventOpen = (): void => {
      update((state) => ({ ...state, connection: "connected" }))
      // Reconcile state after a reconnect. SSE is deliberately lossy while
      // the browser is offline, so the terminal event may have been missed.
      loadActiveSessions()
      const selectedID = registry.get(appStateAtom).selectedID
      const directory = registry.get(appStateAtom).directory
      if (selectedID !== undefined) {
        loadMessages(selectedID)
        loadStatus(selectedID)
      }
      if (directory.length > 0) loadPending(directory)
    }
    const handleServerEvent = (payload: ApiEvent): void => {
      const { data, type } = payload
      const sessionID = eventSessionID(payload)
      if (type === "permission.asked") loadPending()
      if (type === "question.asked" || type === "form.created") {
        // Question requests are ephemeral. The list endpoint can lag the event,
        // so render the request from the event payload first.
        const request = Schema.decodeUnknownOption(ApiPendingQuestion)(data)
        const pending = request._tag === "Some" ? request.value : undefined
        if (pending !== undefined && pending.sessionID === registry.get(appStateAtom).selectedID) {
          update((state) => ({
            ...state,
            questions: [...state.questions.filter((item) => item.id !== pending.id), pendingQuestion(pending)],
            questionDrafts: { ...state.questionDrafts, [pending.id]: pending.questions.map(() => []) },
          }))
        } else {
          loadPending()
        }
      }
      if (sessionID !== undefined && type === "session.execution.started") update((state) => ({ ...state, activeSessionIDs: state.activeSessionIDs.includes(sessionID) ? state.activeSessionIDs : [...state.activeSessionIDs, sessionID] }))
      if (sessionID !== undefined && (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted" || type === "session.deleted")) update((state) => ({ ...state, activeSessionIDs: state.activeSessionIDs.filter((id) => id !== sessionID) }))
      if (sessionID === undefined || sessionID !== registry.get(appStateAtom).selectedID) return
      if (type === "session.text.started") update((state) => {
        const identity = eventTextPartIdentity(data)
        const stream = beginStreamTextPart({ text: state.streamedText, startsNewPart: state.streamedTextPartPending, activePartIdentity: state.streamedTextPartIdentity }, identity)
        return {
          ...state,
          streamedText: stream.text,
          streamedTextPartPending: stream.startsNewPart,
          streamedTextPartIdentity: stream.activePartIdentity,
          streamedTextRecovery: beginStreamTextRecoveryPart(state.streamedTextRecovery, identity),
        }
      })
      if (type === "session.text.delta" && data.delta !== undefined) {
        update((state) => {
          const delta = data.delta ?? ""
          const stream = appendStreamTextDelta(
            { text: state.streamedText, startsNewPart: state.streamedTextPartPending, activePartIdentity: state.streamedTextPartIdentity },
            delta,
            eventTextPartIdentity(data),
          )
          return {
            ...state,
            streamedText: stream.text,
            streamedTextPartPending: stream.startsNewPart,
            streamedTextPartIdentity: stream.activePartIdentity,
            streamedTextRecovery: appendStreamTextRecoveryDelta(state.streamedTextRecovery, delta, eventTextPartIdentity(data)),
            activity: "Writing response",
          }
        })
        return
      }
      if (type === "session.reasoning.delta" && data.delta !== undefined) {
        update((state) => ({ ...state, reasoning: state.reasoning + data.delta, activity: "Thinking" }))
        return
      }
      if (type === "session.usage.updated") {
        const tokens = data.tokens
        update((state) => ({ ...state, usage: {
          cost: data.cost,
          input: tokens?.input ?? 0,
          output: tokens?.output ?? 0,
          reasoning: tokens?.reasoning ?? 0,
        } }))
        return
      }
      const activity = type === "session.tool.called"
        ? `Using ${data.tool ?? data.name ?? data.id ?? "tool"}`
        : activityForEvent(type)
      if (activity !== undefined) update((state) => ({
        ...state,
        activity,
        activityHistory: state.activityHistory.at(-1) === activity ? state.activityHistory : [...state.activityHistory, activity],
        busy: type === "session.execution.started" ? true : state.busy,
      }))
      if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted" || type === "session.deleted") {
        let label = "Run failed"
        if (type === "session.execution.succeeded") label = "Completed"
        else if (type === "session.execution.interrupted") label = "Interrupted"
        update((state) => ({ ...state, busy: false, activity: label, streamedText: "", streamedTextPartPending: false, streamedTextPartIdentity: undefined, streamedTextRecovery: makeStreamTextRecoveryState(), reasoning: "", activityHistory: [] }))
        loadMessages(sessionID)
        loadStatus(sessionID)
        loadPending()
        queueMicrotask(() => drainQueue(sessionID))
      }
    }
    let eventsFiber: Fiber.Fiber<void> | undefined
    const connectEvents = (): void => {
      if (eventsFiber !== undefined) runner.fork(Fiber.interrupt(eventsFiber))
      const connectLoop: Effect.Effect<void, never, WebApiClient> = Effect.suspend(() => {
        update((state) => ({ ...state, streamedTextPartPending: false, streamedTextRecovery: restartStreamTextRecovery(state.streamedTextRecovery) }))
        return eventSourceSignals().pipe(
          Stream.runForEach((signal) => Effect.sync(() => {
            if (signal._tag === "Open") handleEventOpen()
            if (signal._tag === "Message") handleServerEvent(signal.event)
          })),
          Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => update((state) => ({ ...state, connection: "reconnecting" }))).pipe(
                Effect.andThen(Effect.logError("web event stream failed", Cause.pretty(cause))),
              )),
          Effect.andThen(Effect.sleep("5 seconds")),
          Effect.andThen(refreshAccessToken),
          Effect.flatMap((refreshed) => refreshed
            ? Effect.suspend(() => connectLoop)
            : Effect.sync(() => update((state) => ({ ...state, connection: "disconnected" })))),
        )
      })
      eventsFiber = runner.fork(connectLoop)
    }
    connectEvents()
    reconnectEvents = () => {
      update((state) => ({ ...state, connection: "reconnecting" }))
      connectEvents()
    }
    return () => {
      reconnectEvents = undefined
      runner.fork(Fiber.interrupt(pollingFiber))
      if (eventsFiber !== undefined) runner.fork(Fiber.interrupt(eventsFiber))
      if (queueLoad !== undefined) runner.fork(Fiber.interrupt(queueLoad.fiber))
      if (pendingLoadFiber !== undefined) runner.fork(Fiber.interrupt(pendingLoadFiber))
    }
  }

  return {
    state: () => registry.get(appStateAtom), update, loadMessages, loadOlderMessages, loadStatus, loadPending, loadActiveSessions, loadObservability, selectSession, selectProject,
    createSession, selectAgent, selectModel, selectVariant, cycleVariant, cycleAgent, submit, queuePrompt: () => submit("queue"), interrupt, compact, confirmRevert, replyPermission, replyQuestion,
    selectModelProvider: (modelProviderKey: string) => update((state) => ({ ...state, modelProviderKey })),
    toggleFavoriteSession,
    setQuestionAnswer, addAttachments, submitReview, mount,
    reconnect: () => reconnectEvents?.(),
    removeAttachment: (id: string) => update((state) => ({ ...state, attachments: state.attachments.filter((item) => item.id !== id) })),
    removeQueuedPrompt: (id: string) => {
      const state = registry.get(appStateAtom)
      const item = state.queuedPrompts.find((prompt) => prompt.id === id)
      if (item === undefined) return
      run(json(`/api/sessions/${encodeURIComponent(item.sessionID)}/queue/${encodeURIComponent(id)}`, ApiOkResponse, { method: "DELETE" }).pipe(
        Effect.tap(() => Effect.sync(() => update((current) => ({ ...current, queuedPrompts: current.queuedPrompts.filter((prompt) => prompt.id !== id) }))),
      )), (error) => fail(new AppViewModelError("remove queued prompt", error)))
    },
    setText: (text: string) => update((state) => ({ ...state, text })),
    setDirectDirectory: (directDirectory: string) => update((state) => ({ ...state, directDirectory })),
    applyDirectDirectory: () => { const value = registry.get(appStateAtom).directDirectory.trim(); if (value.length > 0) selectProject(value) },
    setDirectSessionID: (directSessionID: string) => update((state) => ({ ...state, directSessionID })),
    applyDirectSessionID: () => { const value = registry.get(appStateAtom).directSessionID.trim(); if (value.length > 0) { selectSession(value); update((state) => ({ ...state, agentPickerOpen: false })) } },
    setReviewFocus: (reviewFocus: string) => update((state) => ({ ...state, reviewFocus })),
    openPicker: (pickerMode: AppState["pickerMode"] = "command") => update((state) => {
      const next = { ...state, pickerMode, agentPickerOpen: true }
      if (pickerMode === "model" && state.modelProviderKey.length === 0) next.modelProviderKey = state.models.find((model) => `${model.providerID}/${model.id}` === state.modelKey)?.providerID ?? state.models[0]?.providerID ?? ""
      return next
    }),
    closePicker: () => update((state) => ({ ...state, agentPickerOpen: false })),
    requestRevert: (message: ChatMessage) => update((state) => ({ ...state, revertTarget: message })),
    closeRevert: () => update((state) => state.loading.reverting ? state : ({ ...state, revertTarget: undefined })),
    clearError: () => update((state) => ({ ...state, error: undefined })),
    toggleTheme: () => update((state) => {
      const theme = state.theme === "light" ? "dark" : "light"
      persistSetting("theme", theme)
      return { ...state, theme, userSettings: { ...state.userSettings, theme } }
    }),
    setTheme: (theme: "light" | "dark") => {
      persistSetting("theme", theme)
      update((state) => ({ ...state, theme, userSettings: { ...state.userSettings, theme } }))
    },
    toggleThemeFamily: () => update((state) => {
      const themeFamily = nextThemeFamily(state.themeFamily)
      persistSetting("themeFamily", themeFamily)
      return { ...state, themeFamily, userSettings: { ...state.userSettings, themeFamily } }
    }),
    setThemeFamily: (themeFamily: ThemeFamily) => {
      persistSetting("themeFamily", themeFamily)
      update((state) => ({ ...state, themeFamily, userSettings: { ...state.userSettings, themeFamily } }))
    },
     setUserSetting: (key: string, value: string) => {
       persistSetting(key, value, () => {
         update((state) => ({ ...state, userSettings: { ...state.userSettings, [key]: value } }))
         if (key === "showAllSessions") {
           const directory = registry.get(appStateAtom).directory
           if (directory.length > 0) loadSessions(directory)
         }
       })
     },
  }
}
