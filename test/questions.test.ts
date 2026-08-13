import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Live, QuestionRegistry, QUESTION_TTL_MS, hasExpired, isComplete } from "../src/telegram/questions.js"
import { InteractionStore, InteractionStoreMemory, type InteractionStoreError } from "../src/telegram/interaction-store.js"

const run = <A>(effect: Effect.Effect<A, InteractionStoreError, QuestionRegistry | InteractionStore>) =>
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

const base = {
  sessionID: "ses_1",
  requestID: "que_1",
  chatId: 7,
  questions: ["q1", "q2"],
  options: [["a", "b"], ["x"]],
  customs: [false, true],
  multiples: [true, false],
}

describe("QuestionRegistry", () => {
  test("restores partial answers and message ids after a registry restart", async () => {
    const store = persistentStore()
    const token = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.attachMessageId(token, 0, 77)
      yield* registry.answer(token, 0, ["a"])
      return token
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const restored = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      return yield* registry.get(token)
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(Option.isSome(restored)).toBe(true)
    if (Option.isSome(restored)) {
      expect(restored.value.messageIds).toEqual([77, 0])
      expect(restored.value.answers).toEqual([["a"], undefined])
    }
  })

  test("derives a chat route for legacy persisted questions", async () => {
    const store = InteractionStoreMemory
    const result = await Effect.runPromise(Effect.gen(function* () {
      const persistence = yield* InteractionStore
      yield* persistence.set("questions", {
        next: 2,
        entries: [{
          token: 1,
          sessionID: "ses_legacy",
          requestID: "req_legacy",
          chatId: 17,
          questions: ["Continue?"],
          options: [[]],
          customs: [true],
          multiples: [false],
          selections: [[]],
          answers: [{ answered: false, value: [] }],
          messageIds: [0],
          timeCreated: Date.now(),
        }],
      })
      const registry = yield* QuestionRegistry
      return yield* registry.getSessionRoute("ses_legacy")
    }).pipe(Effect.provide(Live), Effect.provide(store)))

    expect(result).toEqual(Option.some({ chatId: 17 }))
  })

  test("register creates an unanswered request", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        const entry = yield* registry.get(token)
        return { token, entry }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.token).toBe(1)
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) {
      expect(result.entry.value.answers).toEqual([undefined, undefined])
      expect(result.entry.value.selections).toEqual([[], []])
      expect(result.entry.value.messageIds).toEqual([0, 0])
      expect(isComplete(result.entry.value)).toBe(false)
    }
  })

  test("registerIfAbsent prevents duplicate requests atomically", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const first = yield* registry.registerIfAbsent(base)
        const second = yield* registry.registerIfAbsent(base)
        return { first, second }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result.first)).toBe(true)
    expect(Option.isNone(result.second)).toBe(true)
  })

  test("resumes only missing Telegram question messages after restart", async () => {
    const store = persistentStore()
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.registerOrResume(base)
      if (Option.isSome(token)) yield* registry.attachMessageId(token.value, 0, 77)
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.registerOrResume(base)
      const entry = Option.isSome(token) ? yield* registry.get(token.value) : Option.none()
      return { token, entry }
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(result.token).toEqual(Option.some(1))
    expect(Option.isSome(result.entry) && result.entry.value.messageIds).toEqual([77, 0])
  })

  test("route transfer re-surfaces only unanswered delivered questions", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.attachMessageId(token, 0, 77)
      yield* registry.attachMessageId(token, 1, 78)
      yield* registry.answer(token, 0, ["a"])
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      return yield* registry.get(token)
    }))

    expect(Option.isSome(result) && result.value.messageIds).toEqual([77, 0])
  })

  test("route transfer retries a definitively rejected unanswered question at the new destination", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      const generation = yield* registry.claimDeliveryWithGeneration(token, 0, 7)
      if (Option.isSome(generation)) yield* registry.rejectDeliveryWithGeneration(token, 0, 7, generation.value)
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      return yield* registry.registerOrResume({ ...base, chatId: 7 })
    }))

    expect(result).toEqual(Option.some(1))
  })

  test("repeating a route transfer to the same topic does not reset delivered questions", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.setSessionRoute("ses_1", { chatId: 7, threadId: 9 })
      yield* registry.attachMessageId(token, 0, 77)
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      return yield* registry.get(token)
    }))

    expect(Option.isSome(result) && result.value.messageIds[0]).toBe(77)
  })

  test("question routing still catches up after permission routing moved independently", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.setSessionRoute("ses_1", { chatId: 7, threadId: 4 })
      yield* registry.attachMessageId(token, 0, 77)
      // A previous partial transfer changed only the permission registry.
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      return yield* registry.get(token)
    }))

    expect(Option.isSome(result) && result.value.messageIds[0]).toBe(0)
  })

  test("persists and reads question routes independently", async () => {
    const route = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      yield* registry.setSessionRoute("ses_1", { chatId: 9, threadId: 4 })
      return yield* registry.getSessionRoute("ses_1")
    }))

    expect(route).toEqual(Option.some({ chatId: 9, threadId: 4 }))
  })

  test("route transfer fences an in-flight question and rejects its late sender", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      const generation = yield* registry.claimDeliveryWithGeneration(token, 0, 7)
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      if (Option.isSome(generation)) yield* registry.attachMessageId(token, 0, 99, generation.value)
      return {
        reviews: yield* registry.listUncertainDeliveries(7),
        entry: yield* registry.get(token),
      }
    }))

    expect(result.reviews[0]?.questionIndex).toBe(0)
    expect(Option.isSome(result.entry) && result.entry.value.messageIds[0]).toBe(-1)
  })

  test("route transfer clears selections that replacement multi-select prompts do not display", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.attachMessageId(token, 0, 77)
      yield* registry.toggleSelection(token, 0, "a")
      yield* registry.rerouteSession("ses_1", { chatId: 7, threadId: 9 })
      return yield* registry.get(token)
    }))

    expect(Option.isSome(result) && result.value.messageIds[0]).toBe(0)
    expect(Option.isSome(result) && result.value.selections[0]).toEqual([])
  })

  test("failed reply restoration keeps questions delivered at the replacement route", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.attachMessageId(token, 0, 77)
      yield* registry.attachMessageId(token, 1, 78)
      yield* registry.answer(token, 0, ["a"])
      yield* registry.answer(token, 1, ["x"])
      const claim = yield* registry.claimComplete(token)
      yield* registry.rerouteSession("ses_1", { chatId: 9, threadId: 9 })
      const firstDelivery = yield* registry.claimDeliveryWithGeneration(token, 0, 9)
      if (Option.isSome(firstDelivery)) yield* registry.attachMessageId(token, 0, 97, firstDelivery.value)
      const secondDelivery = yield* registry.claimDeliveryWithGeneration(token, 1, 9)
      if (Option.isSome(secondDelivery)) yield* registry.attachMessageId(token, 1, 98, secondDelivery.value)
      if (Option.isSome(claim)) yield* registry.restoreClaim(claim.value)
      return yield* registry.getForMessage(token, 0, 9, 97)
    }))

    expect(Option.isSome(result)).toBe(true)
    expect(Option.isSome(result) && result.value.chatId).toBe(9)
    expect(Option.isSome(result) && result.value.messageIds).toEqual([97, 98])
  })

  test("does not resend a question whose Telegram delivery outcome is uncertain", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.registerOrResume(base)
      if (Option.isSome(token)) yield* registry.attachMessageId(token.value, 0, -1)
      const resumed = yield* registry.registerOrResume(base)
      const entry = Option.isSome(resumed) ? yield* registry.get(resumed.value) : Option.none()
      const reviews = yield* registry.listUncertainDeliveries(7)
      const wrongChat = Option.isSome(token) && (yield* registry.retryUncertainDelivery(token.value, 0, 8))
      const retry = Option.isSome(token) && (yield* registry.retryUncertainDelivery(token.value, 0, 7))
      const afterReview = yield* registry.registerOrResume(base)
      return { resumed, entry, reviews, wrongChat, retry, afterReview }
    }))
    expect(Option.isSome(result.resumed)).toBe(true)
    expect(Option.isSome(result.entry) && result.entry.value.messageIds).toEqual([-1, 0])
    expect(result.reviews).toHaveLength(1)
    expect(result.wrongChat).toBe(false)
    expect(result.retry).toBe(true)
    expect(result.afterReview).toEqual(Option.some(1))
  })

  test("claims a complete request before dispatch and restores it after rejection", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.answer(token, 0, ["a"])
      yield* registry.answer(token, 1, ["x"])
      const claimed = yield* registry.claimComplete(token)
      const absentDuringDispatch = yield* registry.get(token)
      if (Option.isSome(claimed)) yield* registry.restoreClaim(claimed.value)
      const restored = yield* registry.get(token)
      return { claimed, absentDuringDispatch, restored }
    }))
    expect(Option.isSome(result.claimed)).toBe(true)
    expect(Option.isNone(result.absentDuringDispatch)).toBe(true)
    expect(Option.isSome(result.restored)).toBe(true)
  })

  test("keeps a reply claim fenced across restart", async () => {
    const store = persistentStore()
    const token = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.answer(token, 0, ["a"])
      yield* registry.answer(token, 1, ["x"])
      yield* registry.claimComplete(token)
      return token
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    const replay = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      return yield* registry.claimComplete(token)
    }).pipe(Effect.provide(Live), Effect.provide(store)))
    expect(Option.isNone(replay)).toBe(true)
  })

  test("allows only one process to claim each unsent Telegram question", async () => {
    const store = persistentStore()
    const result = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.gen(function* () { return yield* QuestionRegistry }).pipe(Effect.provide(Live))
      const second = yield* Effect.gen(function* () { return yield* QuestionRegistry }).pipe(Effect.provide(Live))
      const token = yield* first.registerOrResume(base)
      if (Option.isNone(token)) return []
      return yield* Effect.all([
        first.claimDelivery(token.value, 0, 7),
        second.claimDelivery(token.value, 0, 7),
      ], { concurrency: "unbounded" })
    }).pipe(Effect.provide(store)))
    expect(result.filter(Boolean)).toHaveLength(1)
  })

  test("keeps a definitive Telegram rejection fenced until operator retry", async () => {
    const result = await run(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.registerOrResume(base)
      if (Option.isNone(token)) return undefined
      const claimed = yield* registry.claimDelivery(token.value, 0, 7)
      const rejected = yield* registry.rejectDelivery(token.value, 0, 7)
      const automaticRetry = yield* registry.claimDelivery(token.value, 0, 7)
      const reviews = yield* registry.listUncertainDeliveries(7)
      const operatorRetry = yield* registry.retryUncertainDelivery(token.value, 0, 7)
      return { claimed, rejected, automaticRetry, reviews, operatorRetry }
    }))
    expect(result?.claimed).toBe(true)
    expect(result?.rejected).toBe(true)
    expect(result?.automaticRetry).toBe(false)
    expect(result?.reviews[0]?.failure).toBe("rejected")
    expect(result?.operatorRetry).toBe(true)
  })

  test("moves an abandoned in-flight question to review instead of allowing immediate retry", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.registerOrResume(base)
      if (Option.isNone(token)) return undefined
      const claimed = yield* registry.claimDelivery(token.value, 0, 7)
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
      const first = yield* Effect.gen(function* () { return yield* QuestionRegistry }).pipe(Effect.provide(Live))
      const second = yield* Effect.gen(function* () { return yield* QuestionRegistry }).pipe(Effect.provide(Live))
      const token = yield* first.register(base)
      yield* first.answer(token, 0, ["a"])
      yield* first.answer(token, 1, ["x"])
      const oldClaim = yield* first.claimComplete(token)
      yield* TestClock.adjust("121 seconds")
      const newClaim = yield* second.claimComplete(token)
      if (Option.isNone(oldClaim) || Option.isNone(newClaim)) return undefined
      return {
        differentGeneration: oldClaim.value.generation !== newClaim.value.generation,
        oldRenewed: yield* first.renewClaim(token, oldClaim.value.generation),
        oldRestored: yield* first.restoreClaim(oldClaim.value),
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

  test("renews an in-process reply claim for a long external request", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register(base)
      yield* registry.answer(token, 0, ["a"])
      yield* registry.answer(token, 1, ["x"])
      const first = yield* registry.claimComplete(token)
      yield* TestClock.adjust("90 seconds")
      const renewed = Option.isSome(first) && (yield* registry.renewClaim(token, first.value.generation))
      yield* TestClock.adjust("90 seconds")
      yield* registry.registerOrResume(base)
      const second = yield* registry.claimComplete(token)
      return { first, renewed, second }
    }).pipe(Effect.provide(Live), Effect.provide(InteractionStoreMemory), Effect.provide(TestClock.layer())))
    expect(Option.isSome(result.first)).toBe(true)
    expect(result.renewed).toBe(true)
    expect(Option.isNone(result.second)).toBe(true)
  })

  test("attachMessageId records the question message ids", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        yield* registry.attachMessageId(token, 0, 10)
        yield* registry.attachMessageId(token, 1, 11)
        const entry = yield* registry.get(token)
        return Option.isSome(entry) ? entry.value.messageIds : []
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual([10, 11])
  })

  test("toggleSelection accumulates and toggles labels", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        yield* registry.toggleSelection(token, 0, "a")
        yield* registry.toggleSelection(token, 0, "b")
        const afterAdd = yield* registry.get(token)
        yield* registry.toggleSelection(token, 0, "a")
        const afterRemove = yield* registry.get(token)
        return {
          afterAdd: Option.isSome(afterAdd) ? afterAdd.value.selections[0] : [],
          afterRemove: Option.isSome(afterRemove) ? afterRemove.value.selections[0] : [],
        }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.afterAdd).toEqual(["a", "b"])
    expect(result.afterRemove).toEqual(["b"])
  })

  test("toggleSelection returns none for unknown token or index", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        const unknown = yield* registry.toggleSelection(999, 0, "a")
        const badIndex = yield* registry.toggleSelection(token, 5, "a")
        return { unknown, badIndex }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.unknown).toEqual(Option.none())
    expect(result.badIndex).toEqual(Option.none())
  })

  test("answer records values per question", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        const afterFirst = yield* registry.answer(token, 0, ["a"])
        const afterSecond = yield* registry.answer(token, 1, ["custom text"])
        return {
          first: Option.isSome(afterFirst) ? afterFirst.value.answers : [],
          second: Option.isSome(afterSecond) ? afterSecond.value.answers : [],
          complete: Option.isSome(afterSecond) ? isComplete(afterSecond.value) : false,
        }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.first).toEqual([["a"], undefined])
    expect(result.second).toEqual([["a"], ["custom text"]])
    expect(result.complete).toBe(true)
  })

  test("answer returns none for unknown token or index", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        const unknown = yield* registry.answer(999, 0, ["a"])
        const badIndex = yield* registry.answer(token, 5, ["a"])
        return { unknown, badIndex }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.unknown).toEqual(Option.none())
    expect(result.badIndex).toEqual(Option.none())
  })

  test("findByMessage locates a request by question message id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        yield* registry.attachMessageId(token, 0, 10)
        const found = yield* registry.findByMessage(7, 10)
        const missing = yield* registry.findByMessage(7, 99)
        const wrongChat = yield* registry.findByMessage(8, 10)
        return { found, missing, wrongChat }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result.found)).toBe(true)
    expect(result.missing).toEqual(Option.none())
    expect(result.wrongChat).toEqual(Option.none())
  })

  test("findByMessage does not remove the entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        yield* registry.attachMessageId(token, 0, 10)
        yield* registry.findByMessage(7, 10)
        return yield* registry.get(token)
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result)).toBe(true)
  })

  test("getForMessage rejects a stale callback", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register({
          sessionID: "s",
          requestID: "r",
          chatId: 1,
          questions: ["Question?"],
          options: [["Yes"]],
          customs: [false],
          multiples: [false],
        })
        yield* registry.attachMessageId(token, 0, 10)
        const stale = yield* registry.getForMessage(token, 0, 1, 9)
        const current = yield* registry.getForMessage(token, 0, 1, 10)
        return { stale, current }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isNone(result.stale)).toBe(true)
    expect(Option.isSome(result.current)).toBe(true)
  })

  test("remove deletes the request", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const token = yield* registry.register(base)
        yield* registry.remove(token)
        return yield* registry.get(token)
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual(Option.none())
  })
})

describe("hasExpired", () => {
  test("expires after the ttl", () => {
    expect(hasExpired(1000, 1000 + QUESTION_TTL_MS + 1)).toBe(true)
    expect(hasExpired(1000, 1000 + QUESTION_TTL_MS)).toBe(false)
  })

  test("respects a custom ttl", () => {
    expect(hasExpired(1000, 1005, 10)).toBe(false)
    expect(hasExpired(1000, 1011, 10)).toBe(true)
  })
})
