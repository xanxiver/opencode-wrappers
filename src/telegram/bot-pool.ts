import { Clock, Context, Data, Effect, Layer, Option, Ref, Schedule, Semaphore } from "effect"
import { HttpClient } from "effect/unstable/http"
import {
  AppConfigTag,
  ConfigError,
  TELEGRAM_CONTROLLER_BOT_KEY,
  type AppConfig,
} from "../config.js"
import { logBoundary, logDebugEvent, type LogAnnotations } from "../core/logging.js"
import {
  ApiError,
  makeTelegramApiClient,
  TelegramApi,
  type BotUser,
  type TelegramDeliveryClient,
  type TelegramApiPoolClient,
} from "./api.js"

export type DeliveryMemberHealth = "starting" | "healthy" | "degraded" | "unauthorized"

export interface TelegramDeliveryMember {
  readonly botKey: string
  readonly username?: string
  readonly controller: boolean
}

export interface TelegramDeliveryMemberStatus extends TelegramDeliveryMember {
  readonly health: DeliveryMemberHealth
  readonly groupEligible?: boolean
}

export class DeliveryBotUnavailable extends Data.TaggedError("DeliveryBotUnavailable")<{
  readonly botKey: string
  readonly message: string
}> {}

export interface TelegramBotPoolService {
  readonly controllerBotKey: string
  readonly controller: TelegramApiPoolClient
  readonly getClient: (botKey: string) => Effect.Effect<TelegramDeliveryClient, DeliveryBotUnavailable>
  readonly eligibleMembers: (chatId: number) => Effect.Effect<readonly TelegramDeliveryMember[]>
  readonly status: (chatId?: number) => Effect.Effect<readonly TelegramDeliveryMemberStatus[]>
}

export class TelegramBotPool extends Context.Service<TelegramBotPool, TelegramBotPoolService>()(
  "opencode2-uis/TelegramBotPool",
) {}

interface PoolMember {
  readonly botKey: string
  readonly controller: boolean
  readonly client: TelegramApiPoolClient
}

interface MemberRuntime {
  readonly health: DeliveryMemberHealth
  readonly user?: BotUser
  readonly pollingConflict: boolean
}

interface HealthTransition {
  readonly changed: boolean
  readonly previousHealth: DeliveryMemberHealth | undefined
  readonly health: DeliveryMemberHealth | undefined
  readonly pollingConflict: boolean
}

interface EligibilityCacheEntry {
  readonly eligible: boolean
  readonly expiresAt: number
}

const ELIGIBILITY_SUCCESS_TTL_MS = 5 * 60 * 1000
const ELIGIBILITY_FAILURE_TTL_MS = 30 * 1000

const canSendToGroup = (status: string, canSendMessages: boolean | undefined): boolean =>
  status !== "left" && status !== "kicked" && canSendMessages !== false

const rawPoolLayer: Layer.Layer<
  TelegramBotPool,
  ConfigError,
  AppConfig | HttpClient.HttpClient
> = Layer.effect(
  TelegramBotPool,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const debugEnabled = config.telegramStreamDebug === true
    const debug = (message: string, annotations: LogAnnotations = {}) => logDebugEvent(
      debugEnabled,
      "telegram/bot-pool",
      "delivery-bot-health",
      message,
      annotations,
    )
    const httpClient = yield* HttpClient.HttpClient
    const controllerToken = config.telegramBotToken
    if (controllerToken === undefined) {
      return yield* new ConfigError({ message: "TELEGRAM_BOT_TOKEN is required by the Telegram bot pool" })
    }
    const editRequestPermits = yield* Semaphore.make(16)
    const configured = [
      { botKey: TELEGRAM_CONTROLLER_BOT_KEY, token: controllerToken, controller: true },
      ...(config.telegramBotPool ?? []).map((member) => ({
        botKey: member.id,
        token: member.token,
        controller: false,
      })),
    ]
    const runtimes = yield* Ref.make<ReadonlyMap<string, MemberRuntime>>(
      new Map(configured.map((member) => [member.botKey, {
        health: "starting" as const,
        pollingConflict: false,
      }])),
    )
    const eligibility = yield* Ref.make<ReadonlyMap<string, EligibilityCacheEntry>>(new Map())
    const markHealthy = (
      botKey: string,
      operation: string,
      polling = false,
      runID?: string,
    ): Effect.Effect<void> => Ref.modify(runtimes, (current) => {
      const runtime = current.get(botKey)
      if (runtime === undefined) {
        const transition: HealthTransition = {
          changed: false,
          previousHealth: undefined,
          health: undefined,
          pollingConflict: false,
        }
        return [transition, current]
      }
      const pollingConflict = polling ? false : runtime.pollingConflict
      const health: DeliveryMemberHealth = pollingConflict ? "degraded" : "healthy"
      const changed = runtime.health !== health || runtime.pollingConflict !== pollingConflict
      const transition: HealthTransition = {
        changed,
        previousHealth: runtime.health,
        health,
        pollingConflict,
      }
      return [transition, changed ? new Map(current).set(botKey, { ...runtime, health, pollingConflict }) : current]
    }).pipe(
      Effect.flatMap((transition) => transition.changed
        ? debug("Telegram delivery bot became healthy", {
            deliveryBotKey: botKey,
            runID,
            operation,
            previousHealth: transition.previousHealth,
            health: transition.health,
            pollingConflict: transition.pollingConflict,
          })
        : Effect.void),
    )
    const markFailure = (
      botKey: string,
      error: ApiError,
      polling: boolean,
      runID?: string,
    ): Effect.Effect<void> =>
      Ref.modify(runtimes, (current) => {
        const runtime = current.get(botKey)
        if (runtime === undefined) {
          const transition: HealthTransition = {
            changed: false,
            previousHealth: undefined,
            health: undefined,
            pollingConflict: false,
          }
          return [transition, current]
        }
        const pollingConflict = runtime.pollingConflict || (polling && error.code === 409)
        let health: DeliveryMemberHealth = runtime.health
        if (error.code === 401) health = "unauthorized"
        else if (error.transient || pollingConflict) health = "degraded"
        const changed = health !== runtime.health || pollingConflict !== runtime.pollingConflict
        const transition: HealthTransition = {
          changed,
          previousHealth: runtime.health,
          health,
          pollingConflict,
        }
        return [transition, changed ? new Map(current).set(botKey, { ...runtime, health, pollingConflict }) : current]
      }).pipe(
        Effect.flatMap((transition) => debug("Telegram delivery bot request failed", {
          deliveryBotKey: botKey,
          runID,
          operation: error.operation,
          code: error.code,
          transient: error.transient,
          polling,
          healthChanged: transition.changed,
          previousHealth: transition.previousHealth,
          health: transition.health,
          pollingConflict: transition.pollingConflict,
        })),
      )
    const track = <A>(
      botKey: string,
      operation: string,
      effect: Effect.Effect<A, ApiError, HttpClient.HttpClient>,
      chatId?: number,
      polling = false,
      runID?: string,
    ): Effect.Effect<A, ApiError> => effect.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.tap(() => markHealthy(botKey, operation, polling, runID)),
      Effect.catchTag("ApiError", (error) => Effect.gen(function* () {
        yield* markFailure(botKey, error, polling, runID)
        if (error.code === 403 && chatId !== undefined && chatId < 0) {
          const now = yield* Clock.currentTimeMillis
          yield* Ref.update(eligibility, (current) => new Map(current).set(`${botKey}:${chatId}`, {
            eligible: false,
            expiresAt: now + ELIGIBILITY_FAILURE_TTL_MS,
          }))
        }
        return yield* Effect.fail(error)
      })),
    )
    const observe = (botKey: string, client: TelegramApiPoolClient): TelegramApiPoolClient => ({
      getUpdates: (offset, timeoutSeconds) => track(botKey, "getUpdates", client.getUpdates(offset, timeoutSeconds), undefined, true),
      sendMessage: (input) => track(botKey, "sendMessage", client.sendMessage(input), input.chatId, false, input.runID),
      sendPhoto: (input) => track(botKey, "sendPhoto", client.sendPhoto(input), input.chatId),
      sendVideo: (input) => track(botKey, "sendVideo", client.sendVideo(input), input.chatId),
      sendDocument: (input) => track(botKey, "sendDocument", client.sendDocument(input), input.chatId),
      editMessageText: (input) => track(botKey, "editMessageText", client.editMessageText(input), input.chatId, false, input.runID),
      answerCallbackQuery: (input) => track(botKey, "answerCallbackQuery", client.answerCallbackQuery(input)),
      getFile: (fileId) => track(botKey, "getFile", client.getFile(fileId)),
      downloadFile: (filePath) => track(botKey, "downloadFile", client.downloadFile(filePath)),
      getMe: () => track(botKey, "getMe", client.getMe()),
      getChatMember: (chatId, userId) => track(botKey, "getChatMember", client.getChatMember(chatId, userId), chatId),
    })
    const members = yield* Effect.forEach(configured, (member) =>
      makeTelegramApiClient(member.token, {
        botKey: member.botKey,
        editRequestPermits,
        debug: debugEnabled,
      }).pipe(
        Effect.map((client): PoolMember => ({
          botKey: member.botKey,
          controller: member.controller,
          client: observe(member.botKey, client),
        })),
      ))
    const memberByKey = new Map(members.map((member) => [member.botKey, member]))
    const probe = (member: PoolMember): Effect.Effect<void> => Effect.gen(function* () {
      const runtime = (yield* Ref.get(runtimes)).get(member.botKey)
      if (runtime?.health === "unauthorized") return
      yield* debug("Telegram delivery bot health probe started", {
        deliveryBotKey: member.botKey,
        health: runtime?.health,
      })
      const user = yield* member.client.getMe().pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      )
      yield* Ref.update(runtimes, (current) => new Map(current).set(member.botKey, {
        health: current.get(member.botKey)?.pollingConflict === true ? "degraded" : "healthy",
        user,
        pollingConflict: current.get(member.botKey)?.pollingConflict ?? false,
      }))
      yield* debug("Telegram delivery bot health probe finished", {
        deliveryBotKey: member.botKey,
        health: (yield* Ref.get(runtimes)).get(member.botKey)?.health,
      })
    }).pipe(
      Effect.catchCause((cause) => Ref.get(runtimes).pipe(
        Effect.flatMap((current) => Effect.annotateLogs({
          controllerBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
          deliveryBotKey: member.botKey,
          deliveryBotUsername: current.get(member.botKey)?.user?.username,
          deliveryBotHealth: current.get(member.botKey)?.health,
        })(logBoundary(
          "telegram/bot-pool",
          "telegram-bot-api",
          "Telegram delivery member health probe failed",
        )(cause))),
      )),
    )
    yield* Effect.forEach(members, probe, { concurrency: "unbounded", discard: true })
    yield* Effect.forkScoped(
      Effect.forEach(members, probe, { concurrency: "unbounded", discard: true }).pipe(
        Effect.repeat(Schedule.spaced("30 seconds")),
      ),
    )

    const eligibilityKey = (botKey: string, chatId: number): string => `${botKey}:${chatId}`
    const checkGroupEligibility = (member: PoolMember, chatId: number): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const key = eligibilityKey(member.botKey, chatId)
        const cached = (yield* Ref.get(eligibility)).get(key)
        if (cached !== undefined && cached.expiresAt > now) return cached.eligible
        const runtime = (yield* Ref.get(runtimes)).get(member.botKey)
        if (runtime?.health !== "healthy" || runtime.user === undefined) return false
        const chatMember = yield* member.client.getChatMember(chatId, runtime.user.id).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        )
        const eligible = canSendToGroup(chatMember.status, chatMember.can_send_messages)
        yield* Ref.update(eligibility, (current) => new Map(current).set(key, {
          eligible,
          expiresAt: now + (eligible ? ELIGIBILITY_SUCCESS_TTL_MS : ELIGIBILITY_FAILURE_TTL_MS),
        }))
        return eligible
      }).pipe(
        Effect.catchCause((cause) => Effect.annotateLogs({
          controllerBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
          deliveryBotKey: member.botKey,
          chatId,
        })(logBoundary(
          "telegram/bot-pool",
          "telegram-bot-api",
          "Telegram delivery member group eligibility probe failed",
        )(cause)).pipe(Effect.as(false))),
      )

    const eligibleMembers = (chatId: number): Effect.Effect<readonly TelegramDeliveryMember[]> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(runtimes)
        if (chatId >= 0) {
          const controller = memberByKey.get(TELEGRAM_CONTROLLER_BOT_KEY)
          const runtime = current.get(TELEGRAM_CONTROLLER_BOT_KEY)
          return controller !== undefined && runtime?.health === "healthy"
            ? [{
                botKey: controller.botKey,
                username: runtime.user?.username,
                controller: true,
              }]
            : []
        }
        const candidates = yield* Effect.forEach(members, (member) => {
          const runtime = current.get(member.botKey)
          if (runtime?.health !== "healthy") return Effect.succeed(Option.none<TelegramDeliveryMember>())
          return checkGroupEligibility(member, chatId).pipe(
            Effect.map((eligible) => eligible
              ? Option.some({
                  botKey: member.botKey,
                  username: runtime.user?.username,
                  controller: member.controller,
                })
              : Option.none<TelegramDeliveryMember>()),
          )
        }, { concurrency: "unbounded" })
        return candidates.flatMap((candidate) => Option.isSome(candidate) ? [candidate.value] : [])
      })

    const controller = memberByKey.get(TELEGRAM_CONTROLLER_BOT_KEY)
    if (controller === undefined) {
      return yield* new ConfigError({ message: "Telegram controller client is missing" })
    }
    return TelegramBotPool.of({
      controllerBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
      controller: controller.client,
      getClient: (botKey) => Effect.gen(function* () {
        const member = memberByKey.get(botKey)
        const runtime = (yield* Ref.get(runtimes)).get(botKey)
        yield* debug("Telegram delivery client lookup started", {
          deliveryBotKey: botKey,
          configured: member !== undefined,
          health: runtime?.health,
          pollingConflict: runtime?.pollingConflict,
        })
        if (member === undefined || runtime?.health !== "healthy") {
          yield* debug("Telegram delivery client lookup rejected", {
            deliveryBotKey: botKey,
            configured: member !== undefined,
            health: runtime?.health,
            pollingConflict: runtime?.pollingConflict,
          })
          return yield* new DeliveryBotUnavailable({
            botKey,
            message: member === undefined
              ? `Telegram delivery bot ${botKey} is not configured`
              : `Telegram delivery bot ${botKey} is unavailable`,
          })
        }
        yield* debug("Telegram delivery client lookup finished", {
          deliveryBotKey: botKey,
          health: runtime.health,
        })
        return member.client
      }),
      eligibleMembers,
      status: (chatId) => Effect.gen(function* () {
        const eligible = chatId === undefined
          ? []
          : yield* eligibleMembers(chatId)
        const eligibleKeys = new Set(eligible.map((member) => member.botKey))
        const current = yield* Ref.get(runtimes)
        return members.map((member): TelegramDeliveryMemberStatus => {
          const runtime = current.get(member.botKey)
          const base = {
            botKey: member.botKey,
            username: runtime?.user?.username,
            controller: member.controller,
            health: runtime?.health ?? "starting",
          }
          return chatId === undefined ? base : { ...base, groupEligible: eligibleKeys.has(member.botKey) }
        })
      }),
    })
  }),
)

const controllerApiLayer: Layer.Layer<TelegramApi, never, TelegramBotPool> = Layer.effect(
  TelegramApi,
  Effect.gen(function* () {
    const pool = yield* TelegramBotPool
    return pool.controller
  }),
)

/** One shared pool allocation supplies both explicit delivery routing and the controller API service. */
export const TelegramBotPoolLive: Layer.Layer<
  TelegramBotPool | TelegramApi,
  ConfigError,
  AppConfig | HttpClient.HttpClient
> = Layer.merge(
  rawPoolLayer,
  controllerApiLayer.pipe(Layer.provide(rawPoolLayer)),
)
