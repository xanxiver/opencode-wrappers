import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Ref, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  AppConfig,
  AppConfigTag,
  TelegramBotMemberConfig,
} from "../src/config.js"
import {
  makeTelegramApiClient,
  TelegramApi,
} from "../src/telegram/api.js"
import {
  TelegramBotPool,
  TelegramBotPoolLive,
} from "../src/telegram/bot-pool.js"

interface TelegramRequestIdentity {
  readonly token: string
  readonly operation: string
  readonly chatId?: number
}

interface FakeTelegramResponse {
  readonly status?: number
  readonly body: unknown
}

const requestIdentity = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): TelegramRequestIdentity => {
  const match = /\/bot([^/]+)\/([^/?]+)/.exec(request.url)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { token: "unknown", operation: "unknown" }
  }
  const params = new Map(request.urlParams.params)
  const chat = params.get("chat_id")
  return {
    token: match[1],
    operation: match[2],
    chatId: chat === undefined ? undefined : Number(chat),
  }
}

const responseFor = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  response: FakeTelegramResponse,
) => HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response.body), {
  status: response.status ?? 200,
}))

const success = <A>(result: A): FakeTelegramResponse => ({ body: { ok: true, result } })

const botUser = (id: number, username: string) => ({
  id,
  is_bot: true,
  first_name: username,
  username,
})

const config = (workers: readonly TelegramBotMemberConfig[] = []) => new AppConfig({
  telegramBotToken: "controller-token",
  telegramBotPool: workers,
  projectDirectory: "/tmp",
  stateFile: "/tmp/state.json",
  webDatabaseFile: "/tmp/web.sqlite",
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
})

const runPool = <A, E>(
  client: HttpClient.HttpClient,
  appConfig: AppConfig,
  effect: Effect.Effect<A, E, TelegramBotPool | TelegramApi | HttpClient.HttpClient>,
) => Effect.runPromise(Effect.scoped(effect.pipe(
  Effect.provide(TelegramBotPoolLive),
  Effect.provideService(AppConfigTag, appConfig),
  Effect.provideService(HttpClient.HttpClient, client),
)))

describe("Telegram bot pool", () => {
  test("creates a healthy one-member controller pool when no workers are configured", async () => {
    const calls = await Effect.runPromise(Ref.make<readonly TelegramRequestIdentity[]>([]))
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      let response = success<readonly never[]>([])
      if (identity.operation === "getMe") response = success(botUser(1, "controller_bot"))
      else if (identity.operation === "getChatMember") {
        response = success({ status: "member", user: botUser(1, "controller_bot"), can_send_messages: true })
      }
      return Ref.update(calls, (current) => [...current, identity]).pipe(
        Effect.as(responseFor(request, response)),
      )
    })

    const result = await runPool(client, config(), Effect.gen(function* () {
      const pool = yield* TelegramBotPool
      const controller = yield* TelegramApi
      yield* controller.getUpdates(0, 1)
      return {
        status: yield* pool.status(-100),
        eligible: yield* pool.eligibleMembers(-100),
      }
    }))

    expect(result.status).toEqual([{
      botKey: "controller",
      username: "controller_bot",
      controller: true,
      health: "healthy",
      groupEligible: true,
    }])
    expect(result.eligible.map((entry) => entry.botKey)).toEqual(["controller"])
    expect((await Effect.runPromise(Ref.get(calls))).filter(({ operation }) => operation === "getUpdates"))
      .toEqual([{ token: "controller-token", operation: "getUpdates", chatId: undefined }])
  })

  test("probes workers but only the controller poller calls getUpdates", async () => {
    const calls = await Effect.runPromise(Ref.make<readonly TelegramRequestIdentity[]>([]))
    const users = new Map([
      ["controller-token", botUser(1, "controller_bot")],
      ["worker-token-1", botUser(2, "worker_1_bot")],
      ["worker-token-2", botUser(3, "worker_2_bot")],
    ])
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      const user = users.get(identity.token) ?? botUser(99, "unknown_bot")
      let response = success<readonly never[]>([])
      if (identity.operation === "getMe") response = success(user)
      else if (identity.operation === "getChatMember") {
        response = success({ status: "member", user, can_send_messages: true })
      }
      return Ref.update(calls, (current) => [...current, identity]).pipe(
        Effect.as(responseFor(request, response)),
      )
    })
    const workers = [
      new TelegramBotMemberConfig({ id: "delivery-1", token: "worker-token-1" }),
      new TelegramBotMemberConfig({ id: "delivery-2", token: "worker-token-2" }),
    ]

    const status = await runPool(client, config(workers), Effect.gen(function* () {
      const api = yield* TelegramApi
      const pool = yield* TelegramBotPool
      yield* api.getUpdates(0, 1)
      return yield* pool.status(-100)
    }))

    expect(status.map(({ botKey }) => botKey)).toEqual(["controller", "delivery-1", "delivery-2"])
    const observed = await Effect.runPromise(Ref.get(calls))
    expect(observed.filter(({ operation }) => operation === "getMe").map(({ token }) => token).sort()).toEqual([
      "controller-token",
      "worker-token-1",
      "worker-token-2",
    ])
    expect(observed.filter(({ operation }) => operation === "getUpdates").map(({ token }) => token)).toEqual([
      "controller-token",
    ])
  })

  test("keeps healthy members available when one worker token is unauthorized", async () => {
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      if (identity.operation === "getMe" && identity.token === "bad-worker-token") {
        return Effect.succeed(responseFor(request, {
          status: 401,
          body: { ok: false, error_code: 401, description: "Unauthorized" },
        }))
      }
      const user = identity.token === "controller-token"
        ? botUser(1, "controller_bot")
        : botUser(2, "worker_1_bot")
      return Effect.succeed(responseFor(request, identity.operation === "getMe"
        ? success(user)
        : success({ status: "member", user, can_send_messages: true })))
    })
    const workers = [
      new TelegramBotMemberConfig({ id: "delivery-1", token: "worker-token-1" }),
      new TelegramBotMemberConfig({ id: "delivery-bad", token: "bad-worker-token" }),
    ]

    const result = await runPool(client, config(workers), Effect.gen(function* () {
      const pool = yield* TelegramBotPool
      return {
        status: yield* pool.status(-100),
        eligible: yield* pool.eligibleMembers(-100),
      }
    }))

    expect(result.status.find(({ botKey }) => botKey === "delivery-bad")?.health).toBe("unauthorized")
    expect(result.eligible.map(({ botKey }) => botKey).sort()).toEqual(["controller", "delivery-1"])
  })

  test("excludes a worker only from groups where it cannot send", async () => {
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      const worker = identity.token === "worker-token-1"
      const user = worker ? botUser(2, "worker_1_bot") : botUser(1, "controller_bot")
      const memberStatus = worker && identity.chatId === -100 ? "left" : "member"
      return Effect.succeed(responseFor(request, identity.operation === "getMe"
        ? success(user)
        : success({ status: memberStatus, user, can_send_messages: memberStatus === "member" })))
    })
    const workers = [new TelegramBotMemberConfig({ id: "delivery-1", token: "worker-token-1" })]

    const result = await runPool(client, config(workers), Effect.gen(function* () {
      const pool = yield* TelegramBotPool
      return {
        first: yield* pool.eligibleMembers(-100),
        second: yield* pool.eligibleMembers(-200),
      }
    }))

    expect(result.first.map(({ botKey }) => botKey)).toEqual(["controller"])
    expect(result.second.map(({ botKey }) => botKey).sort()).toEqual(["controller", "delivery-1"])
  })

  test("returns a worker to eligibility after a cached group failure expires", async () => {
    const allowed = await Effect.runPromise(Ref.make(false))
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      const worker = identity.token === "worker-token-1"
      const user = worker ? botUser(2, "worker_1_bot") : botUser(1, "controller_bot")
      if (identity.operation === "getMe") return Effect.succeed(responseFor(request, success(user)))
      return Ref.get(allowed).pipe(
        Effect.map((workerAllowed) => {
          const canSend = !worker || workerAllowed
          return responseFor(request, success({
            status: canSend ? "member" : "left",
            user,
            can_send_messages: canSend,
          }))
        }),
      )
    })
    const workers = [new TelegramBotMemberConfig({ id: "delivery-1", token: "worker-token-1" })]

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pool = yield* TelegramBotPool
      const before = yield* pool.eligibleMembers(-100)
      yield* Ref.set(allowed, true)
      const cached = yield* pool.eligibleMembers(-100)
      yield* TestClock.adjust("30 seconds")
      const recovered = yield* pool.eligibleMembers(-100)
      return { before, cached, recovered }
    }).pipe(
      Effect.provide(TelegramBotPoolLive),
      Effect.provideService(AppConfigTag, config(workers)),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(TestClock.layer()),
    )))

    expect(result.before.map(({ botKey }) => botKey)).toEqual(["controller"])
    expect(result.cached.map(({ botKey }) => botKey)).toEqual(["controller"])
    expect(result.recovered.map(({ botKey }) => botKey).sort()).toEqual(["controller", "delivery-1"])
  })

  test("keeps a polling-conflicted controller degraded until getUpdates succeeds", async () => {
    let pollAttempts = 0
    const client = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      if (identity.operation === "getUpdates") {
        pollAttempts += 1
        return Effect.succeed(responseFor(request, pollAttempts === 1
          ? { status: 409, body: { ok: false, error_code: 409, description: "Conflict" } }
          : success([])))
      }
      return Effect.succeed(responseFor(request, success(botUser(1, "controller_bot"))))
    })

    const result = await runPool(client, config(), Effect.gen(function* () {
      const api = yield* TelegramApi
      const pool = yield* TelegramBotPool
      yield* Effect.exit(api.getUpdates(0, 1))
      yield* pool.controller.getMe()
      const conflicted = yield* pool.status()
      yield* api.getUpdates(0, 1)
      const recovered = yield* pool.status()
      return { conflicted, recovered }
    }))

    expect(result.conflicted[0]?.health).toBe("degraded")
    expect(result.recovered[0]?.health).toBe("healthy")
  })
})

describe("Telegram pooled edit scheduling", () => {
  test("uses independent group throttle state for different delivery clients", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const http = HttpClient.make((request) => Ref.update(calls, (count) => count + 1).pipe(
      Effect.as(responseFor(request, success({ message_id: 10, chat: { id: -100 } }))),
    ))

    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const permits = yield* Semaphore.make(16)
      const first = yield* makeTelegramApiClient("token-a", { botKey: "delivery-a", editRequestPermits: permits })
      const second = yield* makeTelegramApiClient("token-b", { botKey: "delivery-b", editRequestPermits: permits })
      yield* first.editMessageText({ chatId: -100, messageId: 1, text: "first", priority: "final" })
      const secondEdit = yield* Effect.forkChild(second.editMessageText({
        chatId: -100,
        messageId: 2,
        text: "second",
        priority: "final",
      }))
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })
      const count = yield* Ref.get(calls)
      yield* Fiber.interrupt(secondEdit)
      return count
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(TestClock.layer()),
    )))

    expect(observed).toBe(2)
  })

  test("does not apply one delivery client's 429 delay to another client", async () => {
    const calls = await Effect.runPromise(Ref.make<readonly TelegramRequestIdentity[]>([]))
    const http = HttpClient.make((request) => {
      const identity = requestIdentity(request)
      return Ref.update(calls, (current) => [...current, identity]).pipe(
        Effect.as(responseFor(request, identity.token === "token-a"
          ? {
              status: 429,
              body: { ok: false, error_code: 429, description: "retry", parameters: { retry_after: 30 } },
            }
          : success({ message_id: 2, chat: { id: -100 } }))),
      )
    })

    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const permits = yield* Semaphore.make(16)
      const first = yield* makeTelegramApiClient("token-a", { botKey: "delivery-a", editRequestPermits: permits })
      const second = yield* makeTelegramApiClient("token-b", { botKey: "delivery-b", editRequestPermits: permits })
      const flooded = yield* Effect.exit(first.editMessageText({
        chatId: -100,
        messageId: 1,
        text: "first",
        priority: "progress",
      }))
      const delivered = yield* second.editMessageText({
        chatId: -100,
        messageId: 2,
        text: "second",
        priority: "progress",
      })
      return { flooded, delivered }
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(TestClock.layer()),
    )))

    expect(Exit.isFailure(result.flooded)).toBe(true)
    expect(result.delivered?.message_id).toBe(2)
    expect((await Effect.runPromise(Ref.get(calls))).map(({ token }) => token)).toEqual(["token-a", "token-b"])
  })

  test("shares one sixteen-request edit limit across delivery clients", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const active = yield* Ref.make(0)
      const peak = yield* Ref.make(0)
      const calls = yield* Ref.make(0)
      const sixteenStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const http = HttpClient.make((request) => Effect.gen(function* () {
        const current = yield* Ref.updateAndGet(active, (count) => count + 1)
        yield* Ref.update(peak, (maximum) => Math.max(maximum, current))
        const count = yield* Ref.updateAndGet(calls, (value) => value + 1)
        if (count === 16) yield* Deferred.succeed(sixteenStarted, undefined)
        yield* Deferred.await(release)
        return responseFor(request, success({ message_id: 10, chat: { id: 1 } }))
      }).pipe(Effect.ensuring(Ref.update(active, (count) => count - 1))))
      const permits = yield* Semaphore.make(16)
      const first = yield* makeTelegramApiClient("token-a", { botKey: "delivery-a", editRequestPermits: permits }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      )
      const second = yield* makeTelegramApiClient("token-b", { botKey: "delivery-b", editRequestPermits: permits }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      )
      const fibers = yield* Effect.forEach(Array.from({ length: 17 }), (_, index) => {
        const api = index % 2 === 0 ? first : second
        return Effect.forkChild(api.editMessageText({
          chatId: index + 1,
          messageId: index + 1,
          text: `edit ${index + 1}`,
          priority: "final",
        }).pipe(Effect.provideService(HttpClient.HttpClient, http)))
      })
      yield* Deferred.await(sixteenStarted)
      yield* Effect.yieldNow
      const beforeRelease = yield* Ref.get(calls)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.joinAll(fibers)
      return { beforeRelease, peak: yield* Ref.get(peak), total: yield* Ref.get(calls) }
    })))

    expect(result.beforeRelease).toBe(16)
    expect(result.peak).toBe(16)
    expect(result.total).toBe(17)
  })
})
