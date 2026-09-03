import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService } from "../src/core/store.js"
import { GitChanges, type GitChangesService } from "../src/core/git-changes.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { TelegramDurableExecutor, type TelegramDurableExecutorService } from "../src/telegram/durable-executor.js"
import { renderStatusMessage, resetSession, runWithFiles, setSessionById, showStatus } from "../src/telegram/handlers/run.js"
import { makeAgentInfo, makeSessionInfo } from "./opencode-fixtures.js"

const session = makeSessionInfo({
  id: "ses_other",
  projectID: "project-other",
  location: { directory: "/other-project" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const activeSession = makeSessionInfo({
  id: "ses_topic",
  projectID: "project-topic",
  location: { directory: "/topic-project" },
  agent: "build",
  model: { id: "session-model", providerID: "provider" },
  cost: 0,
  tokens: { input: 42, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})

const statusAgent = (
  id: string,
  name: string,
  mode: "primary" | "subagent" | "all" = "primary",
  hidden = false,
  model?: { readonly id: string; readonly providerID: string; readonly variant?: string },
) => {
  return makeAgentInfo({ id, name, mode, hidden, model })
}

const statusAgents = [
  statusAgent("build", "Build"),
  statusAgent("plan", "Planner", "primary", false, { id: "plan-config", providerID: "provider" }),
  statusAgent("explore", "Explore", "subagent"),
  statusAgent("secret", "Secret", "primary", true),
]

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

const executor = (reset: "reset" | "blocked"): TelegramDurableExecutorService => ({
  submit: () => Effect.void,
  resetConversation: () => Effect.succeed(reset),
  reconnect: () => Effect.void,
  listReviews: () => Effect.void,
  resolveReview: () => Effect.void,
  listQueue: () => Effect.void,
  moveQueue: () => Effect.void,
  clearQueue: () => Effect.void,
  deleteQueue: () => Effect.void,
})

describe("Telegram run handlers", () => {
  test("renders status as labeled groups", () => {
    expect(renderStatusMessage({
      directoryLine: "Directory: /project",
      gitLine: "Git: main @ abc123",
      sessionLine: "Session: Test session (ses_1)",
      contextLine: "Context: 42 input tokens",
      runLine: "Run: active",
      agentModels: [
        { name: "Build", id: "build", model: "provider/build-model", active: false },
        { name: "Planner", id: "plan", model: "provider/plan-model", active: true },
      ],
      verbosityLine: "Stream verbosity: detailed",
      looseLine: "Loose prompts: on",
      autoContinueLine: "Auto-continue: off",
    })).toBe([
      "<b>OpenCode status</b>",
      "",
      "<b>Workspace</b>",
      "<blockquote><b>Directory:</b> <code>/project</code>",
      "<b>Git:</b> <code>main @ abc123</code></blockquote>",
      "",
      "<b>Session</b>",
      "<blockquote><b>Session:</b> Test session (ses_1)",
      "<b>Context:</b> 42 input tokens",
      "<b>Run:</b> <code>active</code></blockquote>",
      "",
      "<b>Agent models</b>",
      "<blockquote><b>Build</b> (<code>build</code>)",
      "<code>provider/build-model</code>",
      "",
      "<b>Planner</b> (<code>plan</code>) <b>[ACTIVE]</b>",
      "<code>provider/plan-model</code></blockquote>",
      "",
      "<b>Automation</b>",
      "<blockquote><b>Stream verbosity:</b> <code>detailed</code>",
      "<b>Loose prompts:</b> <code>on</code>",
      "<b>Auto-continue:</b> <code>off</code></blockquote>",
    ].join("\n"))
  })

  test("escapes dynamic status values before Telegram parses the HTML", () => {
    const message = renderStatusMessage({
      directoryLine: "Directory: /work/<unsafe>&'\"",
      sessionLine: "Session: <script>alert('x')</script>",
      contextLine: "Context: none",
      runLine: "Run: idle",
      agentModels: [{
        name: "Build <unsafe>",
        id: "build&review",
        model: "provider/<model>",
        active: true,
      }],
      verbosityLine: "Stream verbosity: normal",
      looseLine: "Loose prompts: off",
      autoContinueLine: "Auto-continue: off",
    })

    expect(message).toContain("/work/&lt;unsafe&gt;&amp;&#39;&quot;")
    expect(message).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;")
    expect(message).toContain("Build &lt;unsafe&gt;")
    expect(message).toContain("build&amp;review")
    expect(message).not.toContain("<script>")
  })

  test("renders delivery assignment and pool health without exposing credentials", () => {
    const message = renderStatusMessage({
      directoryLine: "Directory: /project",
      sessionLine: "Session: ses_1",
      contextLine: "Context: none",
      runLine: "Run: idle",
      agentModels: [],
      verbosityLine: "Stream verbosity: normal",
      looseLine: "Loose prompts: off",
      autoContinueLine: "Auto-continue: off",
      deliveryLine: "Delivery bot: @worker_1_bot (delivery-1) [legacy]",
      poolLine: "Delivery pool: 2/3 available",
      deliveryWarning: "Warning: the assigned delivery bot is unavailable.",
    })

    expect(message).toContain("<b>Telegram delivery</b>")
    expect(message).toContain("@worker_1_bot (delivery-1) [legacy]")
    expect(message).toContain("2/3 available")
    expect(message).toContain("assigned delivery bot is unavailable")
    expect(message).not.toContain("token")
  })

  test("reports when a prompt cannot resolve its durable run snapshot", async () => {
    const sent = await Effect.runPromise(Ref.make<Parameters<TelegramApiClient["sendMessage"]>[0] | undefined>(undefined))
    const unavailableExecutor: TelegramDurableExecutorService = {
      ...executor("reset"),
      submit: () => Effect.fail(new OpenCodeError({
        operation: "get session",
        cause: new Error("unavailable"),
      })),
    }
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.set(sent, input).pipe(Effect.as({ message_id: 1, chat: { id: input.chatId } })),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(runWithFiles(
      -100,
      { message_id: 10, chat: { id: -100 }, message_thread_id: 42 },
      "test prompt",
    ).pipe(
      Effect.provide(Layer.succeed(TelegramDurableExecutor, unavailableExecutor)),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
    ))

    const message = await Effect.runPromise(Ref.get(sent))
    expect(message?.parseMode).toBeUndefined()
    expect(message?.messageThreadId).toBe(42)
    expect(message?.text).toContain("prompt was not accepted")
  })

  test("keeps /new on the current session while durable work is executable", async () => {
    const sent = await Effect.runPromise(Ref.make<Parameters<TelegramApiClient["sendMessage"]>[0] | undefined>(undefined))
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.set(sent, input).pipe(Effect.as({ message_id: 1, chat: { id: input.chatId } })),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(resetSession(-100, 42).pipe(
      Effect.provide(Layer.succeed(TelegramDurableExecutor, executor("blocked"))),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
    ))

    const message = await Effect.runPromise(Ref.get(sent))
    expect(message?.messageThreadId).toBe(42)
    expect(message?.text).toContain("running or queued tasks")
    expect(message?.text).toContain("/queue_clear")
  })

  test("shows status for the exact forum topic and replies into that topic", async () => {
    const selected = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const conversations = await Effect.runPromise(Ref.make<readonly string[]>([]))
    const sent = await Effect.runPromise(Ref.make<Parameters<TelegramApiClient["sendMessage"]>[0] | undefined>(undefined))
    const topicStore: StoreService = {
      ...store(selected),
      getSessionIDForConversation: (conversation) => Ref.update(conversations, (values) => [...values, conversation]).pipe(
        Effect.as(Option.some("ses_topic")),
      ),
      getDirectoryModelFallback: () => Effect.succeed(
        Option.some({ id: "directory-model", providerID: "provider" }),
      ),
      getSessionAgentModel: (sessionID, agentID) => Effect.succeed(
        sessionID === "ses_topic" && agentID === "build"
          ? Option.some({ id: "pair-model", providerID: "provider", variant: "high" })
          : Option.none(),
      ),
      getLoosePrompts: (conversation) => Ref.update(conversations, (values) => [...values, conversation]).pipe(Effect.as(true)),
      getAutoContinue: (conversation) => Ref.update(conversations, (values) => [...values, conversation]).pipe(Effect.as(true)),
      getStreamVerbosity: (conversation) => Ref.update(conversations, (values) => [...values, conversation]).pipe(Effect.as("detailed" as const)),
    }
    const topicSessions: SessionsService = {
      ...sessions,
      directoryFor: (conversation) => Ref.update(conversations, (values) => [...values, conversation]).pipe(
        Effect.as("/topic-project"),
      ),
    }
    const topicOpenCode: OpenCodeService = {
      ...openCode,
      getSession: () => Effect.succeed(activeSession),
      activeSessions: () => Effect.succeed(["ses_topic"]),
      listAgents: () => Effect.succeed(statusAgents),
    }
    const gitChanges: GitChangesService = {
      summarize: () => Effect.succeed({ kind: "none" }),
    }
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.set(sent, input).pipe(Effect.as({ message_id: 1, chat: { id: input.chatId } })),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(showStatus(-100, 42).pipe(
      Effect.provide(Layer.succeed(OpenCode, topicOpenCode)),
      Effect.provide(Layer.succeed(Sessions, topicSessions)),
      Effect.provide(Layer.succeed(Store, topicStore)),
      Effect.provide(Layer.succeed(GitChanges, gitChanges)),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
    ))

    expect(await Effect.runPromise(Ref.get(conversations))).toEqual([
      "tg:-100:thread:42",
      "tg:-100:thread:42",
      "tg:-100:thread:42",
      "tg:-100:thread:42",
      "tg:-100:thread:42",
    ])
    const message = await Effect.runPromise(Ref.get(sent))
    expect(message?.messageThreadId).toBe(42)
    expect(message?.parseMode).toBe("HTML")
    expect(message?.text).toContain("<b>Directory:</b> <code>/topic-project</code>")
    expect(message?.text).not.toContain("<b>Active selection</b>")
    expect(message?.text).toContain("<b>Agent models</b>")
    expect(message?.text).toContain("<b>Build</b> (<code>build</code>) <b>[ACTIVE]</b>\n<code>provider/pair-model [high]</code>")
    expect(message?.text).toContain("<b>Planner</b> (<code>plan</code>)\n<code>provider/plan-config</code>")
    expect(message?.text).not.toContain("Explore")
    expect(message?.text).not.toContain("Secret")
    expect(message?.text).not.toContain("session-model")
    expect(message?.text).not.toContain("directory-model")
    expect(message?.text).toContain("<b>Run:</b> <code>active</code>")
    expect(message?.text).toContain("<b>Loose prompts:</b> <code>on</code>")
    expect(message?.text).toContain("<b>Auto-continue:</b> <code>on</code>")
    expect(message?.text).toContain("<b>Stream verbosity:</b> <code>detailed</code>")
  })

  test("shows agent models as unavailable when agent definitions cannot load", async () => {
    const selected = await Effect.runPromise(Ref.make<string | undefined>(undefined))
    const sent = await Effect.runPromise(Ref.make<Parameters<TelegramApiClient["sendMessage"]>[0] | undefined>(undefined))
    const topicStore: StoreService = {
      ...store(selected),
      getSessionIDForConversation: () => Effect.succeed(Option.some("ses_topic")),
      getDirectoryModelFallback: () => Effect.succeed(
        Option.some({ id: "directory-model", providerID: "provider" }),
      ),
      getSessionAgentModel: () => Effect.succeed(Option.none()),
    }
    const topicSessions: SessionsService = {
      ...sessions,
      directoryFor: () => Effect.succeed("/topic-project"),
    }
    const topicOpenCode: OpenCodeService = {
      ...openCode,
      getSession: () => Effect.succeed(activeSession),
      listAgents: () => Effect.fail(new OpenCodeError({
        operation: "list agents",
        cause: new Error("unavailable"),
      })),
    }
    const telegram: TelegramApiClient = {
      getUpdates: () => Effect.never,
      sendMessage: (input) => Ref.set(sent, input).pipe(Effect.as({ message_id: 1, chat: { id: input.chatId } })),
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    }

    await Effect.runPromise(showStatus(-100, 42).pipe(
      Effect.provide(Layer.succeed(OpenCode, topicOpenCode)),
      Effect.provide(Layer.succeed(Sessions, topicSessions)),
      Effect.provide(Layer.succeed(Store, topicStore)),
      Effect.provide(Layer.succeed(GitChanges, { summarize: () => Effect.succeed({ kind: "none" }) })),
      Effect.provide(Layer.succeed(TelegramApi, telegram)),
      Effect.provide(FetchHttpClient.layer),
    ))

    const message = await Effect.runPromise(Ref.get(sent))
    expect(message?.parseMode).toBe("HTML")
    expect(message?.text).not.toContain("<b>Active selection</b>")
    expect(message?.text).toContain("<b>Agent models</b>\n<blockquote><i>Unavailable</i></blockquote>")
    expect(message?.text).not.toContain("session-model")
    expect(message?.text).not.toContain("directory-model")
  })

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
