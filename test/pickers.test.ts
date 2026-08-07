import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Live, Pickers } from "../src/telegram/pickers.js"

const run = <A>(effect: Effect.Effect<A, never, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Live)))

describe("Pickers", () => {
  test("registerDirectory and take round-trip", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const token = yield* pickers.registerDirectory({ directory: "/project-x", chatId: 1 })
        const entry = yield* pickers.take(token, 1, 0)
        return { token, entry }
      }).pipe(Effect.provide(Live)),
    )
    expect(result.token).toBe(1)
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) {
      expect(result.entry.value).toEqual({ directory: "/project-x", chatId: 1, messageId: 0 })
    }
  })

  test("registerSession keeps session id, directory and title", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const token = yield* pickers.registerSession({
          sessionID: "ses_1",
          directory: "/project-x",
          title: Option.some("My session"),
          chatId: 1,
        })
        return yield* pickers.take(token, 1, 0)
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(result.value).toEqual({
        sessionID: "ses_1",
        directory: "/project-x",
        title: Option.some("My session"),
        chatId: 1,
        messageId: 0,
      })
    }
  })

  test("take returns none after the entry is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const token = yield* pickers.registerDirectory({ directory: "/a", chatId: 1 })
        yield* pickers.take(token, 1, 0)
        return yield* pickers.take(token, 1, 0)
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual(Option.none())
  })

  test("tokens increment", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const t1 = yield* pickers.registerDirectory({ directory: "/a", chatId: 1 })
        const t2 = yield* pickers.registerDirectory({ directory: "/b", chatId: 1 })
        return [t1, t2] as const
      }).pipe(Effect.provide(Live)),
    )
    expect(result).toEqual([1, 2])
  })

  test("take rejects a stale callback without removing the entry", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const token = yield* pickers.registerDirectory({ directory: "/a", chatId: 1 })
        yield* pickers.attachMessageId(token, 10)
        const stale = yield* pickers.take(token, 1, 9)
        const current = yield* pickers.take(token, 1, 10)
        return { stale, current }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isNone(result.stale)).toBe(true)
    expect(Option.isSome(result.current)).toBe(true)
  })

  test("cancel removes all entries for the picker message", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const session = yield* pickers.registerSession({
          sessionID: "ses_1", directory: "/a", title: Option.none(), chatId: 1,
        })
        const page = yield* pickers.registerSessionPage({ directory: "/a", chatId: 1 })
        yield* pickers.attachMessageId(session, 10)
        yield* pickers.attachMessageId(page, 10)
        const cancelled = yield* pickers.cancel(page, 1, 10)
        const remaining = yield* pickers.take(session, 1, 10)
        return { cancelled, remaining }
      }).pipe(Effect.provide(Live)),
    )
    expect(Option.isSome(result.cancelled)).toBe(true)
    expect(Option.isNone(result.remaining)).toBe(true)
  })
})
