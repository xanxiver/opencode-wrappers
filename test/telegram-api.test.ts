import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { ApiError, decodeTelegramErrorResponse, decodeTelegramResponse, EDIT_MIN_INTERVAL_GROUP_MS, Live, recordDefinitiveSendFailure, TelegramApi } from "../src/telegram/api.js"
import { finalEditDisposition } from "../src/telegram/durable-executor.js"

describe("Telegram API response decoding", () => {
  test("does not transport-retry non-idempotent message creation", async () => {
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts += 1
      return Effect.fail(new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "response lost" }),
      }))
    })
    const config = Layer.succeed(AppConfigTag, new AppConfig({
      telegramBotToken: "test-token",
      projectDirectory: "/tmp",
      stateFile: "/tmp/state.json",
      webDatabaseFile: "/tmp/web.sqlite",
      telegramRunTimeout: "10 minutes",
      webPort: 3001,
    }))
    await Effect.runPromiseExit(Effect.gen(function* () {
      const api = yield* TelegramApi
      return yield* api.sendMessage({ chatId: 7, text: "hello" })
    }).pipe(
      Effect.provide(Layer.provide(Live, config)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ))
    expect(attempts).toBe(1)
  })
  test("reports malformed JSON as ApiError instead of a defect", async () => {
    const exit = await Effect.runPromiseExit(decodeTelegramResponse("getUpdates", Schema.Array(Schema.Unknown), "{not-json"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error) ? error.value._tag : undefined).toBe("ApiError")
      expect(Cause.hasDies(exit.cause)).toBe(false)
    }
  })

  test("preserves Telegram error descriptions from non-success responses", () => {
    const error = decodeTelegramErrorResponse(
      "editMessageText",
      400,
      JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }),
    )
    expect(error.description).toBe("Bad Request: message is not modified")
    expect(finalEditDisposition(error)).toBe("accepted")
  })

  test("captures retry_after from flood-limited responses", () => {
    const error = decodeTelegramErrorResponse(
      "sendMessage",
      429,
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 17",
        parameters: { retry_after: 17 },
      }),
    )
    expect(error.code).toBe(429)
    expect(error.transient).toBe(true)
    expect(error.retryAfterMs).toBe(17000)
  })

  test("records a durable rejection only after a definitive Telegram failure", async () => {
    let rejections = 0
    const reject = Effect.sync(() => { rejections += 1; return true })
    await Effect.runPromiseExit(recordDefinitiveSendFailure(
      Effect.fail(new ApiError({ operation: "sendMessage", code: 400, transient: false })),
      reject,
    ))
    expect(rejections).toBe(1)

    await Effect.runPromiseExit(recordDefinitiveSendFailure(
      Effect.fail(new ApiError({ operation: "sendMessage", code: 500, transient: true })),
      reject,
    ))
    expect(rejections).toBe(1)
  })

  test("does not retain an edit slot when a queued edit is interrupted", async () => {
    const attempts = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const client = HttpClient.make((request) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap((count) => count === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst)))
            : Effect.void),
          Effect.as(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
            ok: true,
            result: { message_id: 10, chat: { id: -7 } },
          }), { status: 200 }))),
        ))
      const config = Layer.succeed(AppConfigTag, new AppConfig({
        telegramBotToken: "test-token",
        projectDirectory: "/tmp",
        stateFile: "/tmp/state.json",
        webDatabaseFile: "/tmp/web.sqlite",
        telegramRunTimeout: "10 minutes",
        webPort: 3001,
      }))

      return yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 minute")
        const api = yield* TelegramApi
        const first = yield* Effect.forkChild(api.editMessageText({ chatId: -7, messageId: 10, text: "first" }))
        yield* Deferred.await(firstStarted)
        const canceled = yield* Effect.forkChild(api.editMessageText({ chatId: -7, messageId: 11, text: "canceled" }))
        yield* Effect.yieldNow
        const next = yield* Effect.forkChild(api.editMessageText({ chatId: -7, messageId: 12, text: "next" }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(canceled)
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Effect.yieldNow

        expect(yield* Ref.get(calls)).toBe(1)
        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS - 1)
        expect(yield* Ref.get(calls)).toBe(1)
        yield* TestClock.adjust(1)
        yield* Fiber.join(next)
        return yield* Ref.get(calls)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(attempts).toBe(2)
  })

  test("keeps a recovered 429 penalty for the next edit", async () => {
    const attempts = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const firstAttempt = yield* Deferred.make<void>()
      const client = HttpClient.make((request) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.tap((count) => count === 1 ? Deferred.succeed(firstAttempt, undefined) : Effect.void),
          Effect.map((count) => count === 1
            ? HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
                ok: false,
                error_code: 429,
                description: "Too Many Requests: retry after 1",
                parameters: { retry_after: 1 },
              }), { status: 429 }))
            : HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
                ok: true,
                result: { message_id: 10, chat: { id: 7 } },
              }), { status: 200 }))),
        ))
      const config = Layer.succeed(AppConfigTag, new AppConfig({
        telegramBotToken: "test-token",
        projectDirectory: "/tmp",
        stateFile: "/tmp/state.json",
        webDatabaseFile: "/tmp/web.sqlite",
        telegramRunTimeout: "10 minutes",
        webPort: 3001,
      }))

      return yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 minute")
        const api = yield* TelegramApi
        const first = yield* Effect.forkChild(api.editMessageText({ chatId: 7, messageId: 10, text: "first" }))
        yield* Deferred.await(firstAttempt)
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(first)
        expect(yield* Ref.get(calls)).toBe(2)

        const next = yield* Effect.forkChild(api.editMessageText({ chatId: 7, messageId: 11, text: "next" }))
        yield* TestClock.adjust("1999 millis")
        expect(yield* Ref.get(calls)).toBe(2)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(next)
        return yield* Ref.get(calls)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(attempts).toBe(3)
  })
})
