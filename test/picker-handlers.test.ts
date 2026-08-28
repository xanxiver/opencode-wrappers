import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { Session } from "@opencode-ai/client/effect"
import * as ModelSchema from "@opencode-ai/schema/model"
import * as Provider from "@opencode-ai/schema/provider"
import { FetchHttpClient } from "effect/unstable/http"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { TelegramApi, type CallbackQuery, type TelegramApiClient } from "../src/telegram/api.js"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import {
  handleModelCallback,
  handleModelProviderCallback,
  handleModelVariantCallback,
  selectExactModel,
} from "../src/telegram/handlers/model.js"
import { handleSessionCallback } from "../src/telegram/handlers/picker.js"
import { Live as ModelRegistryLive, ModelRegistry } from "../src/telegram/models.js"
import { Live as SessionSelectionLive } from "../src/telegram/session-selection.js"
import { Live as PickersLive, Pickers } from "../src/telegram/pickers.js"

const storeService = (selected: Ref.Ref<string | undefined>, currentSessionID?: string): StoreService => ({
  getSessionIDForConversation: () => Effect.succeed(Option.fromNullishOr(currentSessionID)),
  listConversationSessions: () => Effect.succeed([]),
  setSessionIDForConversation: (_conversation, sessionID) => Ref.set(selected, sessionID),
  removeSessionIDForConversation: () => Effect.void,
  getSessionIDForDirectory: () => Effect.succeed(Option.none()),
  setSessionIDForDirectory: () => Effect.void,
  removeSessionIDForDirectory: () => Effect.void,
  getDirectory: () => Effect.succeed(Option.none()),
  setDirectory: () => Effect.void,
  switchConversationDirectory: () => Effect.void,
  getDirectoryModelFallback: () => Effect.succeed(Option.none()),
  getSessionAgentModel: () => Effect.succeed(Option.none()),
  setSessionAgentModel: () => Effect.void,
  getLoosePrompts: () => Effect.succeed(false),
  setLoosePrompts: () => Effect.void,
  getAutoContinue: () => Effect.succeed(false),
  setAutoContinue: () => Effect.void,
  getStreamVerbosity: () => Effect.succeed("normal"),
  setStreamVerbosity: () => Effect.void,
  listClients: () => Effect.succeed([]),
  listDirectories: () => Effect.succeed([]),
})

const sessionsService = (directory: string): SessionsService => ({
  getOrCreate: () => Effect.succeed("ses_current"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed(directory),
  setDirectory: () => Effect.void,
})

const sessionInfo = (id: string, agent?: string) => {
  const base = {
    id,
    projectID: "project",
    location: { directory: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  return Schema.decodeUnknownSync(Session.Info)(agent === undefined ? base : { ...base, agent })
}

const openCodeForAgent = (agent?: string): OpenCodeService => ({
  createSession: () => Effect.never,
  getSession: () => Effect.succeed(sessionInfo("ses_current", agent)),
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
})

describe("Telegram picker callbacks", () => {
  test("opens the selected provider model page", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const answers = yield* Ref.make<string[]>([])
      const edits = yield* Ref.make<string[]>([])
      const order = yield* Ref.make<string[]>([])
      const token = yield* registry.registerProviders({
        sessionID: "ses_current",
        agentID: "build",
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
        editMessageText: ({ text }) => Ref.update(order, (values) => [...values, "edited"]).pipe(
          Effect.andThen(Ref.update(edits, (values) => [...values, text])),
          Effect.as({ message_id: 10, chat: { id: 7 } }),
        ),
        answerCallbackQuery: ({ text }) => Ref.update(order, (values) => [...values, "acknowledged"]).pipe(
          Effect.andThen(Ref.update(answers, (values) => [...values, text ?? ""])),
          Effect.as(true),
        ),
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
        Effect.provide(Layer.succeed(OpenCode, openCodeForAgent("build"))),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return {
        answers: yield* Ref.get(answers),
        edits: yield* Ref.get(edits),
        order: yield* Ref.get(order),
      }
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(result.answers).toEqual(["Opening models."])
    expect(result.edits).toEqual(["Provider provider - select a model:"])
    expect(result.order).toEqual(["acknowledged", "edited"])
  })

  test("switches a current model picker selection", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const switched = yield* Ref.make<string | undefined>(undefined)
      const remembered = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const edits = yield* Ref.make<string[]>([])
      const order = yield* Ref.make<string[]>([])
      const token = yield* registry.registerPage({
        sessionID: "ses_current",
        agentID: "build",
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
        editMessageText: ({ text }) => Ref.update(order, (values) => [...values, "edited"]).pipe(
          Effect.andThen(Ref.update(edits, (values) => [...values, text])),
          Effect.as({ message_id: 10, chat: { id: 7 } }),
        ),
        answerCallbackQuery: ({ text }) => Ref.update(order, (values) => [...values, "acknowledged"]).pipe(
          Effect.andThen(Ref.update(answers, (values) => [...values, text ?? ""])),
          Effect.as(true),
        ),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      const opencode: OpenCodeService = {
        createSession: () => Effect.never,
        getSession: () => Effect.succeed(sessionInfo("ses_current", "build")),
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
        switchModel: ({ model }) => Ref.update(order, (values) => [...values, "switched"]).pipe(
          Effect.andThen(Ref.set(switched, model.id)),
        ),
        replyQuestion: () => Effect.void,
        events: () => Stream.never,
      }
      const store = {
        ...storeService(yield* Ref.make<string | undefined>(undefined), "ses_current"),
        setSessionAgentModel: (_sessionID: string, _agentID: string, model: { readonly id: string }) =>
          Ref.set(remembered, model.id),
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
        order: yield* Ref.get(order),
      }
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(result.switched).toBe("model")
    expect(result.remembered).toBe("model")
    expect(result.answers).toEqual(["Applying model."])
    expect(result.edits).toEqual(["Model for build switched to provider/model."])
    expect(result.order).toEqual(["acknowledged", "switched", "edited"])
  })

  test("rejects a model picker after the active agent changes", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const switched = yield* Ref.make<string | undefined>(undefined)
      const remembered = yield* Ref.make<string | undefined>(undefined)
      const answers = yield* Ref.make<string[]>([])
      const edits = yield* Ref.make<string[]>([])
      const order = yield* Ref.make<string[]>([])
      const token = yield* registry.registerPage({
        sessionID: "ses_current",
        agentID: "build",
        directory: "/project",
        models: [{ id: "model", providerID: "provider", variants: [] }],
        page: 0,
        total: 1,
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const client: OpenCodeService = {
        ...openCodeForAgent("plan"),
        getSession: () => Ref.update(order, (values) => [...values, "session"]).pipe(
          Effect.as(sessionInfo("ses_current", "plan")),
        ),
        switchModel: ({ model }) => Ref.set(switched, model.id),
      }
      const currentStore: StoreService = {
        ...storeService(yield* Ref.make<string | undefined>(undefined), "ses_current"),
        setSessionAgentModel: (_sessionID, _agentID, model) => Ref.set(remembered, model.id),
      }
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: (input) => Ref.update(order, (values) => [...values, "edited"]).pipe(
          Effect.andThen(Ref.update(edits, (values) => [...values, input.text])),
          Effect.as({ message_id: input.messageId, chat: { id: input.chatId } }),
        ),
        answerCallbackQuery: ({ text }) => Ref.update(order, (values) => [...values, "acknowledged"]).pipe(
          Effect.andThen(Ref.update(answers, (values) => [...values, text ?? ""])),
          Effect.as(true),
        ),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      yield* handleModelCallback(
        { id: "callback-model-agent-stale", from: { id: 1 }, message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 } },
        `model:${token}:0`,
      ).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
        Effect.provide(Layer.succeed(Store, currentStore)),
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return {
        switched: yield* Ref.get(switched),
        remembered: yield* Ref.get(remembered),
        answers: yield* Ref.get(answers),
        edits: yield* Ref.get(edits),
        order: yield* Ref.get(order),
      }
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(result.switched).toBeUndefined()
    expect(result.remembered).toBeUndefined()
    expect(result.answers).toEqual(["Applying model."])
    expect(result.edits).toEqual(["The active agent changed. Run /models again."])
    expect(result.order).toEqual(["acknowledged", "session", "edited"])
  })

  test("saves a selected variant for the active session-agent pair", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* ModelRegistry
      const switched = yield* Ref.make<unknown>(undefined)
      const remembered = yield* Ref.make<unknown>(undefined)
      const token = yield* registry.registerVariant({
        sessionID: "ses_current",
        agentID: "build",
        directory: "/project",
        providerID: "provider",
        modelID: "model",
        variants: ["high"],
        chatId: 7,
        messageId: 10,
      })
      const client: OpenCodeService = {
        ...openCodeForAgent("build"),
        switchModel: ({ model }) => Ref.set(switched, model),
      }
      const currentStore: StoreService = {
        ...storeService(yield* Ref.make<string | undefined>(undefined), "ses_current"),
        setSessionAgentModel: (sessionID, agentID, model) => Ref.set(remembered, { sessionID, agentID, model }),
      }
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: () => Effect.never,
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: (input) => Effect.succeed({ message_id: input.messageId, chat: { id: input.chatId } }),
        answerCallbackQuery: () => Effect.succeed(true),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }
      yield* handleModelVariantCallback(
        { id: "callback-model-variant", from: { id: 1 }, message: { message_id: 10, chat: { id: 7 } } },
        `modelv:${token}:0`,
      ).pipe(
        Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
        Effect.provide(Layer.succeed(Store, currentStore)),
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )
      return { switched: yield* Ref.get(switched), remembered: yield* Ref.get(remembered) }
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(result.switched).toEqual({ id: "model", providerID: "provider", variant: "high" })
    expect(result.remembered).toEqual({
      sessionID: "ses_current",
      agentID: "build",
      model: { id: "model", providerID: "provider", variant: "high" },
    })
  })

  test("saves an exact model command for the active session-agent pair", async () => {
    const switched = await Effect.runPromise(Ref.make<unknown>(undefined))
    const remembered = await Effect.runPromise(Ref.make<unknown>(undefined))
    const sent = await Effect.runPromise(Ref.make<string[]>([]))
    const model = ModelSchema.Info.default(Provider.ID.make("provider"), ModelSchema.ID.make("model"))
    const client: OpenCodeService = {
      ...openCodeForAgent("build"),
      listModels: () => Effect.succeed([model]),
      switchModel: ({ model: selected }) => Ref.set(switched, selected),
    }
    const currentStore: StoreService = {
      ...storeService(await Effect.runPromise(Ref.make<string | undefined>(undefined)), "ses_current"),
      setSessionAgentModel: (sessionID, agentID, selected) =>
        Ref.set(remembered, { sessionID, agentID, model: selected }),
    }
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.update(sent, (values) => [...values, input.text]).pipe(
        Effect.as({ message_id: 1, chat: { id: input.chatId } }),
      ),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(selectExactModel(7, "provider/model", 42).pipe(
      Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
      Effect.provide(Layer.succeed(Store, currentStore)),
      Effect.provide(Layer.succeed(OpenCode, client)),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(SessionSelectionLive),
    ))

    expect(await Effect.runPromise(Ref.get(switched))).toEqual({ id: "model", providerID: "provider" })
    expect(await Effect.runPromise(Ref.get(remembered))).toEqual({
      sessionID: "ses_current",
      agentID: "build",
      model: { id: "model", providerID: "provider" },
    })
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Model for build switched to provider/model.",
    ])
  })

  test("switches the session model without saving a sentinel agent preference", async () => {
    const saved = await Effect.runPromise(Ref.make(false))
    const sent = await Effect.runPromise(Ref.make<string[]>([]))
    const model = ModelSchema.Info.default(Provider.ID.make("provider"), ModelSchema.ID.make("model"))
    const client: OpenCodeService = {
      ...openCodeForAgent(),
      listModels: () => Effect.succeed([model]),
    }
    const currentStore: StoreService = {
      ...storeService(await Effect.runPromise(Ref.make<string | undefined>(undefined)), "ses_current"),
      setSessionAgentModel: () => Ref.set(saved, true),
    }
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.update(sent, (values) => [...values, input.text]).pipe(
        Effect.as({ message_id: 1, chat: { id: input.chatId } }),
      ),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(selectExactModel(7, "provider/model").pipe(
      Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
      Effect.provide(Layer.succeed(Store, currentStore)),
      Effect.provide(Layer.succeed(OpenCode, client)),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(SessionSelectionLive),
    ))

    expect(await Effect.runPromise(Ref.get(saved))).toBe(false)
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Session model switched to provider/model.",
    ])
  })

  test("does not save an exact model when the OpenCode switch fails", async () => {
    const saved = await Effect.runPromise(Ref.make(false))
    const model = ModelSchema.Info.default(Provider.ID.make("provider"), ModelSchema.ID.make("model"))
    const client: OpenCodeService = {
      ...openCodeForAgent("build"),
      listModels: () => Effect.succeed([model]),
      switchModel: () => Effect.fail(new OpenCodeError({
        operation: "switch model",
        cause: new Error("unavailable"),
      })),
    }
    const currentStore: StoreService = {
      ...storeService(await Effect.runPromise(Ref.make<string | undefined>(undefined)), "ses_current"),
      setSessionAgentModel: () => Ref.set(saved, true),
    }

    const exit = await Effect.runPromiseExit(selectExactModel(7, "provider/model").pipe(
      Effect.provide(Layer.succeed(Sessions, sessionsService("/project"))),
      Effect.provide(Layer.succeed(Store, currentStore)),
      Effect.provide(Layer.succeed(OpenCode, client)),
      Effect.provide(Layer.succeed(TelegramApi, {
        getUpdates: () => Effect.never,
        sendMessage: (input) => Effect.succeed({ message_id: 1, chat: { id: input.chatId } }),
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: () => Effect.succeed(true),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      })),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(SessionSelectionLive),
    ))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Effect.runPromise(Ref.get(saved))).toBe(false)
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
        agentID: "build",
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
        setSessionAgentModel: (_sessionID: string, _agentID: string, model: { readonly id: string }) =>
          Ref.set(remembered, model.id),
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
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

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
        agentID: "build",
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
        setSessionAgentModel: (_sessionID: string, _agentID: string, model: { readonly id: string }) =>
          Ref.set(remembered, model.id),
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
    }).pipe(Effect.provide(ModelRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(result.switched).toBeUndefined()
    expect(result.remembered).toBeUndefined()
    expect(result.answers).toEqual(["This model picker is no longer current."])
  })
})
