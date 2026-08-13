import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"
import { Live as PermissionRegistryLive, PermissionRegistry } from "../src/telegram/permissions.js"
import { Live as QuestionRegistryLive, QuestionRegistry } from "../src/telegram/questions.js"
import { reconcilePendingSession } from "../src/telegram/resurface.js"

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
  listPendingQuestions: () => Effect.succeed([{
    id: "frm_pending",
    sessionID: "ses_pending",
    questions: [{
      header: "Approval",
      question: "Approve?",
      options: [{ label: "Yes", description: "Approve" }],
      custom: false,
      multiple: false,
    }],
  }]),
  replyPermission: () => Effect.void,
  listModels: () => Effect.succeed([]),
  listAgents: () => Effect.succeed([]),
  switchAgent: () => Effect.void,
  switchModel: () => Effect.void,
  replyQuestion: () => Effect.void,
  events: () => Stream.never,
}

describe("pending interaction reconciliation", () => {
  test("reconnect sends an unsurfaced question and persists its message id", async () => {
    const sent = await Effect.runPromise(Ref.make(0))
    const api: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: () => Ref.updateAndGet(sent, (count) => count + 1).pipe(Effect.map((message_id) => ({ message_id, chat: { id: 7 } }))),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* reconcilePendingSession("/work", "ses_pending", { chatId: 7, threadId: 42 })
      const questions = yield* QuestionRegistry
      const entry = yield* questions.findByRequest(7, "ses_pending", "frm_pending")
      const permissions = yield* PermissionRegistry
      return { entry, route: yield* permissions.getSessionRoute("ses_pending") }
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, openCode)),
      Effect.provide(Layer.succeed(TelegramApi, api)),
      Effect.provide(FetchHttpClient.layer),
    ))
    expect(Option.isSome(result.entry) && result.entry.value.messageIds[0]).toBe(1)
    expect(result.route).toEqual(Option.some({ chatId: 7, threadId: 42 }))
  })

  test("reconciliation preserves the active session route", async () => {
    const api: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: () => Effect.succeed({ message_id: 1, chat: { id: 7 } }),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }
    const route = await Effect.runPromise(Effect.gen(function* () {
      const permissions = yield* PermissionRegistry
      yield* permissions.setSessionRoute("ses_pending", { chatId: 7, threadId: 42 })
      yield* reconcilePendingSession("/work", "ses_pending", { chatId: 99 })
      return yield* permissions.getSessionRoute("ses_pending")
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, openCode)),
      Effect.provide(Layer.succeed(TelegramApi, api)),
      Effect.provide(FetchHttpClient.layer),
    ))
    expect(route).toEqual(Option.some({ chatId: 7, threadId: 42 }))
  })

  test("reconciliation delivers questions through their independent route", async () => {
    const destinations = await Effect.runPromise(Ref.make<readonly { readonly chatId: number; readonly threadId?: number }[]>([]))
    const api: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.update(destinations, (items) => [...items, {
        chatId: input.chatId,
        threadId: input.messageThreadId,
      }]).pipe(Effect.as({ message_id: 1, chat: { id: input.chatId } })),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const permissions = yield* PermissionRegistry
      const questions = yield* QuestionRegistry
      yield* permissions.setSessionRoute("ses_pending", { chatId: 7, threadId: 42 })
      yield* questions.setSessionRoute("ses_pending", { chatId: 9, threadId: 84 })
      yield* reconcilePendingSession("/work", "ses_pending", { chatId: 7, threadId: 42 })
      return yield* Ref.get(destinations)
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, openCode)),
      Effect.provide(Layer.succeed(TelegramApi, api)),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(result).toEqual([{ chatId: 9, threadId: 84 }])
  })
})
