import { describe, expect, test } from "bun:test"
import { Crypto, Effect, Schema } from "effect"
import { BunCrypto } from "@effect/platform-bun"
import { AuthState, AuthStateLive, claimRefreshToken, issueAccessToken, issueRefreshToken, releaseRefreshToken, revokeToken, verifyAccessToken, verifyRefreshToken } from "../src/web/backend/auth"

const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | AuthState>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AuthStateLive), Effect.provide(BunCrypto.layer)))

describe("web JWT authentication", () => {
  test("issues and verifies a short-lived access token", async () => {
    const result = await run(Effect.gen(function* () {
      const token = yield* issueAccessToken("alice", "a-secret", 1_000)
      return [yield* verifyAccessToken(token, "a-secret", 1_001), yield* verifyAccessToken(token, "wrong-secret", 1_001)]
    }))
    expect(result).toEqual([true, false])
  })

  test("rejects expired tokens", async () => {
    expect(await run(Effect.gen(function* () {
      const token = yield* issueAccessToken("alice", "a-secret", 1_000)
      return yield* verifyAccessToken(token, "a-secret", 1_901)
    }))).toBe(false)
  })

  test("keeps refresh tokens separate from access tokens", async () => {
    const result = await run(Effect.gen(function* () {
      const token = yield* issueRefreshToken("alice", "a-secret", 1_000)
      return [yield* verifyRefreshToken(token, "a-secret", 1_001), yield* verifyAccessToken(token, "a-secret", 1_001)]
    }))
    expect(result).toEqual([true, false])
  })

  test("issues distinct tokens in the same second", async () => {
    const [first, second] = await run(Effect.all([issueRefreshToken("alice", "a-secret", 1_000), issueRefreshToken("alice", "a-secret", 1_000)]))
    expect(second).not.toBe(first)
  })

  test("rejects tokens with a missing or incorrect JWT type", async () => {
    const token = await run(issueAccessToken("alice", "a-secret", 1_000))
    const [header, payload, signature] = token.split(".")
    if (header === undefined || payload === undefined || signature === undefined) throw new Error("issued token is malformed")
    const claims = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
      sub: Schema.String,
      iat: Schema.Number,
      exp: Schema.Number,
      jti: Schema.String,
    })))(Buffer.from(payload, "base64url").toString())
    const unsigned = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`
    const forged = `${unsigned}.${signature}`
    expect(await run(verifyAccessToken(forged, "a-secret", 1_001))).toBe(false)
  })

  test("rejects tokens whose issued-at time is in the future", async () => {
    expect(await run(Effect.gen(function* () {
      const token = yield* issueAccessToken("alice", "a-secret", 2_000)
      return yield* verifyAccessToken(token, "a-secret", 1_001)
    }))).toBe(false)
  })

  test("rejects revoked access and refresh tokens", async () => {
    const result = await run(Effect.gen(function* () {
      const access = yield* issueAccessToken("alice", "a-secret", 1_000)
      const refresh = yield* issueRefreshToken("alice", "a-secret", 1_000)
      yield* revokeToken(access, 1_001)
      yield* revokeToken(refresh, 1_001)
      return [yield* verifyAccessToken(access, "a-secret", 1_001), yield* verifyRefreshToken(refresh, "a-secret", 1_001)]
    }))
    expect(result).toEqual([false, false])
  })

  test("allows only one concurrent refresh claim", async () => {
    const token = "header.payload.signature"
    expect(await run(Effect.gen(function* () {
      const first = yield* claimRefreshToken(token)
      const second = yield* claimRefreshToken(token)
      yield* releaseRefreshToken(token)
      const third = yield* claimRefreshToken(token)
      yield* releaseRefreshToken(token)
      return [first, second, third]
    }))).toEqual([true, false, true])
  })

  test("rejects malformed refresh claims before they enter the in-flight set", async () => {
    expect(await run(Effect.all([
      claimRefreshToken("not-a-jwt"),
      claimRefreshToken("a.b.c.d"),
      claimRefreshToken(`${"a".repeat(4_097)}.b.c`),
    ]))).toEqual([false, false, false])
  })
})
