import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Live, ModelRegistry, type ModelEntry, type PageModel } from "../src/telegram/models.js"

const run = <A>(effect: Effect.Effect<A, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Live)))

const models: readonly PageModel[] = [
  { id: "m1", providerID: "p1", variants: [] },
  { id: "m2", providerID: "p2", variants: ["a", "b"] },
]

describe("ModelRegistry", () => {
  test("registerPage and take round-trip", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const token = yield* registry.registerPage({
          sessionID: "ses_1",
          models,
          page: 0,
          total: 2,
          chatId: 7,
        })
        const entry = yield* registry.take(token, 7, 0)
        return { token, entry }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.token).toBe(1)
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) {
      const value: ModelEntry = result.entry.value
      expect(value.kind).toBe("page")
      if (value.kind === "page") {
        expect(value.models).toEqual(models)
        expect(value.page).toBe(0)
        expect(value.total).toBe(2)
        expect(value.messageId).toBe(0)
      }
    }
  })

  test("take returns none after the entry is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const token = yield* registry.registerPage({
          sessionID: "s", models, page: 0, total: 2, chatId: 1,
        })
        yield* registry.take(token, 1, 0)
        return yield* registry.take(token, 1, 0)
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual(Option.none())
  })

  test("attachMessageId updates the stored entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const token = yield* registry.registerPage({
          sessionID: "s", models, page: 0, total: 2, chatId: 1,
        })
        yield* registry.attachMessageId(token, 99)
        const entry = yield* registry.take(token, 1, 99)
        return Option.isSome(entry) ? entry.value.messageId : -1
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toBe(99)
  })

  test("registerVariant stores a variant entry with message id", async () => {
    const entry = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const token = yield* registry.registerVariant({
          sessionID: "s", providerID: "p", modelID: "m", variants: ["v1", "v2"], chatId: 1, messageId: 5,
        })
        return yield* registry.take(token, 1, 5)
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(entry)).toBe(true)
    if (Option.isSome(entry)) {
      const value: ModelEntry = entry.value
      expect(value.kind).toBe("variant")
      if (value.kind === "variant") {
        expect(value.variants).toEqual(["v1", "v2"])
        expect(value.messageId).toBe(5)
      }
    }
  })

  test("tokens are unique and increment", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const t1 = yield* registry.registerPage({
          sessionID: "s", models, page: 0, total: 2, chatId: 1,
        })
        const t2 = yield* registry.registerVariant({
          sessionID: "s", providerID: "p", modelID: "m", variants: ["v"], chatId: 1, messageId: 5,
        })
        return [t1, t2] as const
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual([1, 2])
  })

  test("take rejects a stale callback without removing the entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const token = yield* registry.registerPage({
          sessionID: "s", models, page: 0, total: 2, chatId: 1,
        })
        yield* registry.attachMessageId(token, 10)
        const stale = yield* registry.take(token, 1, 9)
        const current = yield* registry.take(token, 1, 10)
        return { stale, current }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isNone(result.stale)).toBe(true)
    expect(Option.isSome(result.current)).toBe(true)
  })

  test("cancel removes all entries for the picker message", async () => {
    const result = await run(
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const page = yield* registry.registerPage({
          sessionID: "s", models, page: 0, total: 2, chatId: 1,
        })
        const variant = yield* registry.registerVariant({
          sessionID: "s", providerID: "p", modelID: "m", variants: ["v"], chatId: 1, messageId: 10,
        })
        yield* registry.attachMessageId(page, 10)
        const cancelled = yield* registry.cancel(page, 1, 10)
        const remaining = yield* registry.take(variant, 1, 10)
        return { cancelled, remaining }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result.cancelled)).toBe(true)
    expect(Option.isNone(result.remaining)).toBe(true)
  })
})
