import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Live, PermissionRegistry, PERMISSION_TTL_MS, hasExpired, type PendingPermission } from "../src/telegram/permissions.js"
import { InteractionStore, InteractionStoreMemory, type InteractionStoreError, type JsonValue } from "../src/telegram/interaction-store.js"

const run = <A>(effect: Effect.Effect<A, InteractionStoreError, PermissionRegistry | InteractionStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Live), Effect.provide(InteractionStoreMemory)))

const persistentStore = () => {
  const values = new Map<string, unknown>()
  return Layer.succeed(InteractionStore, {
    get: (key) => Effect.succeed(Option.fromNullishOr(values.get(key))),
    set: (key, value) => Effect.sync(() => { values.set(key, value) }),
    modify: (key, change) => Effect.sync(() => {
      const [result, value] = change(Option.fromNullishOr(values.get(key)))
      values.set(key, value)
      return result
    }),
  })
}

describe("PermissionRegistry", () => {
  test("restores pending permissions and routes after a registry restart", async () => {
    const store = persistentStore()
    const token = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_restart", { chatId: 7, threadId: 42 })
      const token = yield* registry.register({ sessionID: "ses_restart", requestID: "req_restart", chatId: 7 })
      yield* registry.attachMessageId(token, 99)
      return token
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const restored = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      return { entry: yield* registry.take(token), route: yield* registry.getSessionRoute("ses_restart") }
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(firstValue(restored.entry)?.messageId).toBe(99)
    expect(firstValue(restored.route)).toEqual({ chatId: 7, threadId: 42 })
  })

  test("keeps one source destination for each session", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        yield* registry.setSessionRoute("ses_1", { chatId: 7, threadId: 42 })
        const first = yield* registry.getSessionRoute("ses_1")
        yield* registry.setSessionRoute("ses_1", { chatId: 8 })
        const replaced = yield* registry.getSessionRoute("ses_1")
        const missing = yield* registry.getSessionRoute("ses_2")
        return { first, replaced, missing }
      }),
    )
    expect(firstValue(result.first)).toEqual({ chatId: 7, threadId: 42 })
    expect(firstValue(result.replaced)).toEqual({ chatId: 8 })
    expect(Option.isNone(result.missing)).toBe(true)
  })

  test("explicit route replacement moves the session destination", async () => {
    const route = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_route", { chatId: 7, threadId: 4 })
      yield* registry.setSessionRoute("ses_route", { chatId: 9 })
      return yield* registry.getSessionRoute("ses_route")
    }))

    expect(route).toEqual(Option.some({ chatId: 9 }))
  })

  test("route transfer makes a delivered permission eligible at the new destination", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_route", { chatId: 7, threadId: 4 })
      const token = yield* registry.register({ sessionID: "ses_route", requestID: "req", chatId: 7 })
      yield* registry.attachMessageId(token, 99)
      const changed = yield* registry.rerouteSession("ses_route", { chatId: 7, threadId: 8 })
      return { changed, resumed: yield* registry.registerOrResume({ sessionID: "ses_route", requestID: "req", chatId: 7 }) }
    }))

    expect(result.changed).toBe(true)
    expect(result.resumed).toEqual(Option.some(1))
  })

  test("route transfer retries a definitively rejected permission at the new destination", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_route", { chatId: 7, threadId: 4 })
      const token = yield* registry.register({ sessionID: "ses_route", requestID: "req", chatId: 7 })
      const generation = yield* registry.claimDeliveryWithGeneration(token, 7)
      if (Option.isSome(generation)) yield* registry.rejectDeliveryWithGeneration(token, 7, generation.value)
      yield* registry.rerouteSession("ses_route", { chatId: 9, threadId: 8 })
      return yield* registry.registerOrResume({ sessionID: "ses_route", requestID: "req", chatId: 9 })
    }))

    expect(result).toEqual(Option.some(1))
  })

  test("route transfer fences an in-flight permission and rejects its late sender", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_route", { chatId: 7, threadId: 4 })
      const token = yield* registry.register({ sessionID: "ses_route", requestID: "req", chatId: 7 })
      const generation = yield* registry.claimDeliveryWithGeneration(token, 7)
      yield* registry.rerouteSession("ses_route", { chatId: 7, threadId: 8 })
      if (Option.isSome(generation)) yield* registry.attachMessageId(token, 99, generation.value)
      return {
        reviews: yield* registry.listUncertainDeliveries(7),
        resumed: yield* registry.registerOrResume({ sessionID: "ses_route", requestID: "req", chatId: 7 }),
      }
    }))

    expect(result.reviews[0]?.entry.messageId).toBe(-1)
    expect(result.resumed).toEqual(Option.none())
  })

  test("failed reply restoration keeps a prompt delivered at the replacement route", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.setSessionRoute("ses_route", { chatId: 7, threadId: 4 })
      const token = yield* registry.register({ sessionID: "ses_route", requestID: "req", chatId: 7 })
      yield* registry.attachMessageId(token, 77)
      const claim = yield* registry.claim(token, 7, 77)
      yield* registry.rerouteSession("ses_route", { chatId: 9, threadId: 8 })
      const delivery = yield* registry.claimDeliveryWithGeneration(token, 9)
      if (Option.isSome(delivery)) yield* registry.attachMessageId(token, 99, delivery.value)
      if (Option.isSome(claim)) yield* registry.restoreClaim(token, claim.value)
      return yield* registry.getForMessage(token, 9, 99)
    }))

    expect(Option.isSome(result)).toBe(true)
    expect(Option.isSome(result) && result.value.chatId).toBe(9)
    expect(Option.isSome(result) && result.value.messageId).toBe(99)
  })

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

  test("findByRequest finds an active permission without removing it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const token = yield* registry.register({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        const found = yield* registry.findByRequest(1, "ses_1", "req_1")
        const stillPresent = yield* registry.take(token)
        return { found, stillPresent }
      }),
    )
    expect(Option.isSome(result.found)).toBe(true)
    expect(Option.isSome(result.stillPresent)).toBe(true)
  })

  test("registerIfAbsent prevents duplicate requests atomically", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        const first = yield* registry.registerIfAbsent({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        const second = yield* registry.registerIfAbsent({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        return { first, second }
      }),
    )
    expect(Option.isSome(result.first)).toBe(true)
    expect(Option.isNone(result.second)).toBe(true)
  })

  test("resumes an incomplete Telegram delivery after a registry restart", async () => {
    const store = persistentStore()
    const first = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      return yield* registry.registerOrResume({ sessionID: "ses_crash", requestID: "req_crash", chatId: 7 })
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const resumed = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      return yield* registry.registerOrResume({ sessionID: "ses_crash", requestID: "req_crash", chatId: 7 })
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(first).toEqual(Option.some(1))
    expect(resumed).toEqual(first)
  })

  test("does not resurface a permission after its Telegram message is persisted", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const token = yield* registry.registerOrResume({ sessionID: "ses_sent", requestID: "req_sent", chatId: 7 })
      if (Option.isSome(token)) yield* registry.attachMessageId(token.value, 99)
      return yield* registry.registerOrResume({ sessionID: "ses_sent", requestID: "req_sent", chatId: 7 })
    }))
    expect(Option.isNone(result)).toBe(true)
  })

  test("does not resend a permission whose Telegram delivery outcome is uncertain", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const token = yield* registry.registerOrResume({ sessionID: "ses_uncertain", requestID: "req_uncertain", chatId: 7 })
      if (Option.isSome(token)) yield* registry.attachMessageId(token.value, -1)
      const fenced = yield* registry.registerOrResume({ sessionID: "ses_uncertain", requestID: "req_uncertain", chatId: 7 })
      const reviews = yield* registry.listUncertainDeliveries(7)
      const wrongChat = Option.isSome(token) && (yield* registry.retryUncertainDelivery(token.value, 8))
      const retry = Option.isSome(token) && (yield* registry.retryUncertainDelivery(token.value, 7))
      const resumed = yield* registry.registerOrResume({ sessionID: "ses_uncertain", requestID: "req_uncertain", chatId: 7 })
      return { fenced, reviews, wrongChat, retry, resumed }
    }))
    expect(Option.isNone(result.fenced)).toBe(true)
    expect(result.reviews).toHaveLength(1)
    expect(result.wrongChat).toBe(false)
    expect(result.retry).toBe(true)
    expect(result.resumed).toEqual(Option.some(1))
  })

  test("scopes delivery reviews and retries to a session", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const first = yield* registry.registerOrResume({ sessionID: "ses_topic_1", requestID: "req_1", chatId: 7 })
      const second = yield* registry.registerOrResume({ sessionID: "ses_topic_2", requestID: "req_2", chatId: 7 })
      if (Option.isSome(first)) yield* registry.attachMessageId(first.value, -1)
      if (Option.isSome(second)) yield* registry.attachMessageId(second.value, -1)
      const reviews = yield* registry.listUncertainDeliveries(7, "ses_topic_1")
      const crossTopicRetry = Option.isSome(second) &&
        (yield* registry.retryUncertainDelivery(second.value, 7, "ses_topic_1"))
      return { reviews, crossTopicRetry }
    }))

    expect(result.reviews.map(({ entry }) => entry.sessionID)).toEqual(["ses_topic_1"])
    expect(result.crossTopicRetry).toBe(false)
  })

  test("serializes registrations and reply claims across registry instances", async () => {
    const store = persistentStore()
    const makeRegistry = () => Effect.runPromise(Effect.gen(function* () {
      return yield* PermissionRegistry
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const [first, second] = await Promise.all([makeRegistry(), makeRegistry()])
    const tokens = await Effect.runPromise(Effect.all([
      first.register({ sessionID: "ses_a", requestID: "req_a", chatId: 7 }),
      second.register({ sessionID: "ses_b", requestID: "req_b", chatId: 7 }),
    ], { concurrency: "unbounded" }))
    expect(new Set(tokens).size).toBe(2)

    const token = tokens[0]
    if (token !== undefined) {
      await Effect.runPromise(first.attachMessageId(token, 99))
      const claimed = await Effect.runPromise(first.claim(token, 7, 99))
      const replay = await Effect.runPromise(second.registerOrResume({ sessionID: "ses_a", requestID: "req_a", chatId: 7 }))
      expect(Option.isSome(claimed)).toBe(true)
      expect(Option.isNone(replay)).toBe(true)
    }
  })

  test("allows only one process to claim an unsent Telegram prompt", async () => {
    const store = persistentStore()
    const result = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.gen(function* () { return yield* PermissionRegistry }).pipe(Effect.provide(Live))
      const second = yield* Effect.gen(function* () { return yield* PermissionRegistry }).pipe(Effect.provide(Live))
      const token = yield* first.registerOrResume({ sessionID: "ses_delivery", requestID: "req_delivery", chatId: 7 })
      if (Option.isNone(token)) return []
      return yield* Effect.all([
        first.claimDelivery(token.value, 7),
        second.claimDelivery(token.value, 7),
      ], { concurrency: "unbounded" })
    }).pipe(Effect.provide(store)))
    expect(result.filter(Boolean)).toHaveLength(1)
  })

  test("keeps a definitive Telegram rejection fenced until operator retry", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const token = yield* registry.registerOrResume({ sessionID: "ses_rejected", requestID: "req_rejected", chatId: 7 })
      if (Option.isNone(token)) return undefined
      const claimed = yield* registry.claimDelivery(token.value, 7)
      const rejected = yield* registry.rejectDelivery(token.value, 7)
      const automaticRetry = yield* registry.registerOrResume({ sessionID: "ses_rejected", requestID: "req_rejected", chatId: 7 })
      const reviews = yield* registry.listUncertainDeliveries(7)
      const operatorRetry = yield* registry.retryUncertainDelivery(token.value, 7)
      return { claimed, rejected, automaticRetry, reviews, operatorRetry }
    }))
    expect(result?.claimed).toBe(true)
    expect(result?.rejected).toBe(true)
    expect(result?.automaticRetry).toEqual(Option.none())
    expect(result?.reviews[0]?.failure).toBe("rejected")
    expect(result?.operatorRetry).toBe(true)
  })

  test("moves an abandoned in-flight prompt to review instead of allowing immediate retry", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const token = yield* registry.registerOrResume({ sessionID: "ses_in_flight", requestID: "req_in_flight", chatId: 7 })
      if (Option.isNone(token)) return undefined
      const claimed = yield* registry.claimDelivery(token.value, 7)
      const beforeExpiry = yield* registry.listUncertainDeliveries(7)
      yield* TestClock.adjust("121 seconds")
      const afterExpiry = yield* registry.listUncertainDeliveries(7)
      return { claimed, beforeExpiry, afterExpiry }
    }).pipe(Effect.provide(Live), Effect.provide(InteractionStoreMemory), Effect.provide(TestClock.layer())))
    expect(result?.claimed).toBe(true)
    expect(result?.beforeExpiry).toHaveLength(0)
    expect(result?.afterExpiry[0]?.failure).toBe("uncertain")
  })

  test("fences a stale process after another registry takes over an expired claim", async () => {
    const store = persistentStore()
    const result = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.gen(function* () { return yield* PermissionRegistry }).pipe(Effect.provide(Live))
      const second = yield* Effect.gen(function* () { return yield* PermissionRegistry }).pipe(Effect.provide(Live))
      const token = yield* first.register({ sessionID: "ses_takeover", requestID: "req_takeover", chatId: 7 })
      yield* first.attachMessageId(token, 99)
      const oldClaim = yield* first.claim(token, 7, 99)
      yield* TestClock.adjust("121 seconds")
      const newClaim = yield* second.claim(token, 7, 99)
      if (Option.isNone(oldClaim) || Option.isNone(newClaim)) return undefined
      return {
        differentGeneration: oldClaim.value.generation !== newClaim.value.generation,
        oldRenewed: yield* first.renewClaim(token, oldClaim.value.generation),
        oldRestored: yield* first.restoreClaim(token, oldClaim.value),
        oldCompleted: yield* first.completeClaim(token, oldClaim.value.generation),
        newRenewed: yield* second.renewClaim(token, newClaim.value.generation),
      }
    }).pipe(Effect.provide(store), Effect.provide(TestClock.layer())))
    expect(result).toEqual({
      differentGeneration: true,
      oldRenewed: false,
      oldRestored: false,
      oldCompleted: false,
      newRenewed: true,
    })
  })

  test("releases a stale reply claim after restart", async () => {
    const values = new Map<string, JsonValue>([["permissions", {
      next: 2,
      entries: [{ token: 1, entry: {
        sessionID: "ses_reply",
        requestID: "req_reply",
        chatId: 7,
        messageId: 99,
        timeCreated: Date.now(),
        replyingSince: 0,
      } }],
      routes: [],
    }]])
    const store = Layer.succeed(InteractionStore, {
      get: (key: string) => Effect.succeed(Option.fromNullishOr(values.get(key))),
      set: (key: string, value: JsonValue) => Effect.sync(() => { values.set(key, value) }),
      modify: (key: string, change) => Effect.sync(() => {
        const [result, value] = change(Option.fromNullishOr(values.get(key)))
        values.set(key, value)
        return result
      }),
    })
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      yield* registry.registerOrResume({ sessionID: "ses_reply", requestID: "req_reply", chatId: 7 })
      return yield* registry.claim(1, 7, 99)
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(Option.isSome(result)).toBe(true)
  })

  test("findByRequest does not match another chat or request", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* PermissionRegistry
        yield* registry.register({ sessionID: "ses_1", requestID: "req_1", chatId: 1 })
        return {
          chat: yield* registry.findByRequest(2, "ses_1", "req_1"),
          session: yield* registry.findByRequest(1, "ses_2", "req_1"),
          request: yield* registry.findByRequest(1, "ses_1", "req_2"),
        }
      }),
    )
    expect(Option.isNone(result.chat)).toBe(true)
    expect(Option.isNone(result.session)).toBe(true)
    expect(Option.isNone(result.request)).toBe(true)
  })

  test("claim fences a second reply atomically", async () => {
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

  test("renews an in-process reply claim for a long external request", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const token = yield* registry.register({ sessionID: "ses_slow", requestID: "req_slow", chatId: 7 })
      yield* registry.attachMessageId(token, 99)
      const first = yield* registry.claim(token, 7, 99)
      yield* TestClock.adjust("90 seconds")
      const renewed = Option.isSome(first) && (yield* registry.renewClaim(token, first.value.generation))
      yield* TestClock.adjust("90 seconds")
      yield* registry.registerOrResume({ sessionID: "ses_slow", requestID: "req_slow", chatId: 7 })
      const second = yield* registry.claim(token, 7, 99)
      return { first, renewed, second }
    }).pipe(Effect.provide(Live), Effect.provide(InteractionStoreMemory), Effect.provide(TestClock.layer())))
    expect(Option.isSome(result.first)).toBe(true)
    expect(result.renewed).toBe(true)
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

const firstValue = <A>(value: Option.Option<A>): A | undefined =>
  Option.isSome(value) ? value.value : undefined

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
