import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenCode, type OpenCodeService } from "../src/core/opencode.js"
import { Sessions, type SessionsService } from "../src/core/sessions.js"
import { Store, type StoreService, type StoredModel } from "../src/core/store.js"
import { TelegramApi, type TelegramApiClient } from "../src/telegram/api.js"
import { Live as AgentTemplatesLive, AgentTemplates } from "../src/telegram/agent-templates.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"
import { Live as SessionSelectionLive } from "../src/telegram/session-selection.js"
import { handleAgentModel } from "../src/telegram/handlers/agent-model.js"
import {
  addAgentTemplatePairing,
  removeAgentTemplate,
  replaceAgentTemplatePairing,
  showAgentTemplates,
  useAgentTemplate,
} from "../src/telegram/handlers/agent-templates.js"
import { makeAgentInfo, makeModelInfo, makeSessionInfo } from "./opencode-fixtures.js"

const agents = [
  makeAgentInfo({ id: "build", name: "Build", mode: "primary" }),
  makeAgentInfo({ id: "plan", name: "Planner", mode: "primary", model: { id: "cfg-model", providerID: "cfg-prov" } }),
]

const models = [
  { ...makeModelInfo("p1", "m1"), variants: [{ id: "high" }, { id: "low" }] },
  makeModelInfo("p2", "m2"),
]

const sessions: SessionsService = {
  getOrCreate: () => Effect.succeed("ses_1"),
  reset: () => Effect.void,
  directoryFor: () => Effect.succeed("/work"),
  setDirectory: () => Effect.void,
}

const memoryStore = (
  pairings: Ref.Ref<Record<string, Record<string, StoredModel>>>,
): StoreService => ({
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
  getSessionAgentModel: (sessionID, agentID) =>
    Ref.get(pairings).pipe(Effect.map((state) => Option.fromNullishOr(state[sessionID]?.[agentID]))),
  setSessionAgentModel: (sessionID, agentID, model) =>
    Ref.update(pairings, (state) => ({ ...state, [sessionID]: { ...state[sessionID], [agentID]: model } })),
  getLoosePrompts: () => Effect.succeed(false),
  setLoosePrompts: () => Effect.void,
  getAutoContinue: () => Effect.succeed(false),
  setAutoContinue: () => Effect.void,
  getStreamVerbosity: () => Effect.succeed("normal"),
  setStreamVerbosity: () => Effect.void,
  listClients: () => Effect.succeed([]),
  listDirectories: () => Effect.succeed([]),
})

const telegramClient = (sent: Ref.Ref<Array<string>>): TelegramApiClient => ({
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
})

const openCodeFor = (input: {
  readonly agent?: string
  readonly switchedAgent: Ref.Ref<unknown>
  readonly switchedModel: Ref.Ref<unknown>
}): OpenCodeService => ({
  createSession: () => Effect.never,
  getSession: () =>
    Effect.succeed(makeSessionInfo({
      id: "ses_1",
      projectID: "project",
      location: { directory: "/work" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      agent: input.agent,
    })),
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
  listModels: () => Effect.succeed(models),
  listAgents: () => Effect.succeed(agents),
  switchAgent: ({ agent }) => Ref.set(input.switchedAgent, agent),
  switchModel: ({ model }) => Ref.set(input.switchedModel, model),
  replyQuestion: () => Effect.void,
  events: () => Stream.never,
})

const baseLayers = (
  store: StoreService,
  client: OpenCodeService,
  telegram: TelegramApiClient,
) => [
  Layer.succeed(Sessions, sessions),
  Layer.succeed(Store, store),
  Layer.succeed(OpenCode, client),
  Layer.succeed(TelegramApi, telegram),
] as const

describe("agent model pairings", () => {
  test("shows the stored pairing for the current agent", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({
      ses_1: { build: { id: "m1", providerID: "p1", variant: "high" } },
    }))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(handleAgentModel(7, "", 42).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
    ))
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Pairing for build in this session: p1/m1 [high] (stored).",
    ])
  })

  test("shows the agent default when no pairing is stored", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "plan", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(handleAgentModel(7, "plan", 42).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
    ))
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Pairing for plan in this session: cfg-prov/cfg-model (agent default).",
    ])
  })

  test("switches the agent and remembers the model with its variant", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(handleAgentModel(7, "plan p1/m1 [high]", 42).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
    ))
    expect(await Effect.runPromise(Ref.get(switchedAgent))).toBe("plan")
    expect(await Effect.runPromise(Ref.get(switchedModel))).toEqual({ id: "m1", providerID: "p1", variant: "high" })
    expect(await Effect.runPromise(Ref.get(pairings))).toEqual({
      ses_1: { plan: { id: "m1", providerID: "p1", variant: "high" } },
    })
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Agent switched to Planner (plan). Model for plan switched to p1/m1 [high].",
    ])
  })

  test("rejects an unknown agent without switching", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(handleAgentModel(7, "nope p1/m1", 42).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
    ))
    expect(await Effect.runPromise(Ref.get(switchedAgent))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(switchedModel))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(sent))).toEqual(["Agent not found or ambiguous: nope"])
  })

  test("rejects an unknown variant with the available list", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(handleAgentModel(7, "build p1/m1 [ultra]", 42).pipe(
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
    ))
    expect(await Effect.runPromise(Ref.get(switchedModel))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      'Unknown variant "ultra" for p1/m1. Available: high, low',
    ])
  })
})

describe("agent model templates", () => {
  test("adds a pairing and shows the template", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(Effect.gen(function* () {
      yield* addAgentTemplatePairing(7, "work build p1/m1 [high]", 42)
      yield* showAgentTemplates(7, "work", 42)
    }).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Created template work with pairing build: p1/m1 [high].",
      "Template work (1 pairing):\n- build: p1/m1 [high]",
    ])
  })

  test("rejects a duplicate pairing and replaces it on request", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "m1", providerID: "p1" } })
      yield* addAgentTemplatePairing(7, "work build p2/m2", 42)
      yield* replaceAgentTemplatePairing(7, "work build p2/m2", 42)
      yield* showAgentTemplates(7, "work", 42)
    }).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Template work already has a pairing for build. Use /agent_template_replace to change it.",
      "Replaced pairing build: p2/m2 in template work.",
      "Template work (1 pairing):\n- build: p2/m2",
    ])
  })

  test("removes the template after its last pairing is removed", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "m1", providerID: "p1" } })
      yield* removeAgentTemplate(7, "work build", 42)
      yield* showAgentTemplates(7, "", 42)
    }).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Removed pairing build from template work. Template work is now empty and was removed.",
      "No agent templates are stored.",
    ])
  })

  test("applies a template to the session and switches the active model", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "m1", providerID: "p1", variant: "high" } })
      yield* templates.add({ template: "work", agentID: "plan", model: { id: "m2", providerID: "p2" } })
      yield* useAgentTemplate(7, "work", 42)
    }).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(pairings))).toEqual({
      ses_1: {
        build: { id: "m1", providerID: "p1", variant: "high" },
        plan: { id: "m2", providerID: "p2" },
      },
    })
    expect(await Effect.runPromise(Ref.get(switchedModel))).toEqual({ id: "m1", providerID: "p1", variant: "high" })
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Template work applied to this session: 2 pairings stored (build, plan). Active model switched to p1/m1 [high].",
    ])
  })

  test("reports an unknown template on use", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(useAgentTemplate(7, "nope", 42).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(switchedModel))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Template not found: nope. Use /agent_templates to list templates.",
    ])
  })

  test("skips pairings with unknown models on use", async () => {
    const sent = await Effect.runPromise(Ref.make<Array<string>>([]))
    const pairings = await Effect.runPromise(Ref.make<Record<string, Record<string, StoredModel>>>({}))
    const switchedAgent = await Effect.runPromise(Ref.make<unknown>(undefined))
    const switchedModel = await Effect.runPromise(Ref.make<unknown>(undefined))
    const [sessionsLayer, storeLayer, openCodeLayer, telegramLayer] = baseLayers(
      memoryStore(pairings),
      openCodeFor({ agent: "build", switchedAgent, switchedModel }),
      telegramClient(sent),
    )
    await Effect.runPromise(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "gone", providerID: "p9" } })
      yield* useAgentTemplate(7, "work", 42)
    }).pipe(
      Effect.provide(AgentTemplatesLive),
      Effect.provide(SessionSelectionLive),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(sessionsLayer),
      Effect.provide(storeLayer),
      Effect.provide(openCodeLayer),
      Effect.provide(telegramLayer),
      Effect.provide(InteractionStoreMemory),
    ))
    expect(await Effect.runPromise(Ref.get(pairings))).toEqual({})
    expect(await Effect.runPromise(Ref.get(switchedModel))).toBeUndefined()
    expect(await Effect.runPromise(Ref.get(sent))).toEqual([
      "Template work has no applicable pairings in this directory. Skipped: build (unknown model).",
    ])
  })
})
