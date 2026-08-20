import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Permission, Session } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
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

describe("child session reconciliation", () => {
  const sessionInfo = (id: string, parentID?: string) => {
    const base = {
      id,
      projectID: "project",
      location: { directory: "/work" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }
    return Schema.decodeUnknownSync(Session.Info)(parentID === undefined ? base : { ...base, parentID })
  }

  /** Build a session tree where each key has the listed parent (undefined = root). */
  const treeOpenCode = (
    parentOf: Record<string, string | undefined>,
    permissions: readonly { readonly id: string; readonly sessionID: string; readonly action: string; readonly resources: readonly string[] }[],
    questions: readonly { readonly id: string; readonly sessionID: string; readonly questions: readonly { readonly header: string; readonly question: string; readonly options: readonly { readonly label: string; readonly description: string }[]; readonly custom?: boolean; readonly multiple?: boolean }[] }[],
  ): OpenCodeService => ({
    ...openCode,
    getSession: (sessionID) => {
      const parentID = parentOf[sessionID]
      if (!(sessionID in parentOf)) {
        return Effect.fail(new OpenCodeError({ operation: "session.get", cause: new Error(`unknown ${sessionID}`) }))
      }
      return Effect.succeed(sessionInfo(sessionID, parentID))
    },
    listPendingPermissions: () => Effect.succeed(
      permissions.map((request) => Schema.decodeUnknownSync(Permission.Request)(request)),
    ),
    listPendingQuestions: () => Effect.succeed(questions),
  })

  const countingApi = (sent: Ref.Ref<number>): TelegramApiClient => ({
    getUpdates: () => Effect.never,
    sendMessage: () => Ref.updateAndGet(sent, (count) => count + 1).pipe(
      Effect.map((message_id) => ({ message_id, chat: { id: 7 } })),
    ),
    sendPhoto: () => Effect.never,
    sendVideo: () => Effect.never,
    sendDocument: () => Effect.never,
    editMessageText: () => Effect.never,
    answerCallbackQuery: () => Effect.succeed(true),
    getFile: () => Effect.never,
    downloadFile: () => Effect.never,
  })

  test("surfaces a subagent permission through the root route, preserving the child session for the reply", async () => {
    const sent = await Effect.runPromise(Ref.make(0))
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* reconcilePendingSession("/work", "ses_root", { chatId: 7, threadId: 42 })
      const permissions = yield* PermissionRegistry
      return {
        sent: yield* Ref.get(sent),
        entry: yield* permissions.findByRequest(7, "ses_child", "perm_child"),
      }
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, treeOpenCode(
        { ses_root: undefined, ses_child: "ses_root" },
        [{ id: "perm_child", sessionID: "ses_child", action: "tool.shell", resources: ["bash: echo hi"] }],
        [],
      ))),
      Effect.provide(Layer.succeed(TelegramApi, countingApi(sent))),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(result.sent).toBe(1)
    // The reply must target the child session, not the root.
    expect(Option.isSome(result.entry) && result.entry.value.sessionID).toBe("ses_child")
  })

  test("surfaces a nested subagent question through the root route", async () => {
    const sent = await Effect.runPromise(Ref.make(0))
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* reconcilePendingSession("/work", "ses_root", { chatId: 7, threadId: 42 })
      const questions = yield* QuestionRegistry
      return {
        sent: yield* Ref.get(sent),
        entry: yield* questions.findByRequest(7, "ses_grandchild", "frm_grandchild"),
      }
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, treeOpenCode(
        { ses_root: undefined, ses_child: "ses_root", ses_grandchild: "ses_child" },
        [],
        [{
          id: "frm_grandchild",
          sessionID: "ses_grandchild",
          questions: [{ header: "Approval", question: "Approve?", options: [], custom: false, multiple: false }],
        }],
      ))),
      Effect.provide(Layer.succeed(TelegramApi, countingApi(sent))),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(result.sent).toBe(1)
    expect(Option.isSome(result.entry) && result.entry.value.sessionID).toBe("ses_grandchild")
  })

  test("does not surface a permission from an unrelated session tree", async () => {
    const sent = await Effect.runPromise(Ref.make(0))
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* reconcilePendingSession("/work", "ses_root", { chatId: 7, threadId: 42 })
      return {
        sent: yield* Ref.get(sent),
      }
    }).pipe(
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(Layer.succeed(OpenCode, treeOpenCode(
        { ses_root: undefined, ses_other: undefined },
        [{ id: "perm_other", sessionID: "ses_other", action: "tool.shell", resources: ["bash: ls"] }],
        [],
      ))),
      Effect.provide(Layer.succeed(TelegramApi, countingApi(sent))),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(result.sent).toBe(0)
  })
})
