import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { GitChanges, type GitChangesService } from "../src/core/git-changes.js"
import type { StreamVerbosity } from "../src/core/stream-verbosity.js"
import type { Message, TelegramApiClient } from "../src/telegram/api.js"
import { TelegramApi } from "../src/telegram/api.js"
import { Live as AgentRegistryLive } from "../src/telegram/agents.js"
import { Live as SessionSelectionLive } from "../src/telegram/session-selection.js"
import {
  TelegramDurableExecutor,
  type TelegramDurableExecutorService,
} from "../src/telegram/durable-executor.js"
import { handleMessage } from "../src/telegram/handlers/message.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"
import { Live as ModelRegistryLive } from "../src/telegram/models.js"
import { Live as PermissionRegistryLive } from "../src/telegram/permissions.js"
import { Live as PickersLive } from "../src/telegram/pickers.js"
import { Live as QuestionRegistryLive, QuestionRegistry } from "../src/telegram/questions.js"

const openCode: OpenCodeService = {
  createSession: () => Effect.never,
  getSession: () => Effect.fail(new OpenCodeError({ operation: "session.get", cause: "test stub" })),
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

const sessions: SessionsService = {
  getOrCreate: () => Effect.succeed("ses_1"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed("/work"),
  setDirectory: () => Effect.void,
}

const gitChangesStub: GitChangesService = {
  summarize: () => Effect.succeed({ kind: "none" }),
}

const telegram = (sent: Ref.Ref<readonly string[]>): TelegramApiClient => ({
  getUpdates: () => Effect.never,
  sendMessage: ({ text }) => Ref.update(sent, (values) => [...values, text]).pipe(
    Effect.as({ message_id: 99, chat: { id: 7 } }),
  ),
  sendPhoto: () => Effect.never,
  sendVideo: () => Effect.never,
  sendDocument: () => Effect.never,
  editMessageText: () => Effect.never,
  answerCallbackQuery: () => Effect.succeed(true),
  getFile: () => Effect.never,
  downloadFile: () => Effect.never,
})

describe("loose prompt mode", () => {
  test("ignores plain text while off, submits it when on, and keeps slash commands first", async () => {
    const submitted = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const sent = await Effect.runPromise(Ref.make<readonly string[]>([]))
    const loose = await Effect.runPromise(Ref.make(false))
    const verbosity = await Effect.runPromise(Ref.make<StreamVerbosity>("normal"))
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
      getLoosePrompts: () => Ref.get(loose),
      setLoosePrompts: (_conversation, enabled) => Ref.set(loose, enabled),
      getAutoContinue: () => Effect.succeed(false),
      setAutoContinue: () => Effect.void,
      getStreamVerbosity: () => Ref.get(verbosity),
      setStreamVerbosity: (_conversation, level) => Ref.set(verbosity, level),
      listClients: () => Effect.succeed([]),
      listDirectories: () => Effect.succeed([]),
    }
    const executor: TelegramDurableExecutorService = {
      submit: (_chatId, _message, text) => Ref.set(submitted, text),
      resetConversation: () => Effect.succeed("reset"),
      reconnect: () => Effect.void,
      listReviews: () => Effect.void,
      resolveReview: () => Effect.void,
      listQueue: () => Effect.void,
      moveQueue: () => Effect.void,
      clearQueue: () => Effect.void,
      deleteQueue: () => Effect.void,
    }
    const message = (text: string): Message => ({ message_id: 5, chat: { id: 7 }, text })
    const run = (text: string) =>
      handleMessage(message(text)).pipe(
        Effect.provide(Layer.succeed(TelegramDurableExecutor, executor)),
        Effect.provide(Layer.succeed(TelegramApi, telegram(sent))),
        Effect.provide(Layer.succeed(OpenCode, openCode)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, store)),
        Effect.provide(Layer.succeed(GitChanges, gitChangesStub)),
        Effect.provide(ModelRegistryLive),
        Effect.provide(PickersLive),
        Effect.provide(AgentRegistryLive),
        Effect.provide(SessionSelectionLive),
        Effect.provide(PermissionRegistryLive),
        Effect.provide(QuestionRegistryLive),
        Effect.provide(InteractionStoreMemory),
        Effect.provide(FetchHttpClient.layer),
        Effect.runPromise,
      )

    // Off: plain text is ignored silently.
    await run("hello world")
    expect(await Effect.runPromise(Ref.get(submitted))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([])

    // On: plain text becomes a run.
    await Effect.runPromise(Ref.set(loose, true))
    await run("hello world")
    expect(await Effect.runPromise(Ref.get(submitted))).toBe("hello world")

    // Slash commands still win over loose prompts.
    await run("/status")
    expect(await Effect.runPromise(Ref.get(submitted))).toBe("hello world")
    expect((await Effect.runPromise(Ref.get(sent))).length).toBeGreaterThan(0)

    // Verbosity is a command, not a prompt, and updates the stream setting.
    await run("/verbosity detailed")
    expect(await Effect.runPromise(Ref.get(verbosity))).toBe("detailed")
    expect(await Effect.runPromise(Ref.get(submitted))).toBe("hello world")
    expect(await Effect.runPromise(Ref.get(sent))).toContain(
      "Stream verbosity set to detailed. Response text, activity, and reasoning will stream.",
    )
    await run("/verbosity")
    expect(await Effect.runPromise(Ref.get(verbosity))).toBe("detailed")
    expect(await Effect.runPromise(Ref.get(sent))).toContain(
      "Stream verbosity is detailed. Use /verbosity quiet, /verbosity normal, or /verbosity detailed.",
    )

    // Unknown slash commands are never treated as prompts.
    await run("/nope")
    expect(await Effect.runPromise(Ref.get(submitted))).toBe("hello world")
    expect(await Effect.runPromise(Ref.get(sent))).toContain("Use /prompt to run a task.")
  })

  test("routes unambiguous topic text to a pending question instead of a new task", async () => {
    const submitted = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const sent = await Effect.runPromise(Ref.make<readonly string[]>([]))
    const questionCalls = await Effect.runPromise(Ref.make(0))
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
      getLoosePrompts: () => Effect.succeed(true),
      setLoosePrompts: () => Effect.void,
      getAutoContinue: () => Effect.succeed(false),
      setAutoContinue: () => Effect.void,
      getStreamVerbosity: () => Effect.succeed("normal"),
      setStreamVerbosity: () => Effect.void,
      listClients: () => Effect.succeed([]),
      listDirectories: () => Effect.succeed([]),
    }
    const executor: TelegramDurableExecutorService = {
      submit: (_chatId, _message, text) => Ref.set(submitted, text),
      resetConversation: () => Effect.succeed("reset"),
      reconnect: () => Effect.void,
      listReviews: () => Effect.void,
      resolveReview: () => Effect.void,
      listQueue: () => Effect.void,
      moveQueue: () => Effect.void,
      clearQueue: () => Effect.void,
      deleteQueue: () => Effect.void,
    }
    const client: OpenCodeService = {
      ...openCode,
      replyQuestion: () => Ref.update(questionCalls, (count) => count + 1),
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* QuestionRegistry
      yield* registry.setSessionRoute("ses_1", { chatId: 7, threadId: 42 })
      const token = yield* registry.register({
        sessionID: "ses_1",
        requestID: "que_topic",
        chatId: 7,
        questions: ["Explain?", "Continue?"],
        options: [[], ["Yes", "No"]],
        customs: [true, false],
        multiples: [false, false],
      })
      yield* registry.attachMessageId(token, 0, 10)
      yield* registry.attachMessageId(token, 1, 11)

      yield* handleMessage({ message_id: 5, chat: { id: 7 }, message_thread_id: 42, text: "question answer" })
      return yield* registry.get(token)
    }).pipe(
      Effect.provide(Layer.succeed(TelegramDurableExecutor, executor)),
      Effect.provide(Layer.succeed(TelegramApi, telegram(sent))),
      Effect.provide(Layer.succeed(OpenCode, client)),
      Effect.provide(Layer.succeed(Sessions, sessions)),
      Effect.provide(Layer.succeed(Store, store)),
      Effect.provide(Layer.succeed(GitChanges, gitChangesStub)),
      Effect.provide(ModelRegistryLive),
      Effect.provide(PickersLive),
      Effect.provide(AgentRegistryLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(PermissionRegistryLive),
      Effect.provide(QuestionRegistryLive),
      Effect.provide(InteractionStoreMemory),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(await Effect.runPromise(Ref.get(submitted))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(questionCalls))).toBe(0)
    expect(Option.map(result, (entry) => entry.answers)).toEqual(Option.some([
      ["question answer"],
      undefined,
    ]))
  })
})
