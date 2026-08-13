import { Effect, Exit, Ref } from "effect"
import { expect, test } from "bun:test"
import { processUpdate } from "../src/telegram/bot.js"

const update = { update_id: 41 }

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
