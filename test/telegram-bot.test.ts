import { Cause, Data, Deferred, Effect, Exit, Fiber, FiberMap } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, test } from "bun:test"
import {
  awaitUpdateCapacity,
  dropUpdateBacklog,
  isPollingConflict,
  isStaleUpdate,
  makeUpdateAcknowledgements,
  MAX_CONCURRENT_UPDATES,
  processUpdate,
} from "../src/telegram/bot.js"
import { ApiError } from "../src/telegram/api.js"

class TestFailure extends Data.TaggedError("TestFailure")<{}> {}

const update = { update_id: 41 }

test("detects a competing Telegram getUpdates poller", () => {
  expect(isPollingConflict(Cause.fail(new ApiError({
    operation: "getUpdates",
    code: 409,
    description: "Conflict",
    transient: false,
  })))).toBe(true)
  expect(isPollingConflict(Cause.fail(new ApiError({
    operation: "getUpdates",
    code: 502,
    description: "Bad Gateway",
    transient: true,
  })))).toBe(false)
})

test("processUpdate advances the offset after successful handling", async () => {
  const acknowledgements = await Effect.runPromise(makeUpdateAcknowledgements(0))
  await Effect.runPromise(acknowledgements.register([update]))

  await Effect.runPromise(processUpdate(update, Effect.void, acknowledgements.complete(update.update_id)))

  expect(await Effect.runPromise(acknowledgements.current)).toBe(42)
})

test("quarantines a failed update and advances the offset", async () => {
  const acknowledgements = await Effect.runPromise(makeUpdateAcknowledgements(0))
  await Effect.runPromise(acknowledgements.register([update]))
  let attempts = 0
  const failure = new Error("handler failed")
  const handler = Effect.sync(() => {
    attempts += 1
    return Effect.fail(failure)
  }).pipe(Effect.flatten)

  const result = await Effect.runPromiseExit(processUpdate(
    update,
    handler,
    acknowledgements.complete(update.update_id),
  ))

  expect(Exit.isSuccess(result)).toBe(true)
  expect(attempts).toBe(1)
  expect(await Effect.runPromise(acknowledgements.current)).toBe(42)
})

test("retries a transient update failure before advancing the offset", async () => {
  const acknowledgements = await Effect.runPromise(makeUpdateAcknowledgements(0))
  await Effect.runPromise(acknowledgements.register([update]))
  let attempts = 0
  const handler = Effect.suspend(() => {
    attempts += 1
    return attempts < 3
      ? Effect.fail({ transient: true })
      : Effect.void
  })

  await Effect.runPromise(processUpdate(
    update,
    handler,
    acknowledgements.complete(update.update_id),
    (error) => error.transient,
  ))

  expect(attempts).toBe(3)
  expect(await Effect.runPromise(acknowledgements.current)).toBe(42)
})

test("does not acknowledge a slow older update when a newer update finishes first", async () => {
  const acknowledgements = await Effect.runPromise(makeUpdateAcknowledgements(0))
  const older = { update_id: 41 }
  const newer = { update_id: 42 }
  await Effect.runPromise(acknowledgements.register([older, newer]))

  await Effect.runPromise(processUpdate(
    newer,
    Effect.void,
    acknowledgements.complete(newer.update_id),
  ))
  expect(await Effect.runPromise(acknowledgements.current)).toBe(41)
  expect(await Effect.runPromise(acknowledgements.isCompleted(newer.update_id))).toBe(true)

  await Effect.runPromiseExit(processUpdate(
    older,
    Effect.fail(new TestFailure()),
    acknowledgements.complete(older.update_id),
  ))

  expect(await Effect.runPromise(acknowledgements.current)).toBe(43)
})

test("drops the update backlog by starting after the newest update", async () => {
  const api = {
    getUpdates: (offset: number, timeoutSeconds: number) => {
      expect(offset).toBe(-1)
      expect(timeoutSeconds).toBe(0)
      return Effect.succeed([{ update_id: 7 }, { update_id: 41 }]).pipe(
        Effect.provide(FetchHttpClient.layer),
      )
    },
  }

  expect(await Effect.runPromise(
    Effect.provide(dropUpdateBacklog(api), FetchHttpClient.layer),
  )).toBe(42)
})

test("starts from the oldest update when the backlog cannot be read", async () => {
  const api = {
    getUpdates: () => Effect.fail(new ApiError({ operation: "getUpdates", transient: true })).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  }

  expect(await Effect.runPromise(
    Effect.provide(dropUpdateBacklog(api), FetchHttpClient.layer),
  )).toBe(0)
})

test("marks updates below the confirmed offset as stale", () => {
  expect(isStaleUpdate(42, 41)).toBe(true)
  expect(isStaleUpdate(41, 41)).toBe(false)
  expect(isStaleUpdate(0, 41)).toBe(false)
})

test("waits for one of eight active update handlers before admitting another", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fibers = yield* FiberMap.make<number, void, unknown>()
    const releases = yield* Effect.forEach(
      Array.from({ length: MAX_CONCURRENT_UPDATES }),
      () => Deferred.make<void>(),
    )
    for (let index = 0; index < releases.length; index += 1) {
      const release = releases[index]
      if (release === undefined) continue
      yield* FiberMap.run(fibers, index, Deferred.await(release))
    }
    expect(yield* FiberMap.size(fibers)).toBe(MAX_CONCURRENT_UPDATES)

    const capacity = yield* Effect.forkChild(awaitUpdateCapacity(fibers))
    yield* Effect.yieldNow
    expect(capacity.pollUnsafe()).toBeUndefined()

    const first = releases[0]
    if (first !== undefined) yield* Deferred.succeed(first, undefined)
    yield* Fiber.join(capacity)
    return yield* FiberMap.size(fibers)
  })))

  expect(result).toBe(MAX_CONCURRENT_UPDATES - 1)
})
