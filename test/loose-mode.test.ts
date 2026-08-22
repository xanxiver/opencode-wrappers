import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { GitChanges, type GitChangesService } from "../src/core/git-changes.js"
import type { Message, TelegramApiClient } from "../src/telegram/api.js"
import { TelegramApi } from "../src/telegram/api.js"
import { Live as AgentRegistryLive } from "../src/telegram/agents.js"
import {
  TelegramDurableExecutor,
  type TelegramDurableExecutorService,
} from "../src/telegram/durable-executor.js"
import { handleMessage } from "../src/telegram/handlers/message.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"
import { Live as ModelRegistryLive } from "../src/telegram/models.js"
import { Live as PermissionRegistryLive } from "../src/telegram/permissions.js"
import { Live as PickersLive } from "../src/telegram/pickers.js"
import { Live as QuestionRegistryLive } from "../src/telegram/questions.js"

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
      getLoosePrompts: () => Ref.get(loose),
      setLoosePrompts: (_conversation, enabled) => Ref.set(loose, enabled),
      getAutoContinue: () => Effect.succeed(false),
      setAutoContinue: () => Effect.void,
      listClients: () => Effect.succeed([]),
      listDirectories: () => Effect.succeed([]),
    }
    const executor: TelegramDurableExecutorService = {
      submit: (_chatId, _message, text) => Ref.set(submitted, text),
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

    // Unknown slash commands are never treated as prompts.
    await run("/nope")
    expect(await Effect.runPromise(Ref.get(submitted))).toBe("hello world")
    expect(await Effect.runPromise(Ref.get(sent))).toContain("Use /prompt to run a task.")
  })
})
