import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Live, PermissionRegistry, PERMISSION_TTL_MS, hasExpired, type PendingPermission } from "../src/telegram/permissions.js"

const run = <A>(effect: Effect.Effect<A, never, PermissionRegistry>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Live)))

describe("PermissionRegistry", () => {
  test("register returns a token; take returns the entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({
          sessionID: "ses_1",
          requestID: "per_1",
          chatId: 7,
        })
        const entry = yield* registry.take(token)
        return { token, entry }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.token).toBe(1)
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) {
      const value: PendingPermission = result.entry.value
      expect(value.sessionID).toBe("ses_1")
      expect(value.requestID).toBe("per_1")
      expect(value.chatId).toBe(7)
      expect(value.messageId).toBe(0)
      expect(value.timeCreated).toBeGreaterThan(0)
    }
  })

  test("take removes the entry; second take is none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({ sessionID: "s", requestID: "p", chatId: 1 })
        yield* registry.take(token)
        return yield* registry.take(token)
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual(Option.none())
  })

  test("attachMessageId updates the stored entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({ sessionID: "s", requestID: "p", chatId: 1 })
        yield* registry.attachMessageId(token, 42)
        const entry = yield* registry.take(token)
        return Option.isSome(entry) ? entry.value.messageId : -1
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toBe(42)
  })

  test("claim removes an entry atomically", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        yield* registry.attachMessageId(token, 10)
        const first = yield* registry.claim(token, 1, 10)
        const second = yield* registry.claim(token, 1, 10)
        return { first, second }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result.first)).toBe(true)
    expect(Option.isNone(result.second)).toBe(true)
  })

  test("claim rejects a callback from another message without removing the entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        yield* registry.attachMessageId(token, 10)
        const stale = yield* registry.claim(token, 1, 9)
        const current = yield* registry.claim(token, 1, 10)
        return { stale, current }
      }),
    )
    expect(Option.isNone(result.stale)).toBe(true)
    expect(Option.isSome(result.current)).toBe(true)
  })

  test("tokens increment per registration", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const t1 = yield* registry.register({ sessionID: "s", requestID: "p1", chatId: 1 })
        const t2 = yield* registry.register({ sessionID: "s", requestID: "p2", chatId: 1 })
        return [t1, t2] as const
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual([1, 2])
  })
})

describe("hasExpired", () => {
  test("expires after the ttl", () => {
    expect(hasExpired(1000, 1000 + PERMISSION_TTL_MS + 1)).toBe(true)
    expect(hasExpired(1000, 1000 + PERMISSION_TTL_MS)).toBe(false)
    expect(hasExpired(1000, 1000)).toBe(false)
  })

  test("respects a custom ttl", () => {
    expect(hasExpired(1000, 1005, 10)).toBe(false)
    expect(hasExpired(1000, 1011, 10)).toBe(true)
  })
})
