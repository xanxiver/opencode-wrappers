import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { HttpClient } from "effect/unstable/http"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import {
  TelegramApi,
  type TelegramApiClient,
  type TelegramDeliveryClient,
} from "../src/telegram/api.js"
import {
  InteractionStore,
  type InteractionStateStore,
  type JsonValue,
} from "../src/telegram/interaction-store.js"
import { Live as PermissionRegistryLive, PermissionRegistry } from "../src/telegram/permissions.js"
import { Live as QuestionRegistryLive, QuestionRegistry } from "../src/telegram/questions.js"
import { runPrompt } from "../src/telegram/run.js"
import { Live as SessionSelectionLive } from "../src/telegram/session-selection.js"

const openCode: OpenCodeService = {
  createSession: () => Effect.never,
  getSession: () => Effect.never,
  prompt: () => Effect.never,
  listPending: () => Effect.succeed([]),
  cancelPending: () => Effect.void,
  interrupt: () => Effect.void,
  wait: () => Effect.void,
  activeSessions: () => Effect.succeed([]),
  compact: () => Effect.void,
  revert: () => Effect.void,
  listSessions: () => Effect.succeed({ data: [], cursor: {} }),
  listMessages: () => Effect.succeed({ data: [], cursor: {} }),
  listProjects: () => Effect.succeed([]),
  listProjectDirectories: () => Effect.succeed([]),
  listPendingPermissions: () => Effect.succeed([]),
  listPendingQuestions: () => Effect.succeed([]),
  replyPermission: () => Effect.void,
  listModels: () => Effect.succeed([]),
  listAgents: () => Effect.succeed([]),
  switchAgent: () => Effect.void,
  switchModel: () => Effect.void,
  replyQuestion: () => Effect.void,
  events: () => Stream.never,
}

const interactionLayer = Layer.effect(
  InteractionStore,
  Effect.gen(function* () {
    const values = yield* Ref.make<ReadonlyMap<string, JsonValue>>(new Map())
    const service: InteractionStateStore = {
      get: (key) => Ref.get(values).pipe(Effect.map((current) => Option.fromNullishOr(current.get(key)))),
      set: (key, value) => Ref.update(values, (current) => new Map(current).set(key, value)),
      modify: (key, change) => Ref.modify(values, (current) => {
        const [result, value] = change(Option.fromNullishOr(current.get(key)))
        return [result, new Map(current).set(key, value)]
      }),
    }
    return service
  }),
)

const config = new AppConfig({
  telegramBotToken: "controller-token",
  projectDirectory: "/tmp",
  stateFile: "/tmp/state.json",
  webDatabaseFile: "/tmp/web.sqlite",
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
})

describe("Telegram run delivery ownership", () => {
  test("creates the run anchor through the selected delivery route without callback markup", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sent = yield* Ref.make<Parameters<TelegramDeliveryClient["sendMessage"]>[0] | undefined>(undefined)
      const controllerSends = yield* Ref.make(0)
      const anchorSent = yield* Deferred.make<void>()
      const permissions = yield* PermissionRegistry
      const questions = yield* QuestionRegistry
      const delivery: TelegramDeliveryClient = {
        sendMessage: (input) => Ref.set(sent, input).pipe(
          Effect.andThen(Deferred.succeed(anchorSent, undefined)),
          Effect.as({ message_id: 71, chat: { id: input.chatId }, message_thread_id: input.messageThreadId }),
        ),
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.succeed(undefined),
      }
      const controller: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: (input) => Ref.update(controllerSends, (count) => count + 1).pipe(
          Effect.as({ message_id: 72, chat: { id: input.chatId } }),
        ),
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.succeed(undefined),
        answerCallbackQuery: () => Effect.succeed(true),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const fiber = yield* Effect.forkChild(runPrompt({
        sessionID: "ses_1",
        files: [],
        verbosity: "normal",
        controllerRoute: { botKey: "controller", chatId: -200, threadId: 99 },
        runDeliveryRoute: { botKey: "delivery-1", chatId: -100, threadId: 42 },
        deliveryApi: delivery,
      }).pipe(Effect.provideService(TelegramApi, controller)))
      yield* Deferred.await(anchorSent)
      const input = yield* Ref.get(sent)
      const controllerCount = yield* Ref.get(controllerSends)
      let permissionRoute = yield* permissions.getSessionRoute("ses_1")
      let questionRoute = yield* questions.getSessionRoute("ses_1")
      for (let attempt = 0; attempt < 20 && (Option.isNone(permissionRoute) || Option.isNone(questionRoute)); attempt += 1) {
        yield* Effect.yieldNow
        permissionRoute = yield* permissions.getSessionRoute("ses_1")
        questionRoute = yield* questions.getSessionRoute("ses_1")
      }
      yield* Fiber.interrupt(fiber)
      return { input, controllerCount, permissionRoute, questionRoute }
    }).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(PermissionRegistryLive.pipe(Layer.provide(interactionLayer))),
      Effect.provide(QuestionRegistryLive.pipe(Layer.provide(interactionLayer))),
      Effect.provideService(OpenCode, openCode),
      Effect.provideService(AppConfigTag, config),
      Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.never)),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    )))

    expect(result.input).toMatchObject({
      chatId: -100,
      messageThreadId: 42,
      text: "Working…",
    })
    expect(result.input?.replyMarkup).toBeUndefined()
    expect(result.controllerCount).toBe(0)
    expect(Option.getOrUndefined(result.permissionRoute)).toEqual({ chatId: -200, threadId: 99 })
    expect(Option.getOrUndefined(result.questionRoute)).toEqual({ chatId: -200, threadId: 99 })
  })
})
