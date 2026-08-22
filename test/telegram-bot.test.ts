import { Cause, Data, Effect, Exit, Ref } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, test } from "bun:test"
import { dropUpdateBacklog, isPollingConflict, processUpdate } from "../src/telegram/bot.js"
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
  const offset = await Effect.runPromise(Ref.make(0))

  await Effect.runPromise(processUpdate(update, offset, Effect.void))

  expect(await Effect.runPromise(Ref.get(offset))).toBe(42)
})

test("quarantines a failed update and advances the offset", async () => {
  const offset = await Effect.runPromise(Ref.make(0))
  let attempts = 0
  const failure = new Error("handler failed")
  const handler = Effect.sync(() => {
    attempts += 1
    return Effect.fail(failure)
  }).pipe(Effect.flatten)

  const result = await Effect.runPromiseExit(processUpdate(update, offset, handler))

  expect(Exit.isSuccess(result)).toBe(true)
  expect(attempts).toBe(1)
  expect(await Effect.runPromise(Ref.get(offset))).toBe(42)
})

test("retries a transient update failure before advancing the offset", async () => {
  const offset = await Effect.runPromise(Ref.make(0))
  let attempts = 0
  const handler = Effect.suspend(() => {
    attempts += 1
    return attempts < 3
      ? Effect.fail({ transient: true })
      : Effect.void
  })

  await Effect.runPromise(processUpdate(update, offset, handler, (error) => error.transient))

  expect(attempts).toBe(3)
  expect(await Effect.runPromise(Ref.get(offset))).toBe(42)
})

test("never moves the confirmed offset backwards for a slow older update", async () => {
  const offset = await Effect.runPromise(Ref.make(43))

  await Effect.runPromiseExit(processUpdate(
    { update_id: 41 },
    offset,
    Effect.fail(new TestFailure()),
  ))

  expect(await Effect.runPromise(Ref.get(offset))).toBe(43)
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
