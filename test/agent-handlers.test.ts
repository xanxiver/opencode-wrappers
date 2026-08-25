import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import * as Agent from "@opencode-ai/schema/agent"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { AgentRegistry, Live as AgentRegistryLive } from "../src/telegram/agents.js"
import { TelegramDurableExecutor, type TelegramDurableExecutorService } from "../src/telegram/durable-executor.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { handleAgentCallback, promptWithAgent, resolveAgent, selectableAgents } from "../src/telegram/handlers/agent.js"

const agent = (id: string, name: string, mode: "primary" | "subagent" | "all" = "primary", hidden = false) =>
  Schema.decodeUnknownSync(Agent.Info)({ ...Agent.Info.default(Agent.ID.make(id)), name, mode, hidden })

const agents = [
  agent("build", "Build"),
  agent("plan", "Planner"),
  agent("explore", "Explore", "subagent"),
  agent("secret", "Secret", "primary", true),
]

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
  setSessionIDForConversation: () => Effect.void,
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
}

describe("Telegram agent handlers", () => {
  test("shows only visible primary or all-mode agents", () => {
    expect(selectableAgents(agents).map((candidate) => candidate.id)).toEqual(["build", "plan"])
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
    const client: OpenCodeService = {
      ...openCode,
      switchAgent: ({ agent: selected }) => Ref.set(switched, selected),
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
    }).pipe(Effect.provide(AgentRegistryLive)))

    expect(await Effect.runPromise(Ref.get(switched))).toBe("plan")
    expect(await Effect.runPromise(Ref.get(edits))).toEqual(["Agent switched to Planner (plan)."])
  })
})
