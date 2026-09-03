import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { AgentRegistry, Live as AgentRegistryLive } from "../src/telegram/agents.js"
import { Live as SessionSelectionLive } from "../src/telegram/session-selection.js"
import { TelegramDurableExecutor, type TelegramDurableExecutorService } from "../src/telegram/durable-executor.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { handleAgentCallback, promptWithAgent, resolveAgent, selectableAgents } from "../src/telegram/handlers/agent.js"
import { makeAgentInfo, makeSessionInfo } from "./opencode-fixtures.js"

const agent = (
  id: string,
  name: string,
  mode: "primary" | "subagent" | "all" = "primary",
  hidden = false,
  model?: { readonly id: string; readonly providerID: string; readonly variant?: string },
) => {
  return makeAgentInfo({ id, name, mode, hidden, model })
}

const agents = [
  agent("build", "Build"),
  agent("plan", "Planner"),
  agent("explore", "Explore", "subagent"),
  agent("secret", "Secret", "primary", true),
]

const sessionInfo = (input: {
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
} = {}) => {
  return makeSessionInfo({
    id: "ses_1",
    projectID: "project",
    location: { directory: "/work" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    ...input,
  })
}

const openCode: OpenCodeService = {
  createSession: () => Effect.never,
  getSession: () => Effect.succeed(sessionInfo()),
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
  listAgents: () => Effect.succeed(agents),
  switchAgent: () => Effect.void,
  switchModel: () => Effect.void,
  replyQuestion: () => Effect.void,
  events: () => Stream.never,
}

const sessions: SessionsService = {
  getOrCreate: () => Effect.succeed("ses_1"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed("/work"),
  setDirectory: () => Effect.void,
}

const telegram: TelegramApiClient = {
  getUpdates: () => Effect.never,
  sendMessage: (input) => Effect.succeed({ message_id: 1, chat: { id: input.chatId } }),
  sendPhoto: () => Effect.never,
  sendVideo: () => Effect.never,
  sendDocument: () => Effect.never,
  editMessageText: () => Effect.never,
  answerCallbackQuery: () => Effect.succeed(true),
  getFile: () => Effect.never,
  downloadFile: () => Effect.never,
}

const store: StoreService = {
  getSessionIDForConversation: () => Effect.succeed(Option.some("ses_1")),
  listConversationSessions: () => Effect.succeed([]),
  setSessionIDForConversation: () => Effect.void,
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
}

describe("Telegram agent handlers", () => {
  test("shows only visible primary or all-mode agents", () => {
    expect(selectableAgents(agents).map((candidate) => candidate.id)).toEqual(["build", "plan"])
  })

  test("keeps an agent's configured model in the picker entry", () => {
    const configured = agent("review", "Review", "primary", false, {
      id: "configured-model",
      providerID: "provider",
      variant: "high",
    })
    expect(selectableAgents([configured])[0]?.model).toEqual({
      id: "configured-model",
      providerID: "provider",
      variant: "high",
    })
  })

  test("resolves an exact ID or case-insensitive name", () => {
    const available = selectableAgents(agents)
    expect(Option.getOrUndefined(resolveAgent(available, "build"))?.id).toBe("build")
    expect(Option.getOrUndefined(resolveAgent(available, "PLANNER"))?.id).toBe("plan")
    expect(Option.isNone(resolveAgent(available, "missing"))).toBe(true)
  })

  test("prefers a canonical ID over another agent's display name", () => {
    expect(Option.getOrUndefined(resolveAgent([
      { id: "build", name: "Builder" },
      { id: "review", name: "Build" },
    ], "build"))?.id).toBe("build")
  })

  test("submits /pwa with the resolved agent in the durable payload", async () => {
    const submitted = await Effect.runPromise(Ref.make<{ readonly text: string; readonly agent?: string } | undefined>(undefined))
    const executor: TelegramDurableExecutorService = {
      submit: (_chatId, _message, text, selectedAgent) => Ref.set(submitted, { text, agent: selectedAgent }),
      resetConversation: () => Effect.succeed("reset"),
      reconnect: () => Effect.void,
      listReviews: () => Effect.void,
      resolveReview: () => Effect.void,
      listQueue: () => Effect.void,
      moveQueue: () => Effect.void,
      clearQueue: () => Effect.void,
      deleteQueue: () => Effect.void,
    }
    await Effect.runPromise(promptWithAgent(
      7,
      { message_id: 10, chat: { id: 7 }, text: "/pwa Planner fix the queue" },
      "Planner",
      "fix the queue",
    ).pipe(
      Effect.provide(Layer.succeed(OpenCode, openCode)),
      Effect.provide(Layer.succeed(Sessions, sessions)),
      Effect.provide(Layer.succeed(TelegramDurableExecutor, executor)),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(await Effect.runPromise(Ref.get(submitted))).toEqual({ text: "fix the queue", agent: "plan" })
  })

  test("switches the current session from the inline picker", async () => {
    const switched = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const edits = await Effect.runPromise(Ref.make<string[]>([]))
    const order = await Effect.runPromise(Ref.make<string[]>([]))
    const client: OpenCodeService = {
      ...openCode,
      getSession: () => Ref.update(order, (values) => [...values, "session"]).pipe(
        Effect.as(sessionInfo()),
      ),
      switchAgent: ({ agent: selected }) => Ref.update(order, (values) => [...values, "agent"]).pipe(
        Effect.andThen(Ref.set(switched, selected)),
      ),
    }
    const api: TelegramApiClient = {
      ...telegram,
      answerCallbackQuery: () => Ref.update(order, (values) => [...values, "acknowledged"]).pipe(Effect.as(true)),
      editMessageText: (input) => Ref.update(order, (values) => [...values, "edited"]).pipe(
        Effect.andThen(Ref.update(edits, (values) => [...values, input.text])),
        Effect.as({ message_id: input.messageId, chat: { id: input.chatId } }),
      ),
    }
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: selectableAgents(agents),
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      yield* handleAgentCallback(
        { id: "callback-agent", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 } },
        `agent:${token}:1`,
      ).pipe(
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(await Effect.runPromise(Ref.get(switched))).toBe("plan")
    expect(await Effect.runPromise(Ref.get(edits))).toEqual(["Agent switched to Planner (plan)."])
    expect(await Effect.runPromise(Ref.get(order))).toEqual(["acknowledged", "session", "agent", "edited"])
  })

  test("restores the pair model after switching the agent", async () => {
    const order = await Effect.runPromise(Ref.make<string[]>([]))
    const applied = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const edits = await Effect.runPromise(Ref.make<string[]>([]))
    const client: OpenCodeService = {
      ...openCode,
      getSession: () => Ref.update(order, (values) => [...values, "session"]).pipe(
        Effect.as(sessionInfo({ model: { id: "session-model", providerID: "provider" } })),
      ),
      switchAgent: () => Ref.update(order, (values) => [...values, "agent"]),
      switchModel: ({ model }) => Ref.update(order, (values) => [...values, "model"]).pipe(
        Effect.andThen(Ref.set(applied, model.id)),
      ),
    }
    const pairStore: StoreService = {
      ...store,
      getDirectoryModelFallback: () => Effect.succeed(Option.some({ id: "directory-model", providerID: "provider" })),
      getSessionAgentModel: (_sessionID, agentID) => Effect.succeed(
        agentID === "plan"
          ? Option.some({ id: "pair-model", providerID: "provider", variant: "high" })
          : Option.none(),
      ),
    }
    const api: TelegramApiClient = {
      ...telegram,
      answerCallbackQuery: () => Ref.update(order, (values) => [...values, "acknowledged"]).pipe(Effect.as(true)),
      editMessageText: (input) => Ref.update(order, (values) => [...values, "edited"]).pipe(
        Effect.andThen(Ref.update(edits, (values) => [...values, input.text])),
        Effect.as({ message_id: input.messageId, chat: { id: input.chatId } }),
      ),
    }

    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: selectableAgents(agents),
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      yield* handleAgentCallback(
        { id: "callback-agent-model", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 }, message_thread_id: 42 } },
        `agent:${token}:1`,
      ).pipe(
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, pairStore)),
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(await Effect.runPromise(Ref.get(applied))).toBe("pair-model")
    expect(await Effect.runPromise(Ref.get(order))).toEqual([
      "acknowledged",
      "session",
      "agent",
      "model",
      "edited",
    ])
    expect(await Effect.runPromise(Ref.get(edits))).toEqual([
      "Agent switched to Planner (plan). Model: provider/pair-model [high].",
    ])
  })

  test("uses the configured agent model when the pair has no preference", async () => {
    const configuredAgents = [
      agent("build", "Build"),
      agent("plan", "Planner", "primary", false, { id: "configured-model", providerID: "provider" }),
    ]
    const applied = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const client: OpenCodeService = {
      ...openCode,
      getSession: () => Effect.succeed(sessionInfo({ model: { id: "session-model", providerID: "provider" } })),
      switchModel: ({ model }) => Ref.set(applied, model.id),
    }
    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: selectableAgents(configuredAgents),
        chatId: 7,
      })
      yield* registry.attachMessageId(token, 10)
      yield* handleAgentCallback(
        { id: "callback-agent-config", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 } } },
        `agent:${token}:1`,
      ).pipe(
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(TelegramApi, {
          ...telegram,
          editMessageText: (input) => Effect.succeed({ message_id: input.messageId, chat: { id: input.chatId } }),
        })),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(await Effect.runPromise(Ref.get(applied))).toBe("configured-model")
  })

  test("keeps the session model when the selected agent has no pair or configured model", async () => {
    const applied = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const client: OpenCodeService = {
      ...openCode,
      getSession: () => Effect.succeed(sessionInfo({ model: { id: "session-model", providerID: "provider" } })),
      switchModel: ({ model }) => Ref.set(applied, model.id),
    }

    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: selectableAgents(agents),
        chatId: 7,
      })
      yield* registry.attachMessageId(token, 10)
      yield* handleAgentCallback(
        { id: "callback-agent-session-model", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 } } },
        `agent:${token}:1`,
      ).pipe(
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(TelegramApi, {
          ...telegram,
          editMessageText: (input) => Effect.succeed({ message_id: input.messageId, chat: { id: input.chatId } }),
        })),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(await Effect.runPromise(Ref.get(applied))).toBe("session-model")
  })

  test("reports partial success when the agent switches but its model does not", async () => {
    const switched = await Effect.runPromise(Ref.make(false))
    const edits = await Effect.runPromise(Ref.make<string[]>([]))
    const client: OpenCodeService = {
      ...openCode,
      getSession: () => Effect.succeed(sessionInfo()),
      switchAgent: () => Ref.set(switched, true),
      switchModel: () => Effect.fail(new OpenCodeError({
        operation: "switch model",
        cause: new Error("unavailable"),
      })),
    }
    const pairStore: StoreService = {
      ...store,
      getSessionAgentModel: () => Effect.succeed(
        Option.some({ id: "pair-model", providerID: "provider" }),
      ),
    }
    const api: TelegramApiClient = {
      ...telegram,
      editMessageText: (input) => Ref.update(edits, (values) => [...values, input.text]).pipe(
        Effect.as({ message_id: input.messageId, chat: { id: input.chatId } }),
      ),
    }

    await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: selectableAgents(agents),
        chatId: 7,
      })
      yield* registry.attachMessageId(token, 10)
      yield* handleAgentCallback(
        { id: "callback-agent-partial", from: { id: 7 }, message: { message_id: 10, chat: { id: 7 } } },
        `agent:${token}:1`,
      ).pipe(
        Effect.provide(Layer.succeed(OpenCode, client)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, pairStore)),
        Effect.provide(Layer.succeed(TelegramApi, api)),
        Effect.provide(FetchHttpClient.layer),
      )
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(SessionSelectionLive)))

    expect(await Effect.runPromise(Ref.get(switched))).toBe(true)
    expect(await Effect.runPromise(Ref.get(edits))).toEqual([
      "Agent switched to Planner (plan), but model provider/pair-model could not be applied.",
    ])
  })
})
