import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { ApiError, decodeTelegramErrorResponse, decodeTelegramResponse, Live, recordDefinitiveSendFailure, TelegramApi } from "../src/telegram/api.js"
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
})
