import { Buffer } from "node:buffer"
import { Context, Data, Effect, Layer, Option, Stream } from "effect"
import {
  OpenCode as Client,
  type AgentInfo,
  type FormAnswer,
  type FormInfo,
  type FormInfo1,
  type ModelInfo,
  type OpenCodeEvent,
  type PermissionReply,
  type PermissionRequest,
  type Project,
  type SessionInboxInfo,
  type SessionInboxUser,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode-ai/client"
import { Service, type Endpoint } from "@opencode-ai/client/service"
import { AppConfigTag, type AppConfig } from "../config.js"
import type { PromptFileInput } from "./attachments.js"
import { logBoundary } from "./logging.js"

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export interface AgentQuestionOption {
  readonly label: string
  readonly description: string
}

export interface AgentQuestion {
  readonly header: string
  readonly question: string
  readonly options: readonly AgentQuestionOption[]
  readonly custom?: boolean
  readonly multiple?: boolean
}

/** A question request normalized from a V2 form. */
export interface PendingQuestionRequest {
  readonly id: string
  readonly sessionID: string
  readonly questions: readonly AgentQuestion[]
}

type ProjectDirectorySource = {
  readonly canonical: string
  readonly sandboxes: readonly string[]
}

/** Read the canonical checkout and current sandboxes from the V2 project payload. */
export const projectDirectories = (
  project: ProjectDirectorySource,
): readonly { readonly directory: string; readonly strategy: string }[] => [
  { directory: project.canonical, strategy: "canonical" },
  ...project.sandboxes.map((directory) => ({ directory, strategy: "sandbox" })),
]

type QuestionForm = FormInfo | FormInfo1

const isQuestionForm = (form: QuestionForm): boolean => form.metadata?.kind === "question"

/** Convert the form emitted by OpenCode's question tool into the existing question view model. */
export const questionRequestFromForm = (form: QuestionForm): PendingQuestionRequest | undefined => {
  if (!isQuestionForm(form)) return undefined
  const questions = form.fields.flatMap((field): readonly AgentQuestion[] => {
    if (field.type !== "string" && field.type !== "multiselect") return []
    const options = (field.options ?? []).map((option) => ({
      label: option.label,
      description: option.description ?? "",
    }))
    return [{
      header: field.title ?? "",
      question: field.description ?? field.title ?? form.title,
      options,
      custom: field.custom ?? options.length === 0,
      multiple: field.type === "multiselect",
    }]
  })
  return questions.length === 0 ? undefined : { id: form.id, sessionID: form.sessionID, questions }
}

/** Extract a normalized question request from an OpenCode event. */
export const questionRequestFromEvent = (event: OpenCodeEvent): PendingQuestionRequest | undefined => {
  switch (event.type) {
    case "form.created":
      return questionRequestFromForm(event.data.form)
    default:
      return undefined
  }
}

/** Convert UI question answers back to the keyed values expected by a V2 form. */
export const questionFormAnswer = (
  form: QuestionForm,
  answers: ReadonlyArray<readonly string[]>,
): FormAnswer => {
  const answer: FormAnswer = {}
  let answerIndex = 0
  for (const field of form.fields) {
    if (field.type !== "string" && field.type !== "multiselect") continue
    const selected = answers[answerIndex] ?? []
    const values = selected.map((label) =>
      field.options?.find((option) => option.label === label)?.value ?? label
    )
    answer[field.key] = field.type === "multiselect" ? values : (values[0] ?? "")
    answerIndex += 1
  }
  return answer
}

export interface OpenCodeService {
  readonly createSession: (directory: string) => Effect.Effect<SessionInfo, OpenCodeError>
  readonly getSession: (sessionID: string) => Effect.Effect<SessionInfo, OpenCodeError>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly files?: readonly PromptFileInput[]
    readonly delivery?: "steer" | "queue"
  }) => Effect.Effect<SessionInboxUser, OpenCodeError>
  readonly listPending: (sessionID: string) => Effect.Effect<readonly SessionInboxInfo[], OpenCodeError>
  readonly cancelPending: (input: { readonly sessionID: string; readonly inputID: string }) => Effect.Effect<void, OpenCodeError>
  readonly interrupt: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly wait: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly activeSessions: () => Effect.Effect<readonly string[], OpenCodeError>
  readonly compact: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly revert: (input: { readonly sessionID: string; readonly messageID: string }) => Effect.Effect<void, OpenCodeError>
  readonly listSessions: (input: { readonly directory?: string; readonly cursor?: string; readonly limit?: number; readonly order?: "asc" | "desc" }) =>
    Effect.Effect<{
      readonly data: readonly SessionInfo[]
      readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
    }, OpenCodeError>
  readonly listMessages: (input: { readonly sessionID: string; readonly limit?: number; readonly cursor?: string; readonly order?: "asc" | "desc" }) =>
    Effect.Effect<{ readonly data: readonly SessionMessageInfo[]; readonly cursor: { readonly previous?: string | null; readonly next?: string | null } }, OpenCodeError>
  readonly listProjects: () => Effect.Effect<readonly Project[], OpenCodeError>
  readonly listProjectDirectories: (project: ProjectDirectorySource) =>
    Effect.Effect<readonly { readonly directory: string; readonly strategy?: string }[], OpenCodeError>
  readonly listPendingPermissions: (directory: string) => Effect.Effect<readonly PermissionRequest[], OpenCodeError>
  readonly listPendingQuestions: (directory: string) => Effect.Effect<readonly PendingQuestionRequest[], OpenCodeError>
  readonly replyPermission: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly reply: PermissionReply
  }) => Effect.Effect<void, OpenCodeError>
  readonly listModels: (directory: string) => Effect.Effect<readonly ModelInfo[], OpenCodeError>
  readonly listAgents: (directory: string) => Effect.Effect<readonly AgentInfo[], OpenCodeError>
  readonly switchAgent: (input: { readonly sessionID: string; readonly agent: string }) => Effect.Effect<void, OpenCodeError>
  readonly switchModel: (input: {
    readonly sessionID: string
    readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }) => Effect.Effect<void, OpenCodeError>
  readonly replyQuestion: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly answers: ReadonlyArray<readonly string[]>
  }) => Effect.Effect<void, OpenCodeError>
  readonly events: () => Stream.Stream<OpenCodeEvent, OpenCodeError>
}

export class OpenCode extends Context.Service<OpenCode, OpenCodeService>()("opencode2-uis/OpenCode") {}

/** Safety bound for climbing a session tree; subagent trees are shallow. */
export const ROOT_SESSION_CLIMB_LIMIT = 10

/**
 * Walk a session tree up to its root. Subagent (child) sessions carry a
 * parentID; the root is the session a Telegram run started. Best-effort:
 * a session without a parent, or the climb limit, resolve to the input.
 */
export const rootSessionID = (
  opencode: Pick<OpenCodeService, "getSession">,
  sessionID: string,
): Effect.Effect<string, OpenCodeError> => {
  const climb = (current: string, depth: number): Effect.Effect<string, OpenCodeError> =>
    depth >= ROOT_SESSION_CLIMB_LIMIT
      ? Effect.succeed(current)
      : opencode.getSession(current).pipe(
          Effect.flatMap((session) =>
            session.parentID === undefined
              ? Effect.succeed(current)
              : climb(session.parentID, depth + 1),
          ),
        )
  return climb(sessionID, 0)
}

/**
 * Log the failure at the client boundary, then preserve the original
 * typed failure wrapped in `OpenCodeError`.
 */
const wrap = (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OpenCodeError, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        logBoundary("core/opencode", "opencode-client", `opencode ${operation} failed`)(cause).pipe(
          Effect.andThen(Effect.failCause(cause)),
        ),
      ),
      Effect.mapError((cause) => new OpenCodeError({ operation, cause })),
    )

const fromPromise = <A>(
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, OpenCodeError> =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(wrap(operation))

const basicHeader = (username: string, password: string) =>
  "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64")

interface ResolvedEndpoint {
  readonly baseUrl: string
  readonly authorization: Option.Option<string>
}

/** Local service discovery is only needed to choose an endpoint. */
export const shouldDiscoverOpenCodeService = (baseUrl: string | undefined): boolean => baseUrl === undefined

/** Convert a host/port endpoint into the absolute HTTP URL required by the client. */
export const normalizeBaseUrl = (value: string): Effect.Effect<string, OpenCodeError> =>
  Effect.try({
    try: () => {
      const trimmed = value.trim()
      const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `http://${trimmed}`
      const parsed = new URL(candidate)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`unsupported protocol ${parsed.protocol}`)
      }
      return parsed.toString().replace(/\/$/, "")
    },
    catch: (cause) => new OpenCodeError({ operation: "endpoint.url", cause }),
  })

const resolveEndpoint = (): Effect.Effect<ResolvedEndpoint, OpenCodeError, AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    // An explicit endpoint is authoritative. Discovery may supply credentials
    // only when it identifies that exact endpoint; it never replaces the URL.
    const hasConfiguredAuth = config.opencodeUsername !== undefined && config.opencodePassword !== undefined
    let discovered: Endpoint | undefined
    if (shouldDiscoverOpenCodeService(config.opencodeBaseUrl)) {
      discovered = yield* fromPromise(
        "service.ensure",
        () => Service.ensure({ command: ["opencode2", "serve", "--service"] }),
      )
    } else if (!hasConfiguredAuth) {
      discovered = yield* fromPromise("service.discover", () => Service.discover())
    }
    const rawBaseUrl = config.opencodeBaseUrl ?? discovered?.url
    if (rawBaseUrl === undefined) {
      return yield* Effect.fail(
        new OpenCodeError({
          operation: "discover",
          cause: new Error("no opencode endpoint: set OPENCODE_BASE_URL or start the local service"),
        }),
      )
    }
    const baseUrl = yield* normalizeBaseUrl(rawBaseUrl)
    const discoveredBaseUrl = discovered === undefined
      ? Option.none<string>()
      : Option.some(yield* normalizeBaseUrl(discovered.url))
    const discoveredAuthorization = discovered === undefined
      ? undefined
      : Service.headers(discovered)?.authorization
    const discoveredAuth = Option.contains(discoveredBaseUrl, baseUrl)
      ? discoveredAuthorization
      : undefined
    const envAuth = config.opencodeUsername !== undefined && config.opencodePassword !== undefined
      ? basicHeader(config.opencodeUsername, config.opencodePassword)
      : undefined
    return {
      baseUrl,
      authorization: Option.fromNullishOr(discoveredAuth ?? envAuth),
    }
  })

export const Live: Layer.Layer<
  OpenCode,
  OpenCodeError,
  AppConfig
> = Layer.effect(
  OpenCode,
  Effect.gen(function* () {
    const endpoint = yield* resolveEndpoint()
    const headers = Option.match(endpoint.authorization, {
      onNone: () => undefined,
      onSome: (authorization) => ({ authorization }),
    })
    const client = Client.make({ baseUrl: endpoint.baseUrl, headers })
    return {
      createSession: (directory) =>
        fromPromise("session.create", (signal) =>
          client.session.create({ location: { directory } }, { signal })),
      getSession: (sessionID) =>
        fromPromise("session.get", (signal) => client.session.get({ sessionID }, { signal })),
      prompt: (input) =>
        fromPromise("session.prompt", (signal) => client.session.prompt({
          sessionID: input.sessionID,
          text: input.text,
          files: input.files ?? [],
          delivery: input.delivery,
        }, { signal })),
      listPending: (sessionID) =>
        fromPromise("session.inbox.list", (signal) =>
          client.session.inbox.list({ sessionID }, { signal })),
      cancelPending: (input) =>
        fromPromise("session.inbox.cancel", (signal) =>
          client.session.inbox.cancel({ sessionID: input.sessionID, inboxID: input.inputID }, { signal })),
      interrupt: (sessionID) =>
        fromPromise("session.interrupt", (signal) =>
          client.session.interrupt({ sessionID }, { signal })).pipe(Effect.asVoid),
      wait: (sessionID) =>
        fromPromise("session.wait", (signal) => client.session.wait({ sessionID }, { signal })),
      activeSessions: () =>
        fromPromise("session.active", (signal) => client.session.active({ signal })).pipe(
          Effect.map((active) => Object.keys(active)),
        ),
      compact: (sessionID) =>
        fromPromise("session.compact", (signal) =>
          client.session.compact({ sessionID }, { signal })).pipe(Effect.asVoid),
      revert: (input) =>
        fromPromise("session.revert.stage", (signal) => client.session.revert.stage({
          sessionID: input.sessionID,
          messageID: input.messageID,
          files: true,
        }, { signal })).pipe(
          Effect.andThen(
            fromPromise("session.revert.commit", (signal) =>
              client.session.revert.commit({ sessionID: input.sessionID }, { signal })).pipe(
              Effect.catchCause((cause) =>
                fromPromise("session.revert.clear", (signal) =>
                  client.session.revert.clear({ sessionID: input.sessionID }, { signal })).pipe(
                  Effect.catchCause((cleanupCause) =>
                    logBoundary("core/opencode", "session.revert.clear", "failed to clear staged revert after commit failure")(cleanupCause)),
                  Effect.andThen(Effect.failCause(cause)),
                ),
              ),
            ),
          ),
        ),
      listSessions: (input) =>
        fromPromise("session.list", (signal) => client.session.list({
          directory: input.directory,
          cursor: input.cursor,
          limit: input.limit,
          order: input.order,
        }, { signal })).pipe(
          Effect.map((output) => ({ data: output.data, cursor: output.cursor })),
        ),
      listMessages: (input) =>
        fromPromise("message.list", (signal) => client.message.list({
          sessionID: input.sessionID,
          limit: input.limit,
          cursor: input.cursor,
          order: input.order,
        }, { signal })).pipe(
          Effect.map((output) => ({ data: output.data, cursor: output.cursor })),
        ),
      listProjects: () =>
        fromPromise("project.list", (signal) => client.project.list({ signal })),
      listProjectDirectories: (project) => Effect.succeed(projectDirectories(project)),
      listPendingPermissions: (directory) =>
        fromPromise("permission.request.list", (signal) => client.permission.request.list({
          location: { directory },
        }, { signal })).pipe(
          Effect.map((output) => output.data),
        ),
      listPendingQuestions: (directory) =>
        fromPromise("form.request.list", (signal) =>
          client.form.request.list({ location: { directory } }, { signal })).pipe(
          Effect.map((output) => output.data.flatMap((form) => {
            const request = questionRequestFromForm(form)
            return request === undefined ? [] : [request]
          })),
        ),
      replyPermission: (input) =>
        fromPromise("permission.reply", (signal) => client.permission.reply({
          sessionID: input.sessionID,
          requestID: input.requestID,
          reply: input.reply,
        }, { signal })),
      listModels: (directory) =>
        fromPromise("model.list", (signal) => client.model.list({
          location: { directory },
        }, { signal })).pipe(
          Effect.map((output) => output.data),
        ),
      listAgents: (directory) =>
        fromPromise("agent.list", (signal) =>
          client.agent.list({ location: { directory } }, { signal })).pipe(
          Effect.map((output) => output.data),
        ),
      switchAgent: (input) =>
        fromPromise("session.switchAgent", (signal) => client.session.switchAgent({
          sessionID: input.sessionID,
          agent: input.agent,
        }, { signal })),
      switchModel: (input) =>
        fromPromise("session.switchModel", (signal) => client.session.switchModel({
          sessionID: input.sessionID,
          model: input.model,
        }, { signal })),
      replyQuestion: (input) => {
        const sessionID = input.sessionID
        const formID = input.requestID
        return fromPromise("form.get", (signal) =>
          client.form.get({ sessionID, formID }, { signal })).pipe(
          Effect.flatMap((form) => fromPromise("form.reply", (signal) => client.form.reply({
            sessionID,
            formID,
            answer: questionFormAnswer(form, input.answers),
          }, { signal }))),
        )
      },
      events: () =>
        Stream.fromAsyncIterable(
          client.event.subscribe(),
          (cause) => new OpenCodeError({ operation: "event.subscribe", cause }),
        ),
    }
  }),
)
