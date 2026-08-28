import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { ApiError, decodeTelegramErrorResponse, decodeTelegramResponse, EDIT_MIN_INTERVAL_GROUP_MS, Live, recordDefinitiveSendFailure, TelegramApi } from "../src/telegram/api.js"
import { finalEditDisposition } from "../src/telegram/durable-executor.js"
import { answer, CALLBACK_ACK_TIMEOUT_MS } from "../src/telegram/handlers/shared.js"

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
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const api = yield* TelegramApi
      return yield* api.sendMessage({ chatId: 7, text: "hello" })
    }).pipe(
      Effect.provide(Layer.provide(Live, config)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ))
    expect(attempts).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).not.toContain("test-token")
      expect(rendered).toContain("***")
    }
  })

  test("forwards HTML parse mode for a formatted message", async () => {
    const requestBody = await Effect.runPromise(Ref.make(""))
    const client = HttpClient.make((request) => {
      const body = request.body
      const text = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""
      return Ref.set(requestBody, text).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
          ok: true,
          result: { message_id: 10, chat: { id: 7 } },
        }), { status: 200 }))),
      )
    })
    const config = Layer.succeed(AppConfigTag, new AppConfig({
      telegramBotToken: "test-token",
      projectDirectory: "/tmp",
      stateFile: "/tmp/state.json",
      webDatabaseFile: "/tmp/web.sqlite",
      telegramRunTimeout: "10 minutes",
      webPort: 3001,
    }))

    await Effect.runPromise(Effect.gen(function* () {
      const api = yield* TelegramApi
      yield* api.sendMessage({ chatId: 7, text: "<b>Status</b>", parseMode: "HTML" })
    }).pipe(
      Effect.provide(Layer.provide(Live, config)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ))

    expect(JSON.parse(await Effect.runPromise(Ref.get(requestBody)))).toMatchObject({
      chat_id: 7,
      text: "<b>Status</b>",
      parse_mode: "HTML",
    })
  })

  test("does not retry an expiring callback acknowledgement", async () => {
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts += 1
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
        ok: false,
        error_code: 500,
        description: "temporary failure",
      }), { status: 500 })))
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
      return yield* api.answerCallbackQuery({ queryId: "callback-1", text: "Received." })
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

  test("prioritizes interaction edits over progress waiting for the same chat slot", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const client = HttpClient.make((request) => Ref.updateAndGet(calls, (count) => count + 1).pipe(
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
        yield* api.editMessageText({ chatId: -7, messageId: 10, text: "initial", priority: "final" })
        const progress = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "progress",
          priority: "progress",
        }))
        yield* Effect.yieldNow
        const interaction = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 11,
          text: "interaction",
          priority: "interactive",
        }))
        yield* Effect.yieldNow

        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS - 1)
        expect(yield* Ref.get(calls)).toBe(1)
        yield* TestClock.adjust(1)
        yield* Fiber.join(interaction)
        expect(yield* Ref.get(calls)).toBe(2)
        expect(progress.pollUnsafe()).toBeUndefined()

        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS)
        yield* Fiber.join(progress)
        return yield* Ref.get(calls)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(result).toBe(3)
  })

  test("coalesces queued progress to the newest edit for each message", async () => {
    const bodies = await Effect.runPromise(Effect.gen(function* () {
      const requestBodies = yield* Ref.make<readonly string[]>([])
      const client = HttpClient.make((request) => {
        const body = request.body
        const encoded = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""
        return Ref.update(requestBodies, (values) => [...values, encoded]).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
            ok: true,
            result: { message_id: 10, chat: { id: -7 } },
          }), { status: 200 }))),
        )
      })
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
        yield* api.editMessageText({ chatId: -7, messageId: 10, text: "initial", priority: "final" })
        const stale = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "stale progress",
          priority: "progress",
        }))
        yield* Effect.yieldNow
        const latest = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "latest progress",
          priority: "progress",
        }))
        yield* Effect.yieldNow

        expect(yield* Fiber.join(stale)).toBeUndefined()
        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS)
        yield* Fiber.join(latest)
        return yield* Ref.get(requestBodies)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('"text":"initial"')
    expect(bodies[1]).toContain('"text":"latest progress"')
    expect(bodies.join("\n")).not.toContain("stale progress")
  })

  test("drops queued background progress when a final edit arrives", async () => {
    const bodies = await Effect.runPromise(Effect.gen(function* () {
      const requestBodies = yield* Ref.make<readonly string[]>([])
      const client = HttpClient.make((request) => {
        const body = request.body
        const encoded = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""
        return Ref.update(requestBodies, (values) => [...values, encoded]).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
            ok: true,
            result: { message_id: 10, chat: { id: -7 } },
          }), { status: 200 }))),
        )
      })
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
        yield* api.editMessageText({ chatId: -7, messageId: 10, text: "initial", priority: "final" })
        yield* api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "stale background progress",
          priority: "progress",
          delivery: "background",
        })
        const final = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "final result",
          priority: "final",
        }))
        yield* Effect.yieldNow

        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS)
        yield* Fiber.join(final)
        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS)
        return yield* Ref.get(requestBodies)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('"text":"initial"')
    expect(bodies[1]).toContain('"text":"final result"')
    expect(bodies.join("\n")).not.toContain("stale background progress")
  })

  test("preempts selected background progress when an urgent edit arrives", async () => {
    const attempts = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const progressStarted = yield* Deferred.make<void>()
      const finalStarted = yield* Deferred.make<void>()
      const client = HttpClient.make((request) => Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) => count === 1
          ? Deferred.succeed(progressStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(finalStarted, undefined)),
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
        yield* api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "selected progress",
          priority: "progress",
          delivery: "background",
        })
        yield* Deferred.await(progressStarted)

        const final = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "final result",
          priority: "final",
        }))
        yield* Effect.yieldNow
        expect(yield* Ref.get(calls)).toBe(1)

        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS - 1)
        expect(yield* Ref.get(calls)).toBe(1)
        yield* TestClock.adjust(1)
        yield* Deferred.await(finalStarted)
        yield* Fiber.join(final)
        return yield* Ref.get(calls)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(attempts).toBe(2)
  })

  test("rechecks chat priority after global edit capacity becomes available", async () => {
    const interactionWon = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const allBlockersStarted = yield* Deferred.make<void>()
      const releaseBlockers = yield* Deferred.make<void>()
      const client = HttpClient.make((request) => Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) => count <= 16
          ? (count === 16 ? Deferred.succeed(allBlockersStarted, undefined) : Effect.void).pipe(
              Effect.andThen(Deferred.await(releaseBlockers)),
            )
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
        const api = yield* TelegramApi
        const blockers = yield* Effect.forEach(Array.from({ length: 16 }), (_, index) =>
          Effect.forkChild(api.editMessageText({
            chatId: index + 1,
            messageId: 10,
            text: "blocker",
            priority: "final",
          })))
        yield* Deferred.await(allBlockersStarted)

        const progress = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "progress",
          priority: "progress",
        }))
        yield* Effect.yieldNow
        const interaction = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 11,
          text: "interaction",
          priority: "interactive",
        }))
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseBlockers, undefined)

        const winner = yield* Effect.raceFirst(
          Fiber.join(interaction).pipe(Effect.as(true)),
          Fiber.join(progress).pipe(Effect.as(false)),
        )
        yield* Fiber.joinAll(blockers)
        return winner
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
      )
    }))

    expect(interactionWon).toBe(true)
  })

  test("interrupts selected progress when its waiting caller is cancelled", async () => {
    const attempts = await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const progressStarted = yield* Deferred.make<void>()
      const finalStarted = yield* Deferred.make<void>()
      const client = HttpClient.make((request) => Ref.updateAndGet(calls, (count) => count + 1).pipe(
        Effect.flatMap((count) => count === 1
          ? Deferred.succeed(progressStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Deferred.succeed(finalStarted, undefined)),
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
        const progress = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "progress",
          priority: "progress",
        }))
        yield* Deferred.await(progressStarted)
        yield* Fiber.interrupt(progress)

        const final = yield* Effect.forkChild(api.editMessageText({
          chatId: -7,
          messageId: 11,
          text: "final",
          priority: "final",
        }))
        yield* TestClock.adjust(EDIT_MIN_INTERVAL_GROUP_MS)
        yield* Deferred.await(finalStarted)
        yield* Fiber.join(final)
        return yield* Ref.get(calls)
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
      )
    }))

    expect(attempts).toBe(2)
  })

  test("does not retry progress edits", async () => {
    let attempts = 0
    const client = HttpClient.make((request) => {
      attempts += 1
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify({
        ok: false,
        error_code: 500,
        description: "temporary failure",
      }), { status: 500 })))
    })
    const config = Layer.succeed(AppConfigTag, new AppConfig({
      telegramBotToken: "test-token",
      projectDirectory: "/tmp",
      stateFile: "/tmp/state.json",
      webDatabaseFile: "/tmp/web.sqlite",
      telegramRunTimeout: "10 minutes",
      webPort: 3001,
    }))
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const api = yield* TelegramApi
      return yield* api.editMessageText({
        chatId: -7,
        messageId: 10,
        text: "progress",
        priority: "progress",
      })
    }).pipe(
      Effect.provide(Layer.provide(Live, config)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
    ))

    expect(attempts).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("returns after a background edit is safely queued", async () => {
    const completed = await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const client = HttpClient.make((request) => Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Deferred.succeed(finished, undefined)),
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
        const api = yield* TelegramApi
        const result = yield* api.editMessageText({
          chatId: -7,
          messageId: 10,
          text: "queued",
          priority: "interactive",
          delivery: "background",
        })
        expect(result).toBeUndefined()
        yield* Deferred.await(started)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(finished)
        return true
      }).pipe(
        Effect.provide(Layer.provide(Live, config)),
        Effect.provideService(HttpClient.HttpClient, client),
      )
    }))

    expect(completed).toBe(true)
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

  test("bounds callback acknowledgement before continuing", async () => {
    const completed = await Effect.runPromise(Effect.gen(function* () {
      const done = yield* Ref.make(false)
      const api = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: () => Effect.never,
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const fiber = yield* answer("callback-2", "Received.").pipe(
        Effect.andThen(Ref.set(done, true)),
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.never)),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(CALLBACK_ACK_TIMEOUT_MS - 1)
      expect(yield* Ref.get(done)).toBe(false)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      return yield* Ref.get(done)
    }).pipe(Effect.provide(TestClock.layer())))

    expect(completed).toBe(true)
  })
})
