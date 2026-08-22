import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { TelegramApi, type CallbackQuery, type TelegramApiClient } from "../src/telegram/api.js"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { handleModelCallback, handleModelProviderCallback } from "../src/telegram/handlers/model.js"
import { handleSessionCallback } from "../src/telegram/handlers/picker.js"
import { Live as ModelRegistryLive, ModelRegistry } from "../src/telegram/models.js"
import { Live as PickersLive, Pickers } from "../src/telegram/pickers.js"

const storeService = (selected: Ref.Ref<string | undefined>, currentSessionID?: string): StoreService => ({
  getSessionIDForConversation: () => Effect.succeed(Option.fromNullishOr(currentSessionID)),
  setSessionIDForConversation: (_conversation, sessionID) => Ref.set(selected, sessionID),
  removeSessionIDForConversation: () => Effect.void,
  getSessionIDForDirectory: () => Effect.succeed(Option.none()),
  setSessionIDForDirectory: () => Effect.void,
  removeSessionIDForDirectory: () => Effect.void,
  getDirectory: () => Effect.succeed(Option.none()),
  setDirectory: () => Effect.void,
  switchConversationDirectory: () => Effect.void,
  getModel: () => Effect.succeed(Option.none()),
  setModel: () => Effect.void,
  getLoosePrompts: () => Effect.succeed(false),
  setLoosePrompts: () => Effect.void,
  getAutoContinue: () => Effect.succeed(false),
  setAutoContinue: () => Effect.void,
  listClients: () => Effect.succeed([]),
  listDirectories: () => Effect.succeed([]),
})

const sessionsService = (directory: string): SessionsService => ({
  getOrCreate: () => Effect.succeed("ses_current"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed(directory),
  setDirectory: () => Effect.void,
})

describe("Telegram picker callbacks", () => {
  test("opens the selected provider model page", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const answers = yield* Ref.make<string[]>([])
      const edits = yield* Ref.make<string[]>([])
      const token = yield* registry.registerProviders({
        sessionID: "ses_current",
        directory: "/project",
        providers: [{
          id: "provider",
          models: [{ id: "model", providerID: "provider", variants: [] }],
        }],
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: ({ text }) => Ref.update(edits, (values) => [...values, text]).pipe(
          Effect.as({ message_id: 10, chat: { id: 7 } }),
        ),
        answerCallbackQuery: ({ text }) => Ref.update(answers, (values) => [...values, text ?? ""]).pipe(Effect.as(true)),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const store = storeService(yield* Ref.make<string | undefined>(undefined), "ses_current")
      const query: CallbackQuery = {
        id: "callback-provider",
        from: { id: 1 },
        message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 },
      }
      yield* handleModelProviderCallback(query, `modelpr:${token}:0`).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return { answers: yield* Ref.get(answers), edits: yield* Ref.get(edits) }
    }).pipe(Effect.provide(ModelRegistryLive)))

    expect(result.answers).toEqual(["Choose a model."])
    expect(result.edits).toEqual(["Provider provider — select a model:"])
  })

  test("switches a current model picker selection", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const switched = yield* Ref.make<string | undefined>(undefined)
      const remembered = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const edits = yield* Ref.make<string[]>([])
      const token = yield* registry.registerPage({
        sessionID: "ses_current",
        directory: "/project",
        models: [{ id: "model", providerID: "provider", variants: [] }],
        page: 0,
        total: 1,
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: ({ text }) => Ref.update(edits, (values) => [...values, text]).pipe(
          Effect.as({ message_id: 10, chat: { id: 7 } }),
        ),
        answerCallbackQuery: ({ text }) => Ref.update(answers, (values) => [...values, text ?? ""]).pipe(Effect.as(true)),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const opencode: OpenCodeService = {
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
        switchModel: ({ model }) => Ref.set(switched, model.id),
        replyQuestion: () => Effect.void,
        events: () => Stream.never,
      }
      const store = {
        ...storeService(yield* Ref.make<string | undefined>(undefined), "ses_current"),
        setModel: (_directory: string, model: { readonly id: string }) => Ref.set(remembered, model.id),
      }
      const query: CallbackQuery = {
        id: "callback-model-current",
        from: { id: 1 },
        message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 },
      }
      yield* handleModelCallback(query, `model:${token}:0`).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(OpenCode, opencode)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return {
        switched: yield* Ref.get(switched),
        remembered: yield* Ref.get(remembered),
        answers: yield* Ref.get(answers),
        edits: yield* Ref.get(edits),
      }
    }).pipe(Effect.provide(ModelRegistryLive)))

    expect(result.switched).toBe("model")
    expect(result.remembered).toBe("model")
    expect(result.answers).toEqual(["Switched."])
    expect(result.edits).toEqual(["Model switched to model"])
  })

  test("rejects a session selection after the conversation changes directory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const pickers = yield* Pickers
      const selected = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const token = yield* pickers.registerSession({
        sessionID: "ses_old_project",
        directory: "/old-project",
        title: Option.none(),
        chatId: 7,
      })
      yield* pickers.attachMessageId(token, 10)
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: ({ text }) => Ref.update(answers, (values) => [...values, text ?? ""]).pipe(Effect.as(true)),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const query: CallbackQuery = {
        id: "callback-1",
        from: { id: 1 },
        message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 },
      }
      yield* handleSessionCallback(query, `ses:${token}`).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/new-project"))),
        Effect.provide(Layer.succeed(Store, storeService(selected))),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return { selected: yield* Ref.get(selected), answers: yield* Ref.get(answers) }
    }).pipe(Effect.provide(PickersLive)))

    expect(result.selected).toBeUndefined()
    expect(result.answers).toEqual(["This session picker is no longer current."])
  })

  test("rejects a model selection after the conversation changes directory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const selected = yield* Ref.make<string | undefined>(undefined)
      const remembered = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const token = yield* registry.registerPage({
        sessionID: "ses_old_project",
        directory: "/old-project",
        models: [{ id: "old-model", providerID: "provider", variants: [] }],
        page: 0,
        total: 1,
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: ({ text }) => Ref.update(answers, (values) => [...values, text ?? ""]).pipe(Effect.as(true)),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const opencode: OpenCodeService = {
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
        switchModel: ({ model }) => Ref.set(selected, model.id),
        replyQuestion: () => Effect.void,
        events: () => Stream.never,
      }
      const store = {
        ...storeService(yield* Ref.make<string | undefined>(undefined)),
        setModel: (_directory: string, model: { readonly id: string }) => Ref.set(remembered, model.id),
      }
      const query: CallbackQuery = {
        id: "callback-model",
        from: { id: 1 },
        message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 },
      }
      yield* handleModelCallback(query, `model:${token}:0`).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/new-project"))),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(OpenCode, opencode)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return {
        selected: yield* Ref.get(selected),
        remembered: yield* Ref.get(remembered),
        answers: yield* Ref.get(answers),
      }
    }).pipe(Effect.provide(ModelRegistryLive)))

    expect(result.selected).toBeUndefined()
    expect(result.remembered).toBeUndefined()
    expect(result.answers).toEqual(["This model picker is no longer current."])
  })

  test("rejects a model selection after the conversation changes session in the same directory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const switched = yield* Ref.make<string | undefined>(undefined)
      const remembered = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const token = yield* registry.registerPage({
        sessionID: "ses_old",
        directory: "/project",
        models: [{ id: "model-old", providerID: "provider", variants: [] }],
        page: 0,
        total: 1,
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: ({ text }) => Ref.update(answers, (values) => [...values, text ?? ""]).pipe(Effect.as(true)),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const opencode: OpenCodeService = {
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
        switchModel: ({ model }) => Ref.set(switched, model.id),
        replyQuestion: () => Effect.void,
        events: () => Stream.never,
      }
      const store = {
        ...storeService(yield* Ref.make<string | undefined>(undefined), "ses_new"),
        setModel: (_directory: string, model: { readonly id: string }) => Ref.set(remembered, model.id),
      }
      const query: CallbackQuery = {
        id: "callback-model-session",
        from: { id: 1 },
        message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 },
      }
      yield* handleModelCallback(query, `model:${token}:0`).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(OpenCode, opencode)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return {
        switched: yield* Ref.get(switched),
        remembered: yield* Ref.get(remembered),
        answers: yield* Ref.get(answers),
      }
    }).pipe(Effect.provide(ModelRegistryLive)))

    expect(result.switched).toBeUndefined()
    expect(result.remembered).toBeUndefined()
    expect(result.answers).toEqual(["This model picker is no longer current."])
  })
})
