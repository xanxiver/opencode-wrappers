import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { Live, SessionSelection } from "../src/telegram/session-selection.js"

describe("SessionSelection", () => {
  test("serializes agent and model changes for the same session", async () => {
    const order = await Effect.runPromise(Effect.gen(function* () {
      const selections = yield* SessionSelection
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const events = yield* Ref.make<string[]>([])
      const first = yield* selections.withSession("ses_1", Effect.gen(function* () {
        yield* Ref.update(events, (current) => [...current, "first-entered"])
        yield* Deferred.succeed(firstEntered, undefined)
        yield* Deferred.await(releaseFirst)
        yield* Ref.update(events, (current) => [...current, "first-finished"])
      })).pipe(Effect.forkChild)
      yield* Deferred.await(firstEntered)
      const second = yield* selections.withSession("ses_1", Ref.update(
        events,
        (current) => [...current, "second-entered"],
      )).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      return yield* Ref.get(events)
    }).pipe(Effect.provide(Live)))

    expect(order).toEqual(["first-entered", "first-finished", "second-entered"])
  })

  test("does not serialize different sessions", async () => {
    const completed = await Effect.runPromise(Effect.gen(function* () {
      const selections = yield* SessionSelection
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const first = yield* selections.withSession("ses_1", Effect.gen(function* () {
        yield* Deferred.succeed(firstEntered, undefined)
        yield* Deferred.await(releaseFirst)
      })).pipe(Effect.forkChild)
      yield* Deferred.await(firstEntered)
      const second = yield* selections.withSession("ses_2", Effect.succeed("done"))
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      return second
    }).pipe(Effect.provide(Live)))

    expect(completed).toBe("done")
  })
})
