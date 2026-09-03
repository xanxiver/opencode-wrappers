import { Buffer } from "node:buffer"
import { Clock, Context, Crypto, Data, Effect, Layer, Option, Ref, Schema } from "effect"

export const ACCESS_COOKIE = "opencode_access"
export const REFRESH_COOKIE = "opencode_refresh"
export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60

const MAX_REVOKED_TOKENS = 10_000
const MAX_REFRESH_TOKENS_IN_FLIGHT = 1_024

export class WebAuthError extends Data.TaggedError("WebAuthError")<{
  readonly operation: "sign" | "verify" | "password"
  readonly message: string
  readonly cause: unknown
}> {}

interface AuthStateValue {
  readonly revokedTokens: ReadonlyMap<string, number>
  readonly refreshTokensInFlight: ReadonlySet<string>
}

interface AuthStateService {
  readonly revoke: (token: string, expiresAt: number, now: number) => Effect.Effect<void>
  readonly isRevoked: (token: string, now: number) => Effect.Effect<boolean>
  readonly claimRefresh: (token: string) => Effect.Effect<boolean>
  readonly releaseRefresh: (token: string) => Effect.Effect<void>
}

export class AuthState extends Context.Service<AuthState, AuthStateService>()("opencode2-uis/WebAuthState") {}

const withoutExpiredTokens = (tokens: ReadonlyMap<string, number>, now: number): Map<string, number> => {
  const active = new Map([...tokens].filter(([, expiresAt]) => expiresAt > now))
  while (active.size > MAX_REVOKED_TOKENS) {
    const oldest = active.keys().next().value
    if (oldest === undefined) break
    active.delete(oldest)
  }
  return active
}

export const AuthStateLive: Layer.Layer<AuthState> = Layer.effect(
  AuthState,
  Ref.make<AuthStateValue>({ revokedTokens: new Map(), refreshTokensInFlight: new Set() }).pipe(
    Effect.map((state): AuthStateService => ({
      revoke: (token, expiresAt, now) => Ref.update(state, (current) => {
        const revokedTokens = withoutExpiredTokens(current.revokedTokens, now)
        revokedTokens.set(token, expiresAt)
        return { ...current, revokedTokens }
      }),
      isRevoked: (token, now) => Ref.modify(state, (current) => {
        const revokedTokens = withoutExpiredTokens(current.revokedTokens, now)
        return [revokedTokens.has(token), { ...current, revokedTokens }]
      }),
      claimRefresh: (token) => Ref.modify(state, (current) => {
        if (token.length > 4_096 || token.split(".").length !== 3 || current.refreshTokensInFlight.size >= MAX_REFRESH_TOKENS_IN_FLIGHT || current.refreshTokensInFlight.has(token)) {
          return [false, current]
        }
        return [true, { ...current, refreshTokensInFlight: new Set(current.refreshTokensInFlight).add(token) }]
      }),
      releaseRefresh: (token) => Ref.update(state, (current) => {
        const refreshTokensInFlight = new Set(current.refreshTokensInFlight)
        refreshTokensInFlight.delete(token)
        return { ...current, refreshTokensInFlight }
      }),
    }))),
)

const currentSeconds = (now: number | undefined): Effect.Effect<number> =>
  now === undefined
    ? Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000)))
    : Effect.succeed(now)

/** Revoke a token until its maximum lifetime expires. */
export const revokeToken = (token: string, now?: number): Effect.Effect<void, never, AuthState> => Effect.gen(function* () {
  const timestamp = yield* currentSeconds(now)
  const state = yield* AuthState
  yield* state.revoke(token, timestamp + REFRESH_TTL_SECONDS, timestamp)
})

/** Prevent concurrent requests from consuming the same refresh token twice. */
export const claimRefreshToken = (token: string): Effect.Effect<boolean, never, AuthState> =>
  Effect.andThen(AuthState, (state) => state.claimRefresh(token))

export const releaseRefreshToken = (token: string): Effect.Effect<void, never, AuthState> =>
  Effect.andThen(AuthState, (state) => state.releaseRefresh(token))

const encoder = new TextEncoder()

const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url")
const decode = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64url"))
const decodeBufferSource = (value: string): Uint8Array<ArrayBuffer> => {
  const decoded = decode(value)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  return bytes
}

const JwtHeader = Schema.Struct({ alg: Schema.Literal("HS256"), typ: Schema.Literal("JWT") })
const JwtClaims = Schema.Struct({
  sub: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
  typ: Schema.Literals(["access", "refresh"]),
  jti: Schema.String,
})

const decodePart = <A>(part: string, schema: Schema.ConstraintDecoder<A, never>) => Effect.gen(function* () {
  const json = yield* Effect.try({
    try: () => new TextDecoder().decode(decode(part)),
    catch: (cause) => new WebAuthError({ operation: "verify", message: "JWT decoding failed", cause }),
  })
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json).pipe(
    Effect.mapError((cause) => new WebAuthError({ operation: "verify", message: "JWT decoding failed", cause })),
  )
})

const importHmacKey = (secret: string, usage: "sign" | "verify") => Effect.tryPromise({
  try: () => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]),
  catch: (cause) => new WebAuthError({ operation: usage, message: `JWT ${usage}ing failed`, cause }),
})

const sign = (input: string, secret: string): Effect.Effect<string, WebAuthError> => Effect.gen(function* () {
  const key = yield* importHmacKey(secret, "sign")
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign("HMAC", key, encoder.encode(input)),
    catch: (cause) => new WebAuthError({ operation: "sign", message: "JWT signing failed", cause }),
  })
  return encode(new Uint8Array(signature))
})

const issueToken = (username: string, secret: string, ttl: number, type: "access" | "refresh", now: number): Effect.Effect<string, WebAuthError, Crypto.Crypto> => Effect.gen(function* () {
  const cryptoService = yield* Crypto.Crypto
  const jti = yield* cryptoService.randomUUIDv4.pipe(
    Effect.mapError((cause) => new WebAuthError({ operation: "sign", message: "JWT identifier generation failed", cause })),
  )
  const header = encode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const payload = encode(encoder.encode(JSON.stringify({ sub: username, iat: now, exp: now + ttl, typ: type, jti })))
  const input = `${header}.${payload}`
  return `${input}.${yield* sign(input, secret)}`
})

export const issueAccessToken = (username: string, secret: string, now?: number): Effect.Effect<string, WebAuthError, Crypto.Crypto> =>
  currentSeconds(now).pipe(Effect.flatMap((timestamp) => issueToken(username, secret, ACCESS_TTL_SECONDS, "access", timestamp)))

export const issueRefreshToken = (username: string, secret: string, now?: number): Effect.Effect<string, WebAuthError, Crypto.Crypto> =>
  currentSeconds(now).pipe(Effect.flatMap((timestamp) => issueToken(username, secret, REFRESH_TTL_SECONDS, "refresh", timestamp)))

const verifyToken = (token: string, secret: string, expectedType: "access" | "refresh", now: number): Effect.Effect<boolean, WebAuthError, AuthState> => Effect.gen(function* () {
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [headerPart, payloadPart, signaturePart] = parts
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) return false
  const decoded = yield* Effect.option(Effect.all({
    header: decodePart(headerPart, JwtHeader),
    claims: decodePart(payloadPart, JwtClaims),
  }))
  if (Option.isNone(decoded)) return false
  const claims = decoded.value.claims
  if (claims.sub.length === 0 || claims.jti.length === 0 || !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now || claims.typ !== expectedType) return false
  const key = yield* importHmacKey(secret, "verify")
  const validSignature = yield* Effect.tryPromise({
    try: () => crypto.subtle.verify("HMAC", key, decodeBufferSource(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`)),
    catch: (cause) => new WebAuthError({ operation: "verify", message: "JWT verification failed", cause }),
  })
  if (!validSignature) return false
  const state = yield* AuthState
  return !(yield* state.isRevoked(token, now))
})

export const verifyAccessToken = (token: string, secret: string, now?: number): Effect.Effect<boolean, WebAuthError, AuthState> =>
  currentSeconds(now).pipe(Effect.flatMap((timestamp) => verifyToken(token, secret, "access", timestamp)))

export const verifyRefreshToken = (token: string, secret: string, now?: number): Effect.Effect<boolean, WebAuthError, AuthState> =>
  currentSeconds(now).pipe(Effect.flatMap((timestamp) => verifyToken(token, secret, "refresh", timestamp)))

export const verifyPassword = (password: string, hash: string): Effect.Effect<boolean, WebAuthError> =>
  Effect.tryPromise({
    try: () => Bun.password.verify(password, hash),
    catch: (cause) => new WebAuthError({ operation: "password", message: "password verification failed", cause }),
  })
