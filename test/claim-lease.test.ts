import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { withClaimLease } from "../src/telegram/handlers/claim-lease.js"

describe("interaction claim lease", () => {
  test("does not cross the external boundary when the initial generation check fails", async () => {
    let externalCalls = 0
    const exit = await Effect.runPromise(withClaimLease(
      1,
      Effect.sync(() => { externalCalls += 1 }),
      Effect.succeed(false),
    ).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(externalCalls).toBe(0)
  })

  test("interrupts a long external operation when a heartbeat loses ownership", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const renewals = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const renew = Ref.updateAndGet(renewals, (count) => count + 1).pipe(Effect.map((count) => count === 1))
      const fiber = yield* Effect.forkChild(withClaimLease(
        1,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        renew,
      ))
      yield* Deferred.await(started)
      yield* TestClock.adjust("30 seconds")
      return { exit: yield* Fiber.await(fiber), renewals: yield* Ref.get(renewals) }
    }).pipe(Effect.provide(TestClock.layer())))
    expect(Exit.isFailure(result.exit)).toBe(true)
    expect(result.renewals).toBe(2)
  })
})
