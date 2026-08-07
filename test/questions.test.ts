import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Live, QuestionRegistry, QUESTION_TTL_MS, hasExpired, isComplete } from "../src/telegram/questions.js"

const run = <A>(effect: Effect.Effect<A, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Live)))

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
