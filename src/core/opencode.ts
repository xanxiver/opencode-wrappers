import { Buffer } from "node:buffer"
import { Brand, Context, Data, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
  AbsolutePath,
  Location,
  Model,
  OpenCode as Client,
  Permission,
  Project,
  Provider,
  Question,
  Session,
  SessionPending,
} from "@opencode-ai/client/effect"
import { Service } from "@opencode-ai/client/effect/service"
import type { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import type { PromptInput } from "@opencode-ai/client/effect"
import { AppConfigTag, type AppConfig } from "../config.js"
import { logBoundary } from "./logging.js"

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export interface OpenCodeShape {
  readonly createSession: (directory: string) => Effect.Effect<Session.Info, OpenCodeError>
  readonly getSession: (sessionID: string) => Effect.Effect<Session.Info, OpenCodeError>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly files?: readonly PromptInput.FileAttachment[]
  }) => Effect.Effect<SessionPending.User, OpenCodeError>
  readonly interrupt: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly wait: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly activeSessions: () => Effect.Effect<readonly string[], OpenCodeError>
  readonly compact: (sessionID: string) => Effect.Effect<void, OpenCodeError>
  readonly listSessions: (input: { readonly directory: string; readonly cursor?: string; readonly limit?: number }) =>
    Effect.Effect<{
      readonly data: readonly Session.Info[]
      readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
    }, OpenCodeError>
  readonly listProjects: () => Effect.Effect<readonly Project.Info[], OpenCodeError>
  readonly listProjectDirectories: (projectID: string) =>
    Effect.Effect<readonly { readonly directory: string; readonly strategy?: string }[], OpenCodeError>
  readonly listPendingPermissions: (directory: string) => Effect.Effect<readonly Permission.Request[], OpenCodeError>
  readonly listPendingQuestions: (directory: string) => Effect.Effect<readonly Question.Request[], OpenCodeError>
  readonly replyPermission: (input: {
    readonly sessionID: string
    readonly requestID: string
    readonly reply: Permission.Reply
  }) => Effect.Effect<void, OpenCodeError>
  readonly listModels: (directory: string) => Effect.Effect<readonly Model.Info[], OpenCodeError>
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

export class OpenCode extends Context.Service<OpenCode, OpenCodeShape>()("opencode2-uis/OpenCode") {}

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

const basicHeader = (username: string, password: string) =>
  "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64")

interface ResolvedEndpoint {
  readonly baseUrl: string
  readonly authorization: Option.Option<string>
}

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

const resolveEndpoint = (): Effect.Effect<ResolvedEndpoint, OpenCodeError, FileSystem.FileSystem | AppConfig> =>
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    // An explicit endpoint is authoritative. Discovery may supply credentials
    // only when it identifies that exact endpoint; it never replaces the URL.
    const discovered = config.opencodeBaseUrl === undefined
      ? yield* Service.ensure({ command: ["opencode2", "serve", "--service"] }).pipe(
        Effect.mapError((cause) => new OpenCodeError({ operation: "service.ensure", cause })),
      )
      : yield* Service.discover().pipe(
        Effect.mapError((cause) => new OpenCodeError({ operation: "service.discover", cause })),
      )
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

/** Decode a plain string into a branded id required by the client contract. */
type SessionID = Schema.Schema.Type<typeof Session.ID>
type SessionCursor = string & Brand.Brand<"SessionsCursor">
type PermissionID = Schema.Schema.Type<typeof Permission.ID>
type QuestionID = Schema.Schema.Type<typeof Question.ID>
type ModelID = Schema.Schema.Type<typeof Model.ID>
type ProviderID = Schema.Schema.Type<typeof Provider.ID>
type VariantID = Schema.Schema.Type<typeof Model.VariantID>
type ProjectID = Schema.Schema.Type<typeof Project.ID>

const toSessionID = (value: string): SessionID => Schema.decodeUnknownSync(Session.ID)(value)
const toSessionCursor = (value: string): SessionCursor =>
  Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("SessionsCursor")))(value)
const toPermissionID = (value: string): PermissionID => Schema.decodeUnknownSync(Permission.ID)(value)
const toQuestionID = (value: string): QuestionID => Schema.decodeUnknownSync(Question.ID)(value)
const toModelID = (value: string): ModelID => Schema.decodeUnknownSync(Model.ID)(value)
const toProviderID = (value: string): ProviderID => Schema.decodeUnknownSync(Provider.ID)(value)
const toVariantID = (value: string): VariantID => Schema.decodeUnknownSync(Model.VariantID)(value)
const toProjectID = (value: string): ProjectID => Schema.decodeUnknownSync(Project.ID)(value)

export const Live: Layer.Layer<
  OpenCode,
  OpenCodeError,
  FileSystem.FileSystem | HttpClient.HttpClient | AppConfig
> = Layer.effect(
  OpenCode,
  Effect.gen(function* () {
    const endpoint = yield* resolveEndpoint()
    const httpClient = yield* HttpClient.HttpClient
    const authenticatedHttpClient = Option.match(endpoint.authorization, {
      onNone: () => httpClient,
      onSome: (authorization) =>
        httpClient.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", authorization)),
        ),
    })
    const client = yield* Client.make({ baseUrl: endpoint.baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, authenticatedHttpClient),
    )
    return {
      createSession: (directory) =>
        client.session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        }).pipe(wrap("session.create")),
      getSession: (sessionID) =>
        client.session.get({ sessionID: toSessionID(sessionID) }).pipe(wrap("session.get")),
      prompt: (input) =>
        client.session.prompt({
          sessionID: toSessionID(input.sessionID),
          text: input.text,
          files: input.files ?? [],
        }).pipe(wrap("session.prompt")),
      interrupt: (sessionID) =>
        client.session.interrupt({ sessionID: toSessionID(sessionID) }).pipe(wrap("session.interrupt")),
      wait: (sessionID) =>
        client.session.wait({ sessionID: toSessionID(sessionID) }).pipe(wrap("session.wait")),
      activeSessions: () =>
        client.session.active().pipe(
          wrap("session.active"),
          Effect.map((active) => Object.keys(active)),
        ),
      compact: (sessionID) =>
        client.session.compact({ sessionID: toSessionID(sessionID) }).pipe(
          Effect.map(() => undefined),
          wrap("session.compact"),
        ),
      listSessions: (input) =>
        client.session.list({
          directory: AbsolutePath.make(input.directory),
          cursor: input.cursor === undefined ? undefined : toSessionCursor(input.cursor),
          limit: input.limit,
        }).pipe(
          wrap("session.list"),
          Effect.map((output) => ({ data: output.data, cursor: output.cursor })),
        ),
      listProjects: () => client.project.list().pipe(wrap("project.list")),
      listProjectDirectories: (projectID) =>
        client.project.directories({ projectID: toProjectID(projectID) }).pipe(wrap("project.directories")),
       listPendingPermissions: (directory) =>
         client.permission.request.list({
           location: { directory },
        }).pipe(
          wrap("permission.request.list"),
          Effect.map((output) => output.data),
        ),
       listPendingQuestions: (directory) =>
         client.question.request.list({
           location: { directory },
        }).pipe(
          wrap("question.request.list"),
          Effect.map((output) => output.data),
        ),
      replyPermission: (input) =>
        client.permission.reply({
          sessionID: toSessionID(input.sessionID),
          requestID: toPermissionID(input.requestID),
          reply: input.reply,
        }).pipe(wrap("permission.reply")),
       listModels: (directory) =>
         client.model.list({
           location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        }).pipe(
          wrap("model.list"),
          Effect.map((output) => output.data),
        ),
      switchModel: (input) =>
        client.session.switchModel({
          sessionID: toSessionID(input.sessionID),
          model: {
            id: toModelID(input.model.id),
            providerID: toProviderID(input.model.providerID),
            variant: input.model.variant === undefined ? undefined : toVariantID(input.model.variant),
          },
        }).pipe(wrap("session.switchModel")),
      replyQuestion: (input) =>
        client.question.reply({
          sessionID: toSessionID(input.sessionID),
          requestID: toQuestionID(input.requestID),
          answers: input.answers.map((answer) => [...answer]),
        }).pipe(wrap("question.reply")),
      events: () =>
        client.event.subscribe().pipe(
          Stream.mapError((cause) => new OpenCodeError({ operation: "event.subscribe", cause })),
        ),
    }
  }),
)
