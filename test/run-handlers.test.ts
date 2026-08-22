import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Session } from "@opencode-ai/client/effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { setSessionById } from "../src/telegram/handlers/run.js"

const session = Schema.decodeUnknownSync(Session.Info)({
  id: "ses_other",
  projectID: "project-other",
  location: { directory: "/other-project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const sessions: SessionsService = {
  getOrCreate: () => Effect.succeed("ses_current"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed("/current-project"),
  setDirectory: () => Effect.void,
}

const openCode: OpenCodeService = {
  createSession: () => Effect.never,
  getSession: () => Effect.succeed(session),
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

const store = (selected: Ref.Ref<string | undefined>): StoreService => ({
  getSessionIDForConversation: () => Effect.succeed(Option.none()),
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

describe("Telegram run handlers", () => {
  test("rejects a session ID from another directory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const selected = yield* Ref.make<string | undefined>(undefined)
      const messages = yield* Ref.make<string[]>([])
      const telegram: TelegramApiClient = {
        getUpdates: () => Effect.never,
        sendMessage: ({ text }) => Ref.update(messages, (values) => [...values, text]).pipe(
          Effect.as({ message_id: 1, chat: { id: 7 } }),
        ),
        sendPhoto: () => Effect.never,
        sendVideo: () => Effect.never,
        sendDocument: () => Effect.never,
        editMessageText: () => Effect.never,
        answerCallbackQuery: () => Effect.succeed(true),
        getFile: () => Effect.never,
        downloadFile: () => Effect.never,
      }

      yield* setSessionById(7, "ses_other", 42).pipe(
        Effect.provide(Layer.succeed(OpenCode, openCode)),
        Effect.provide(Layer.succeed(Sessions, sessions)),
        Effect.provide(Layer.succeed(Store, store(selected))),
        Effect.provide(Layer.succeed(TelegramApi, telegram)),
        Effect.provide(FetchHttpClient.layer),
      )

      return {
        selected: yield* Ref.get(selected),
        messages: yield* Ref.get(messages),
      }
    }))

    expect(result.selected).toBeUndefined()
    expect(result.messages).toEqual(["That session belongs to another directory."])
  })
})
