import { Buffer } from "node:buffer"
import { Cause, Clock, Data, Duration, Effect, FileSystem, Layer, Option, Path, Result, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpStaticServer from "effect/unstable/http/HttpStaticServer"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { BunCrypto, BunFileSystem, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { BunPath } from "@effect/platform-bun"
import { Live as ConfigLive } from "../../config.js"
import { OpenCode, Live as OpenCodeLive } from "../../core/opencode.js"
import { WebPreferences, isAllowedUserSetting, Live as WebPreferencesLive } from "./preferences.js"
import { AppConfig, AppConfigTag, expandHome } from "../../config.js"
import { toFileAttachment, type Attachment } from "../../core/attachments.js"
import { detectKind, validateAttachment, type DetectedKind } from "../../telegram/files.js"
import { ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, AuthState, AuthStateLive, claimRefreshToken, issueAccessToken, issueRefreshToken, releaseRefreshToken, revokeToken, verifyAccessToken, verifyRefreshToken, verifyPassword } from "./auth.js"
import { LoginRateLimiter, LoginRateLimiterLive } from "./login-rate-limit.js"
import { isTrustedOrigin, originFromReferer } from "./csrf.js"
import { aggregateObservability } from "./observability.js"
import { readOpenCodeObservabilitySessions } from "./opencode-observability-database.js"
import { logBoundary } from "../../core/logging.js"
import { isPathInsideRoots } from "./path-security.js"

const SessionParams = Schema.Struct({ sessionID: Schema.String })
const SessionRequestParams = Schema.Struct({ sessionID: Schema.String, requestID: Schema.String })
const QueueTaskParams = Schema.Struct({ sessionID: Schema.String, taskID: Schema.String })
const BrowserAttachment = Schema.Struct({ name: Schema.String, content: Schema.String })
const PromptBody = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(BrowserAttachment)),
  delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
})
const CreateSessionBody = Schema.Struct({ directory: Schema.String })

class WebMediaError extends Data.TaggedError("WebMediaError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

class WebPathError extends Data.TaggedError("WebPathError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

class WebRequestError extends Schema.TaggedError<WebRequestError>()("WebRequestError", {
  message: Schema.String,
  status: Schema.Literals([400, 413]),
}) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.json({ error: this.message }, { status: this.status })
  }
}

const recoverWebFailure = <A>(boundary: string, fallback: A) => (cause: Cause.Cause<unknown>) =>
  logBoundary("web/backend/server", boundary, "recovering from request failure")(cause).pipe(
    Effect.andThen(Effect.succeed(fallback)),
  )

const optionalWeb = <A>(effect: Effect.Effect<A, unknown>, boundary: string, fallback: A) =>
  effect.pipe(Effect.catchCause(recoverWebFailure(boundary, fallback)))
const ModelBody = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  variant: Schema.optional(Schema.String),
})
const PermissionBody = Schema.Struct({ reply: Schema.Union([Schema.Literal("once"), Schema.Literal("always"), Schema.Literal("reject")]) })
const QuestionBody = Schema.Struct({ answers: Schema.Array(Schema.Array(Schema.String)) })
const ProjectPreferenceBody = Schema.Struct({ directory: Schema.String })
const SessionPreferenceBody = Schema.Struct({ directory: Schema.String, sessionID: Schema.String })
const RevertBody = Schema.Struct({ messageID: Schema.String })
const FavoritePreferenceBody = Schema.Struct({ sessionID: Schema.String, pinned: Schema.Boolean })
const UserSettingBody = Schema.Struct({ key: Schema.String, value: Schema.String })
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_PROMPT_BYTES = 24 * 1024 * 1024
const MAX_TEXT_LENGTH = 200_000
const MAX_LOGIN_BODY_BYTES = 16 * 1024
const EMPTY_DIRECTORY_ENTRIES: readonly string[] = []
const currentSeconds = Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000)))
const authUnavailable = () => HttpServerResponse.json({ error: "web authentication is not configured" }, { status: 503 })
const validPasswordHash = (value: string | undefined): boolean =>
  value !== undefined && value.length >= 50 && (value.startsWith("$argon2") || value.startsWith("$2"))
const EventData = Schema.Struct({
  location: Schema.optional(Schema.Struct({ directory: Schema.String })),
  data: Schema.optional(Schema.Struct({
    sessionID: Schema.optional(Schema.String),
    form: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
  })),
})
const trustedOrigins = (config: AppConfig): readonly string[] =>
  [
    ...(config.webUiPort === undefined ? [] : [`http://localhost:${config.webUiPort}`, `http://127.0.0.1:${config.webUiPort}`]),
    ...(config.webTrustedOrigins ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0),
  ]

const cookieOptions = (config: AppConfig, path: string) => ({ httpOnly: true, sameSite: "strict" as const, secure: config.webSecureCookies === true, path })

const mediaRoots = (value: string | undefined): readonly string[] =>
  (value ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0).map(expandHome)

const mediaDirectoryValues = (value: string): readonly string[] =>
  value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)

const workspaceRootValues = (config: AppConfig): readonly string[] =>
  (config.webWorkspaceRoots ?? config.projectDirectory).split(",").map((item) => item.trim()).filter((item) => item.length > 0).map(expandHome)

export const listFilesystemWorkspaces = (config: AppConfig) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const options: { readonly id: string; readonly name: string; readonly directory: string; readonly source: "filesystem" }[] = []
  for (const configuredRoot of workspaceRootValues(config)) {
    const root = yield* optionalWeb(
      fs.realPath(configuredRoot),
      "workspace-root",
      undefined,
    )
    if (root === undefined) continue
    const rootDetails = yield* optionalWeb(
      fs.stat(root),
      "workspace-root-stat",
      undefined,
    )
    if (rootDetails?.type !== "Directory") continue
    const rootName = path.basename(root) || root
    options.push({ id: `filesystem:${root}`, name: rootName, directory: root, source: "filesystem" })
    const entries = yield* optionalWeb(
      fs.readDirectory(root).pipe(Effect.map((items) => [...items].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })))),
      "workspace-entries",
      EMPTY_DIRECTORY_ENTRIES,
    )
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      const candidate = yield* optionalWeb(
        fs.realPath(path.resolve(root, entry)),
        "workspace-candidate",
        undefined,
      )
      if (candidate === undefined || !isPathInsideRoots(candidate, [root])) continue
      const details = yield* optionalWeb(fs.stat(candidate), "workspace-candidate-stat", undefined)
      if (details?.type !== "Directory") continue
      options.push({ id: `filesystem:${candidate}`, name: entry, directory: candidate, source: "filesystem" })
    }
  }
  return [...new Map(options.map((option) => [option.directory, option])).values()]
})

const validateMediaDirectories = (value: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  for (const directory of mediaDirectoryValues(value)) {
    const candidate = yield* allowedDirectory(expandHome(directory))
    const details = yield* fs.stat(candidate).pipe(Effect.mapError((cause) => new WebPathError({ message: "media directory is not available", cause })))
    if (details.type !== "Directory") return yield* new WebPathError({ message: "media path is not a directory" })
  }
})

export const allowedDirectory = (directory: string) => Effect.gen(function* () {
  const config = yield* AppConfigTag
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidate = yield* fs.realPath(path.resolve(directory)).pipe(
    Effect.mapError((cause) => new WebPathError({ message: "directory is not available", cause })),
  )
  const details = yield* fs.stat(candidate).pipe(
    Effect.mapError((cause) => new WebPathError({ message: "directory is not available", cause })),
  )
  if (details.type !== "Directory") return yield* new WebPathError({ message: "path is not a directory" })
  const roots = yield* Effect.forEach(workspaceRootValues(config), (root) => fs.realPath(root).pipe(
    Effect.mapError((cause) => new WebPathError({ message: "workspace root is not available", cause })),
  ))
  if (!isPathInsideRoots(candidate, roots)) return yield* new WebPathError({ message: "directory is outside the workspace roots" })
  return candidate
})

const imageMime = (kind: DetectedKind): string | undefined => {
  switch (kind) {
    case "png": return "image/png"
    case "jpg": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    default: return undefined
  }
}

/** Read an image only after resolving it inside the configured directory roots. */
export const readAllowedImage = (path: string, directory: string | undefined, configuredMediaDirectories: string | undefined) => Effect.gen(function* () {
  const config = yield* AppConfigTag
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const base = directory === undefined || paths.isAbsolute(path)
    ? undefined
    : yield* allowedDirectory(directory)
  const candidate = yield* fs.realPath(paths.resolve(base ?? ".", path)).pipe(
    Effect.mapError((cause) => new WebMediaError({ message: "image is not available", cause })),
  )
  const mediaDirectories = mediaRoots(configuredMediaDirectories)
  const configuredRoots = mediaDirectories.length > 0 ? mediaDirectories : workspaceRootValues(config)
  const roots = yield* Effect.forEach(configuredRoots, (root) => fs.realPath(root).pipe(
    Effect.mapError((cause) => new WebMediaError({ message: "media root is not available", cause })),
  ))
  if (!isPathInsideRoots(candidate, roots)) return yield* new WebMediaError({ message: "image is outside the configured media directories" })
  const details = yield* fs.stat(candidate).pipe(
    Effect.mapError((cause) => new WebMediaError({ message: "image is not available", cause })),
  )
  if (details.type !== "File") return yield* new WebMediaError({ message: "image is not a file" })
  if (details.size > BigInt(20 * 1024 * 1024)) return yield* new WebMediaError({ message: "image is too large" })
  const image = yield* fs.readFile(candidate).pipe(
    Effect.mapError((cause) => new WebMediaError({ message: "image is not available", cause })),
  )
  const bytes = image
  const kind = Option.match(detectKind(bytes), {
    onNone: () => undefined,
    onSome: (value) => value,
  })
  const mime = kind === undefined ? undefined : imageMime(kind)
  if (mime === undefined) return yield* new WebMediaError({ message: "file is not a supported image" })
  return { bytes, mime }
})

/** Resolve a session and enforce the directory allowlist before using it. */
const allowedSession = (sessionID: string) => Effect.gen(function* () {
  const opencode = yield* OpenCode
  const session = yield* opencode.getSession(sessionID)
  yield* allowedDirectory(session.location.directory)
  return session
})

const requestSize = (request: HttpServerRequest.HttpServerRequest) => {
  const value = request.headers["content-length"]
  return value === undefined ? undefined : Number(value)
}

const loginClientKey = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => "unknown")

const checkRequestSize = (request: HttpServerRequest.HttpServerRequest, max: number) => {
  const size = requestSize(request)
  return size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > max)
    ? Effect.fail(new WebRequestError({ message: "request body is too large", status: 413 }))
    : Effect.succeed(undefined)
}

const readJsonBody = <A>(request: HttpServerRequest.HttpServerRequest, schema: Schema.ConstraintDecoder<A, never>, max: number) =>
  Effect.gen(function* () {
    yield* checkRequestSize(request, max)
    const raw = yield* request.text
    if (new TextEncoder().encode(raw).byteLength > max) return yield* new WebRequestError({ message: "request body is too large", status: 413 })
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
      Effect.mapError(() => new WebRequestError({ message: "request body does not match the expected format", status: 400 })),
    )
  })

const authMiddleware = Layer.effectDiscard(Effect.gen(function* () {
  const router = yield* HttpRouter.HttpRouter
  yield* router.addGlobalMiddleware((effect) => Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://localhost").pathname
     if (!path.startsWith("/api/") || path === "/api/health" || path === "/api/auth/login") return yield* effect
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    if (config.webUsername === undefined || !validPasswordHash(config.webPasswordHash) || config.webJwtSecret === undefined) return yield* authUnavailable().pipe(Effect.orDie)
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined
    const token = bearer ?? request.cookies[ACCESS_COOKIE]
     const cookieAuth = bearer === undefined && (request.cookies[ACCESS_COOKIE] !== undefined || request.cookies[REFRESH_COOKIE] !== undefined)
     const origin = request.headers.origin ?? originFromReferer(request.headers.referer)
     const host = request.headers.host
       const sameOrigin = isTrustedOrigin(origin, host, trustedOrigins(config))
     if (cookieAuth && request.method !== "GET" && request.method !== "HEAD" && !sameOrigin) {
       return yield* HttpServerResponse.json({ error: "cross-origin request rejected" }, { status: 403 }).pipe(Effect.orDie)
     }
     if (path === "/api/auth/refresh") return yield* effect
     const valid = token === undefined ? false : yield* verifyAccessToken(token, config.webJwtSecret).pipe(Effect.match({ onFailure: () => false, onSuccess: (value) => value }))
      const now = yield* currentSeconds
      const revoked = token === undefined ? false : yield* preferences.isAccessTokenRevoked(config.webUsername, token, now).pipe(Effect.match({ onFailure: () => true, onSuccess: (value) => value }))
     if (!valid || revoked) {
      return yield* HttpServerResponse.json({ error: "authentication required" }, { status: 401, headers: { "www-authenticate": "Bearer" } }).pipe(Effect.orDie)
    }
    return yield* effect
  }))
}))

const decodeAttachment = (input: Schema.Schema.Type<typeof BrowserAttachment>) =>
  Effect.gen(function* () {
    const hasControlCharacter = [...input.name].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
    if (input.name.length === 0 || input.name.length > 255 || input.name.includes("/") || input.name.includes("\\") || hasControlCharacter) return yield* new WebRequestError({ message: "attachment name is invalid", status: 400 })
    if (input.content.length === 0 || input.content.length % 4 !== 0 || input.content.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) return yield* new WebRequestError({ message: `file "${input.name}" has invalid base64 content`, status: 400 })
    const bytes = Uint8Array.from(Buffer.from(input.content, "base64"))
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return yield* new WebRequestError({ message: `file "${input.name}" exceeds 10 MB`, status: 413 })
    }
    return yield* Result.match(validateAttachment(input.name, bytes), {
      onSuccess: Effect.succeed,
      onFailure: (error) => Effect.fail(new WebRequestError({ message: error.message, status: 400 })),
    })
  })

const runWebPrompt = (sessionID: string, text: string, files: readonly Attachment[], delivery?: "steer" | "queue") =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    return yield* opencode.prompt({ sessionID, text, files: files.map(toFileAttachment), delivery })
  })

export const refreshRoute = HttpRouter.add("POST", "/api/auth/refresh", Effect.gen(function* () {
  const config = yield* AppConfigTag
  const rateLimiter = yield* LoginRateLimiter
  if (config.webUsername === undefined || config.webJwtSecret === undefined) return yield* authUnavailable()
  const username = config.webUsername
  const secret = config.webJwtSecret
  const preferences = yield* WebPreferences
  const request = yield* HttpServerRequest.HttpServerRequest
  const refreshToken = request.cookies[REFRESH_COOKIE]
  const clientKey = loginClientKey(request)
  const now = yield* Clock.currentTimeMillis
  const retryAfter = yield* rateLimiter.retryAfter("refresh", clientKey, now)
  if (retryAfter !== undefined) return yield* HttpServerResponse.json({ error: "too many refresh attempts" }, { status: 429, headers: { "retry-after": String(retryAfter) } })
  if (refreshToken === undefined || !(yield* claimRefreshToken(refreshToken))) {
    yield* rateLimiter.recordFailure("refresh", clientKey, now)
    return yield* HttpServerResponse.json({ error: "authentication required" }, { status: 401 })
  }
  return yield* Effect.gen(function* () {
    const signatureValid = yield* verifyRefreshToken(refreshToken, secret)
    if (!signatureValid) {
      yield* rateLimiter.recordFailure("refresh", clientKey, now)
      return yield* HttpServerResponse.json({ error: "authentication required" }, { status: 401 })
    }
    const accessToken = yield* issueAccessToken(username, secret)
    const nextRefreshToken = yield* issueRefreshToken(username, secret)
    const response = yield* HttpServerResponse.json({ authenticated: true, expires_in: ACCESS_TTL_SECONDS })
    const withAccessCookie = yield* HttpServerResponse.setCookie(response, ACCESS_COOKIE, accessToken, { ...cookieOptions(config, "/"), maxAge: Duration.seconds(ACCESS_TTL_SECONDS) })
    const refreshedResponse = yield* HttpServerResponse.setCookie(withAccessCookie, REFRESH_COOKIE, nextRefreshToken, { ...cookieOptions(config, "/api/auth"), maxAge: Duration.seconds(REFRESH_TTL_SECONDS) })
    const nowSeconds = Math.floor(now / 1000)
    const rotated = yield* preferences.rotateRefreshToken(username, refreshToken, nextRefreshToken, nowSeconds + REFRESH_TTL_SECONDS, nowSeconds)
    if (!rotated) {
      yield* rateLimiter.recordFailure("refresh", clientKey, now)
      return yield* HttpServerResponse.json({ error: "authentication required" }, { status: 401 })
    }
    yield* revokeToken(refreshToken)
    yield* rateLimiter.clear("refresh", clientKey)
    return refreshedResponse
  }).pipe(Effect.ensuring(releaseRefreshToken(refreshToken)))
}))

const apiRoutes = Layer.mergeAll(
  authMiddleware,
  HttpRouter.add("GET", "/api/health", HttpServerResponse.json({ ok: true })),

  HttpRouter.add("POST", "/api/auth/login", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const rateLimiter = yield* LoginRateLimiter
    const passwordHash = config.webPasswordHash
    if (config.webUsername === undefined || passwordHash === undefined || !validPasswordHash(passwordHash) || config.webJwtSecret === undefined) return yield* authUnavailable()
    const request = yield* HttpServerRequest.HttpServerRequest
    const clientKey = loginClientKey(request)
    const now = yield* Clock.currentTimeMillis
    const retryAfter = yield* rateLimiter.retryAfter("login", clientKey, now)
    if (retryAfter !== undefined) return yield* HttpServerResponse.json({ error: "too many login attempts" }, { status: 429, headers: { "retry-after": String(retryAfter) } })
    const body = yield* readJsonBody(request, Schema.Struct({ username: Schema.String, password: Schema.String }), MAX_LOGIN_BODY_BYTES)
    if (body.username.length > 128 || body.password.length > 512) return yield* HttpServerResponse.json({ error: "credentials are too long" }, { status: 400 })
    const valid = body.username === config.webUsername && (yield* verifyPassword(body.password, passwordHash))
    if (!valid) {
      yield* rateLimiter.recordFailure("login", clientKey, now)
      return yield* HttpServerResponse.json({ error: "invalid username or password" }, { status: 401 })
    }
    yield* rateLimiter.clear("login", clientKey)
      const accessToken = yield* issueAccessToken(config.webUsername, config.webJwtSecret)
      const refreshToken = yield* issueRefreshToken(config.webUsername, config.webJwtSecret)
      yield* preferences.registerRefreshToken(config.webUsername, refreshToken, Math.floor(now / 1000) + REFRESH_TTL_SECONDS)
      const response = yield* HttpServerResponse.json({ authenticated: true, expires_in: ACCESS_TTL_SECONDS })
      const withAccessCookie = yield* HttpServerResponse.setCookie(response, ACCESS_COOKIE, accessToken, { ...cookieOptions(config, "/"), maxAge: Duration.seconds(ACCESS_TTL_SECONDS) })
      return yield* HttpServerResponse.setCookie(withAccessCookie, REFRESH_COOKIE, refreshToken, { ...cookieOptions(config, "/api/auth"), maxAge: Duration.seconds(REFRESH_TTL_SECONDS) })
  })),

  refreshRoute,

  HttpRouter.add("GET", "/api/auth/session", Effect.gen(function* () {
    const config = yield* AppConfigTag
    if (config.webUsername === undefined || config.webJwtSecret === undefined) return yield* authUnavailable()
    const request = yield* HttpServerRequest.HttpServerRequest
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined
    const token = bearer ?? request.cookies[ACCESS_COOKIE]
    if (token === undefined || !(yield* verifyAccessToken(token, config.webJwtSecret))) return yield* HttpServerResponse.json({ error: "authentication required" }, { status: 401 })
    return yield* HttpServerResponse.json({ authenticated: true, username: config.webUsername })
  })),

  HttpRouter.add("POST", "/api/auth/logout", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined
    const accessToken = bearer ?? request.cookies[ACCESS_COOKIE]
    const refreshToken = request.cookies[REFRESH_COOKIE]
    if (accessToken !== undefined) {
      yield* revokeToken(accessToken)
      if (config.webUsername !== undefined) yield* preferences.revokeAccessToken(config.webUsername, accessToken)
    }
    if (refreshToken !== undefined) {
      yield* revokeToken(refreshToken)
      if (config.webUsername !== undefined) yield* preferences.revokeRefreshToken(config.webUsername, refreshToken)
    }
    const response = yield* HttpServerResponse.json({ ok: true })
    const withAccessCookie = yield* HttpServerResponse.expireCookie(response, ACCESS_COOKIE, cookieOptions(config, "/"))
   return yield* HttpServerResponse.expireCookie(withAccessCookie, REFRESH_COOKIE, cookieOptions(config, "/api/auth"))
  })),

  HttpRouter.add("GET", "/api/preferences", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    return yield* HttpServerResponse.json(yield* preferences.get(config.webUsername ?? "default"))
  })),

  HttpRouter.add("POST", "/api/preferences/project", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* readJsonBody(request, ProjectPreferenceBody, 16 * 1024)
    const directory = yield* allowedDirectory(body.directory)
    yield* preferences.setProject(config.webUsername ?? "default", directory)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/preferences/session", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* readJsonBody(request, SessionPreferenceBody, 16 * 1024)
    const directory = yield* allowedDirectory(body.directory)
    const session = yield* allowedSession(body.sessionID)
    const sessionDirectory = yield* allowedDirectory(session.location.directory)
    if (sessionDirectory !== directory) return yield* HttpServerResponse.json({ error: "session does not belong to directory" }, { status: 400 })
    yield* preferences.setSession(config.webUsername ?? "default", directory, body.sessionID)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/preferences/favorite", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* readJsonBody(request, FavoritePreferenceBody, 16 * 1024)
    yield* allowedSession(body.sessionID)
    yield* preferences.setFavorite(config.webUsername ?? "default", body.sessionID, body.pinned)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/preferences/setting", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* readJsonBody(request, UserSettingBody, 16 * 1024)
     if (body.key.length === 0 || body.key.length > 64 || body.value.length > 4_096 || !isAllowedUserSetting(body.key, body.value)) return yield* HttpServerResponse.json({ error: "invalid user setting" }, { status: 400 })
     if (body.key === "mediaDirectories") {
       const validMediaDirectories = yield* validateMediaDirectories(body.value).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
       if (!validMediaDirectories) return yield* HttpServerResponse.json({ error: "media directories must exist inside the API allowlist" }, { status: 400 })
     }
     yield* preferences.setSetting(config.webUsername ?? "default", body.key, body.value)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("GET", "/api/sessions", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const opencode = yield* OpenCode
    const request = yield* HttpServerRequest.HttpServerRequest
    yield* checkRequestSize(request, 8 * 1024)
    const directory = yield* allowedDirectory(new URL(request.url, "http://localhost").searchParams.get("directory") ?? config.projectDirectory)
    const sessions = yield* opencode.listSessions({ directory, limit: 100 })
    return yield* HttpServerResponse.json(sessions)
  })),

  HttpRouter.add("POST", "/api/sessions", Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { directory } = yield* readJsonBody(request, CreateSessionBody, 64 * 1024)
    const safeDirectory = yield* allowedDirectory(directory)
    const opencode = yield* OpenCode
    const session = yield* opencode.createSession(safeDirectory)
    return yield* HttpServerResponse.json(session)
  })),

  HttpRouter.add("GET", "/api/projects", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const opencode = yield* OpenCode
    const path = yield* Path.Path
    const projects = yield* opencode.listProjects().pipe(Effect.catchCause(recoverWebFailure("projects", [])))
    const projectDirectories = yield* Effect.forEach(projects, (project) =>
      opencode.listProjectDirectories(project).pipe(
        Effect.catchCause(recoverWebFailure("project-directories", [])),
        Effect.map((directories) =>
          directories.map((entry) => ({ directory: entry.directory, id: project.id, name: project.name ?? project.canonical }))),
      ),
      { concurrency: 4 },
    )
    const projectByDirectory = new Map(projectDirectories.flat().map((project) => [path.resolve(project.directory), { id: project.id, name: project.name }]))
    const filesystem = yield* listFilesystemWorkspaces(config)
    return yield* HttpServerResponse.json(filesystem.map((option) => {
      const project = projectByDirectory.get(path.resolve(option.directory))
      return project === undefined ? option : { ...option, opencodeProject: project }
    }))
  })),

  HttpRouter.add("GET", "/api/observability", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const fs = yield* FileSystem.FileSystem
    const now = yield* Clock.currentTimeMillis
    const databasePath = config.opencodeDatabaseFile
    if (databasePath === undefined) {
      return yield* HttpServerResponse.json({
        available: false,
        source: "sqlite",
        warning: "Usage data is unavailable. Set OPENCODE_DATABASE_FILE to the OpenCode SQLite database path and restart Kissa.",
        generatedAt: now,
      })
    }
    const opencode = yield* OpenCode
    return yield* readOpenCodeObservabilitySessions(databasePath).pipe(Effect.matchCauseEffect({
      onFailure: (cause) => Effect.logError("failed to read OpenCode observability database").pipe(
        Effect.annotateLogs({ component: "web/observability", boundary: "opencode-sqlite", cause: Cause.pretty(cause) }),
        Effect.andThen(HttpServerResponse.json({
          available: false,
          source: "sqlite",
          warning: "Kissa could not read the configured OpenCode database. Check OPENCODE_DATABASE_FILE and file permissions.",
          generatedAt: now,
        })),
      ),
      onSuccess: (sessions) => Effect.gen(function* () {
        const active = yield* opencode.activeSessions().pipe(Effect.catchCause((cause) =>
          Effect.logError("failed to load active sessions for observability").pipe(
            Effect.annotateLogs({ component: "web/observability", boundary: "opencode-api", cause: Cause.pretty(cause) }),
            Effect.andThen(Effect.succeed<readonly string[]>([])),
          )))
        const database = yield* optionalWeb(
          fs.stat(databasePath),
          "observability-database-stat",
          undefined,
        )
        return yield* HttpServerResponse.json({
          available: true,
          source: "sqlite",
          ...aggregateObservability(sessions, active, now),
          databaseBytes: database === undefined ? 0 : Number(database.size),
          generatedAt: now,
        })
      }),
    }))
  })),

  HttpRouter.add("GET", "/api/models", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const opencode = yield* OpenCode
    const request = yield* HttpServerRequest.HttpServerRequest
    const directory = yield* allowedDirectory(new URL(request.url, "http://localhost").searchParams.get("directory") ?? config.projectDirectory)
    const models = yield* opencode.listModels(directory)
    return yield* HttpServerResponse.json(models)
  })),

  HttpRouter.add("GET", "/api/agents", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const opencode = yield* OpenCode
    const request = yield* HttpServerRequest.HttpServerRequest
    const directory = yield* allowedDirectory(new URL(request.url, "http://localhost").searchParams.get("directory") ?? config.projectDirectory)
    const agents = yield* opencode.listAgents(directory)
    return yield* HttpServerResponse.json(agents)
  })),

  HttpRouter.add("GET", "/api/images/local", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
    const path = query.get("path")
    const directory = query.get("directory") ?? undefined
    if (path === null || path.length === 0 || path.length > 4096) return yield* HttpServerResponse.json({ error: "invalid image path" }, { status: 400 })
    const savedPreferences = yield* preferences.get(config.webUsername ?? "default")
    return yield* readAllowedImage(path, directory, savedPreferences.settings.mediaDirectories).pipe(
      Effect.matchEffect({
        onFailure: () => HttpServerResponse.json({ error: "image is not available" }, { status: 404 }),
        onSuccess: ({ bytes, mime }) => Effect.succeed(HttpServerResponse.uint8Array(bytes, {
          contentType: mime,
          headers: { "cache-control": "private, no-store", "content-disposition": "inline" },
        })),
      }),
    )
  })),

  HttpRouter.add("GET", "/api/sessions/:sessionID/messages", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
     const before = query.get("before") ?? undefined
     const page = yield* opencode.listMessages({ sessionID, limit: 200, cursor: before, order: "desc" })
     return yield* HttpServerResponse.json({
       messages: [...page.data].reverse(),
       hasMore: page.cursor.next !== undefined,
       nextBefore: page.cursor.next,
     })
  })),

  HttpRouter.add("GET", "/api/sessions/active", Effect.gen(function* () {
    const opencode = yield* OpenCode
    const active = yield* opencode.activeSessions()
    const visible = yield* Effect.forEach(active, (sessionID) =>
      allowedSession(sessionID).pipe(
        Effect.as(sessionID),
         Effect.catchCause(recoverWebFailure("active-session-filter", undefined)),
      ),
    )
    return yield* HttpServerResponse.json(visible.filter((sessionID): sessionID is string => sessionID !== undefined))
  })),

  HttpRouter.add("GET", "/api/sessions/:sessionID/subagents", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    const opencode = yield* OpenCode
    const session = yield* allowedSession(sessionID)
    const sessions = yield* opencode.listSessions({ directory: session.location.directory, limit: 100 })
    return yield* HttpServerResponse.json(sessions.data.filter((child) => child.parentID === sessionID))
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/prompt", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
     const { text, attachments = [], delivery } = yield* readJsonBody(request, PromptBody, MAX_PROMPT_BYTES)
    if (text.length > MAX_TEXT_LENGTH) return yield* HttpServerResponse.json({ error: "prompt text is too long" }, { status: 413 })
    if (attachments.length > 8) return yield* new WebRequestError({ message: "a prompt can include at most 8 files", status: 400 })
    if (attachments.reduce((total, attachment) => total + attachment.content.length, 0) > Math.ceil(20 * 1024 * 1024 / 3) * 4) return yield* HttpServerResponse.json({ error: "attachments are too large" }, { status: 413 })
    return yield* Effect.forEach(attachments, decodeAttachment, { concurrency: 4 }).pipe(
      Effect.matchEffect({
        onFailure: (error) => HttpServerResponse.json({ error: error.message }, { status: 400 }),
        onSuccess: (files) => Effect.gen(function* () {
            return yield* runWebPrompt(sessionID, text, files, delivery).pipe(
              Effect.map((result) => ({ queued: delivery === "queue", id: result.id, result })),
              Effect.flatMap((result) => HttpServerResponse.json(result)),
            )
        }),
      }),
    )
  })),

  HttpRouter.add("GET", "/api/sessions/:sessionID/queue", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    return yield* opencode.listPending(sessionID).pipe(
      Effect.map((items) => items.filter((item) => item.type === "user" && "delivery" in item && item.delivery === "queue")),
      Effect.flatMap((items) => HttpServerResponse.json(items)),
    )
  })),

  HttpRouter.add("DELETE", "/api/sessions/:sessionID/queue/:taskID", Effect.gen(function* () {
    const { sessionID, taskID } = yield* HttpRouter.schemaParams(QueueTaskParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    yield* opencode.cancelPending({ sessionID, inputID: taskID })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("DELETE", "/api/sessions/:sessionID/queue", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    const pending = yield* opencode.listPending(sessionID)
    yield* Effect.forEach(pending.filter((item) => "delivery" in item && item.delivery === "queue"), (item) => opencode.cancelPending({ sessionID, inputID: item.id }), { concurrency: 4 })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/interrupt", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    yield* opencode.interrupt(sessionID)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/compact", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    yield* opencode.compact(sessionID)
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/revert", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
    const { messageID } = yield* readJsonBody(request, RevertBody, 16 * 1024)
    const opencode = yield* OpenCode
    yield* opencode.revert({ sessionID, messageID })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("GET", "/api/sessions/:sessionID/status", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    const session = yield* allowedSession(sessionID)
    const opencode = yield* OpenCode
    const active = yield* opencode.activeSessions().pipe(Effect.map((sessions) => sessions.includes(sessionID)))
    return yield* HttpServerResponse.json({ session, active })
  })),

  HttpRouter.add("GET", "/api/pending", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const opencode = yield* OpenCode
    const request = yield* HttpServerRequest.HttpServerRequest
    const directory = yield* allowedDirectory(new URL(request.url, "http://localhost").searchParams.get("directory") ?? config.projectDirectory)
    const [permissions, questions] = yield* Effect.all([
      opencode.listPendingPermissions(directory),
      opencode.listPendingQuestions(directory),
    ])
    return yield* HttpServerResponse.json({ permissions, questions })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/permissions/:requestID", Effect.gen(function* () {
    const { sessionID, requestID } = yield* HttpRouter.schemaParams(SessionRequestParams)
    yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
    const { reply } = yield* readJsonBody(request, PermissionBody, 64 * 1024)
    const opencode = yield* OpenCode
    yield* opencode.replyPermission({ sessionID, requestID, reply })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/questions/:requestID", Effect.gen(function* () {
    const { sessionID, requestID } = yield* HttpRouter.schemaParams(SessionRequestParams)
    yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
    const { answers } = yield* readJsonBody(request, QuestionBody, 256 * 1024)
    const opencode = yield* OpenCode
    yield* opencode.replyQuestion({ sessionID, requestID, answers })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/model", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    const session = yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
    const model = yield* readJsonBody(request, ModelBody, 16 * 1024)
    const opencode = yield* OpenCode
    const models = yield* opencode.listModels(session.location.directory)
    const selected = models.find((candidate) => candidate.id === model.id && candidate.providerID === model.providerID)
    if (selected === undefined || (model.variant !== undefined && !selected.variants?.some((variant) => variant.id === model.variant))) return yield* HttpServerResponse.json({ error: "model is not available" }, { status: 400 })
    yield* opencode.switchModel({ sessionID, model })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("POST", "/api/sessions/:sessionID/agent", Effect.gen(function* () {
    const { sessionID } = yield* HttpRouter.schemaParams(SessionParams)
    const session = yield* allowedSession(sessionID)
    const request = yield* HttpServerRequest.HttpServerRequest
    const { agent } = yield* readJsonBody(request, Schema.Struct({ agent: Schema.String }), 16 * 1024)
    const opencode = yield* OpenCode
    const agents = yield* opencode.listAgents(session.location.directory)
    if (!agents.some((candidate) => candidate.id === agent && candidate.hidden !== true && candidate.mode !== "subagent")) return yield* HttpServerResponse.json({ error: "agent is not available" }, { status: 400 })
    yield* opencode.switchAgent({ sessionID, agent })
    return yield* HttpServerResponse.json({ ok: true })
  })),

  HttpRouter.add("GET", "/api/events", Effect.gen(function* () {
    const config = yield* AppConfigTag
    const preferences = yield* WebPreferences
    const authState = yield* AuthState
    const opencode = yield* OpenCode
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const request = yield* HttpServerRequest.HttpServerRequest
    const encoder = new TextEncoder()
    const sessionEvents = opencode.events().pipe(
      Stream.filterEffect((event) => {
        const decoded = Schema.decodeUnknownOption(EventData)(event)
        if (Option.isNone(decoded)) return Effect.succeed(false)
        const directory = decoded.value.location?.directory
        if (directory !== undefined) return allowedDirectory(directory).pipe(
          Effect.provideService(AppConfigTag, config),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        )
        const sessionID = decoded.value.data?.sessionID ?? decoded.value.data?.form?.sessionID
        return sessionID !== undefined
          ? allowedSession(sessionID).pipe(
            Effect.as(true),
             Effect.catchCause(recoverWebFailure("event-filter", false)),
            Effect.provideService(AppConfigTag, config),
            Effect.provideService(OpenCode, opencode),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )
          : Effect.succeed(false)
      }),
      Stream.map((event) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    )
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined
    const streamToken = bearer ?? request.cookies[ACCESS_COOKIE]
    const heartbeat = Stream.tick("5 seconds").pipe(
      Stream.mapEffect(() => Effect.gen(function* () {
        if (streamToken === undefined) return encoder.encode(": heartbeat\n\n")
        const valid = yield* verifyAccessToken(streamToken, config.webJwtSecret ?? "").pipe(
          Effect.match({ onFailure: () => false, onSuccess: (value) => value }),
        )
        const now = yield* currentSeconds
        const revoked = yield* preferences.isAccessTokenRevoked(config.webUsername ?? "", streamToken, now).pipe(
          Effect.match({ onFailure: () => true, onSuccess: (value) => value }),
        )
        if (!valid || revoked) return yield* Effect.interrupt
        return encoder.encode(": heartbeat\n\n")
      }).pipe(Effect.provideService(AuthState, authState))),
    )
    const events = Stream.merge(sessionEvents, heartbeat)
    return HttpServerResponse.stream(events, {
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  })),
)

const StaticLive = HttpStaticServer.layer({ root: "./dist/web", index: "index.html", spa: true })
const ApiLive = HttpRouter.serve(Layer.mergeAll(apiRoutes, StaticLive)).pipe(
  Layer.provide(LoginRateLimiterLive),
  Layer.provide(OpenCodeLive),
  Layer.provide(WebPreferencesLive),
  Layer.provide(AuthStateLive),
  Layer.provide(ConfigLive),
)

const program = Effect.gen(function* () {
  const config = yield* AppConfigTag
  const missingAuth = [
    config.webUsername === undefined ? "WEB_USERNAME" : undefined,
    !validPasswordHash(config.webPasswordHash) ? "WEB_PASSWORD_HASH" : undefined,
    config.webJwtSecret === undefined ? "WEB_JWT_SECRET" : undefined,
  ].filter((name): name is string => name !== undefined)
  if (missingAuth.length > 0) {
    yield* Effect.annotateLogs({ component: "web/server", boundary: "startup" })(
      Effect.logWarning(`web authentication is not configured; protected API requests will be rejected (missing: ${missingAuth.join(", ")})`),
    )
  }
  yield* Effect.never.pipe(
    Effect.provide(ApiLive),
    Effect.provide(BunHttpServer.layer({ port: config.webPort, hostname: config.webHost ?? "127.0.0.1", maxRequestBodySize: MAX_PROMPT_BYTES })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(BunFileSystem.layer),
    Effect.provide(BunPath.layer),
    Effect.provide(BunCrypto.layer),
  )
})

if (import.meta.main) BunRuntime.runMain(program.pipe(Effect.provide(ConfigLive)))
