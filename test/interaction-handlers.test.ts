import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { TelegramApi, type CallbackQuery, type TelegramApiClient } from "../src/telegram/api.js"
import { handlePermissionCallback } from "../src/telegram/handlers/permission.js"
import { handleQuestionCallback, recordQuestionAnswer } from "../src/telegram/handlers/question.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"
import { Live as PermissionRegistryLive, PermissionRegistry } from "../src/telegram/permissions.js"
import { Live as QuestionRegistryLive, QuestionRegistry } from "../src/telegram/questions.js"

const telegramApi: TelegramApiClient = {
  getUpdates: () => Effect.never,
  sendMessage: () => Effect.never,
  sendPhoto: () => Effect.never,
  sendVideo: () => Effect.never,
  sendDocument: () => Effect.never,
  editMessageText: () => Effect.never,
  answerCallbackQuery: () => Effect.succeed(true),
  getFile: () => Effect.never,
  downloadFile: () => Effect.never,
}

const openCode = (permissionCalls: Ref.Ref<number>, questionCalls: Ref.Ref<number>): OpenCodeService => ({
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
  replyPermission: () => Ref.update(permissionCalls, (count) => count + 1),
  listModels: () => Effect.succeed([]),
  listAgents: () => Effect.succeed([]),
  switchAgent: () => Effect.void,
  switchModel: () => Effect.void,
  replyQuestion: () => Ref.update(questionCalls, (count) => count + 1),
  events: () => Stream.never,
})

describe("interaction callback claim fencing", () => {
  test("does not send a permission reply after initial lease validation is lost", async () => {
    const calls = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* PermissionRegistry
      const permissionCalls = yield* Ref.make(0)
      const questionCalls = yield* Ref.make(0)
      const token = yield* registry.register({ sessionID: "ses_1", requestID: "per_1", chatId: 7 })
      yield* registry.attachMessageId(token, 10)
      const staleRegistry = Layer.succeed(PermissionRegistry, { ...registry, renewClaim: () => Effect.succeed(false) })
      const query: CallbackQuery = { id: "callback-1", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 } } }
      yield* handlePermissionCallback(query, `perm:${token}:once`).pipe(
        Effect.provide(staleRegistry),
        Effect.provide(Layer.succeed(OpenCode, openCode(permissionCalls, questionCalls))),
        Effect.provide(Layer.succeed(TelegramApi, telegramApi)),
        Effect.provide(FetchHttpClient.layer),
      )
      return yield* Ref.get(permissionCalls)
    }).pipe(Effect.provide(PermissionRegistryLive), Effect.provide(InteractionStoreMemory)))
    expect(calls).toBe(0)
  })

  test("does not send a completed question after initial lease validation is lost", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const permissionCalls = yield* Ref.make(0)
      const questionCalls = yield* Ref.make(0)
      const token = yield* registry.register({
        sessionID: "ses_1",
        requestID: "que_1",
        chatId: 7,
        questions: ["Continue?"],
        options: [["Yes"]],
        customs: [false],
        multiples: [false],
      })
      const staleRegistry = Layer.succeed(QuestionRegistry, { ...registry, renewClaim: () => Effect.succeed(false) })
      yield* recordQuestionAnswer(token, 0, ["Yes"]).pipe(
        Effect.provide(staleRegistry),
        Effect.provide(Layer.succeed(OpenCode, openCode(permissionCalls, questionCalls))),
        Effect.provide(Layer.succeed(TelegramApi, telegramApi)),
        Effect.provide(FetchHttpClient.layer),
        Effect.exit,
      )
      return { calls: yield* Ref.get(questionCalls), restored: yield* registry.get(token) }
    }).pipe(Effect.provide(QuestionRegistryLive), Effect.provide(InteractionStoreMemory)))
    expect(result.calls).toBe(0)
    expect(Option.isSome(result.restored)).toBe(true)
  })

  test("keeps the confirm button after a multi-select option is chosen", async () => {
    const edited = await Effect.runPromise(Ref.make<Parameters<TelegramApiClient["editMessageText"]>[0] | undefined>(undefined))
    const permissionCalls = await Effect.runPromise(Ref.make(0))
    const questionCalls = await Effect.runPromise(Ref.make(0))
    const api: TelegramApiClient = {
      ...telegramApi,
      editMessageText: (input) => Ref.set(edited, input).pipe(Effect.as({ message_id: input.messageId, chat: { id: input.chatId } })),
    }
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        requestID: "que_multi",
        chatId: 7,
        questions: ["Choose"],
        options: [["One", "Two"]],
        customs: [false],
        multiples: [true],
      })
      yield* registry.attachMessageId(token, 0, 10)
      const query: CallbackQuery = { id: "callback-2", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 } } }
      yield* handleQuestionCallback(query, `q:${token}:0:0`).pipe(
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provide(Layer.succeed(OpenCode, openCode(permissionCalls, questionCalls))),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
    ))
    const update = await Effect.runPromise(Ref.get(edited))
    expect(update?.replyMarkup?.inline_keyboard.flat().some((button) => button.text === "Confirm")).toBe(true)
  })

  test("acknowledges a completed multi-question callback before submitting it to OpenCode", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      const order = yield* Ref.make<readonly string[]>([])
      const replyStarted = yield* Deferred.make<void>()
      const releaseReply = yield* Deferred.make<void>()
      const permissionCalls = yield* Ref.make(0)
      const questionCalls = yield* Ref.make(0)
      const token = yield* registry.register({
        sessionID: "ses_1",
        requestID: "que_multi_complete",
        chatId: 7,
        questions: ["Continue?", "Choose"],
        options: [["Yes"], ["One", "Two"]],
        customs: [false, false],
        multiples: [false, true],
      })
      yield* registry.attachMessageId(token, 0, 10)
      yield* registry.attachMessageId(token, 1, 11)
      yield* registry.answer(token, 0, ["Yes"])
      yield* registry.toggleSelection(token, 1, "One")

      const api: TelegramApiClient = {
        ...telegramApi,
        answerCallbackQuery: () => Ref.update(order, (events) => [...events, "acknowledged"]).pipe(Effect.as(true)),
        editMessageText: (input) => Effect.succeed({ message_id: input.messageId, chat: { id: input.chatId } }),
      }
      const client: OpenCodeService = {
        ...openCode(permissionCalls, questionCalls),
        replyQuestion: () => Ref.update(order, (events) => [...events, "submitted"]).pipe(
          Effect.andThen(Deferred.succeed(replyStarted, undefined)),
          Effect.andThen(Deferred.await(releaseReply)),
        ),
      }
      const query: CallbackQuery = {
        id: "callback-multi-complete",
        from: { id: 7 },
        message: { message_id: 11, chat: { id: 7 } },
      }
      const fiber = yield* handleQuestionCallback(query, `q:${token}:1:confirm`).pipe(
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.forkChild,
      )

      yield* Deferred.await(replyStarted)
      expect(yield* Ref.get(order)).toEqual(["acknowledged", "submitted"])
      yield* Deferred.succeed(releaseReply, undefined)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
    ))
  })
})
