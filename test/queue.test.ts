import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { RunCoordinator, RunCoordinatorLive, type QueuedRun } from "../src/telegram/handlers/index.js"

const run = <A>(effect: Effect.Effect<A, never, RunCoordinator>) =>
  Effect.runPromise(effect.pipe(Effect.provide(RunCoordinatorLive)))

const item = (n: number): QueuedRun => ({
  message: { message_id: n, chat: { id: 1 } },
  text: `msg ${n}`,
})

describe("RunCoordinator", () => {
  test("nextOrRelease on an empty queue returns none", async () => {
    const result = await run(
      Effect.gen(function* () {
        const runs = yield* RunCoordinator
        yield* runs.claim(1)
        return yield* runs.nextOrRelease(1)
      }),
    )
    expect(result).toEqual(Option.none())
  })

  test("enqueue then dequeue returns the item in FIFO order", async () => {
    const result = await run(
      Effect.gen(function* () {
        const runs = yield* RunCoordinator
        yield* runs.claim(1)
        yield* runs.submit(1, item(1))
        yield* runs.submit(1, item(2))
        const first = yield* runs.nextOrRelease(1)
        const second = yield* runs.nextOrRelease(1)
        const third = yield* runs.nextOrRelease(1)
        return { first, second, third }
      }),
    )
    expect(Option.isSome(result.first)).toBe(true)
    expect(Option.isSome(result.second)).toBe(true)
    if (Option.isSome(result.first)) expect(result.first.value.text).toBe("msg 1")
    if (Option.isSome(result.second)) expect(result.second.value.text).toBe("msg 2")
    expect(result.third).toEqual(Option.none())
  })

  test("queues are per chat", async () => {
    const result = await run(
      Effect.gen(function* () {
        const runs = yield* RunCoordinator
        yield* runs.claim(1)
        yield* runs.submit(1, item(1))
        const other = yield* runs.nextOrRelease(2)
        const own = yield* runs.nextOrRelease(1)
        return { other, own }
      }),
    )
    expect(result.other).toEqual(Option.none())
    expect(Option.isSome(result.own)).toBe(true)
  })

  test("a submit after release claims the chat instead of stranding work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const runs = yield* RunCoordinator
        yield* runs.claim(1)
        const empty = yield* runs.nextOrRelease(1)
        const claimed = yield* runs.submit(1, item(1))
        return { empty, claimed }
      }),
    )
    expect(result.empty).toEqual(Option.none())
    expect(result.claimed).toBe(true)
  })
})
