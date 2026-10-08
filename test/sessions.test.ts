import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../src/core/opencode.js"
import { Live as SessionsLive, Sessions } from "../src/core/sessions.js"
import { Live as StoreLive, Store, type StoredModel } from "../src/core/store.js"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSessionInfo } from "./opencode-fixtures.js"

const fakeInfo = (id: string) =>
  makeSessionInfo({
    id,
    projectID: "proj_test",
    location: { directory: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  })

const makeStoreLayer = () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode2-uis-sessions-"))
  const stateFile = join(dir, "state.json")
  const configLayer = Layer.succeed(
    AppConfigTag,
    new AppConfig({
      telegramBotToken: "test-token",
      projectDirectory: "/default-dir",
      stateFile,
      webDatabaseFile: `${stateFile}.sqlite`,
      telegramRunTimeout: "10 minutes",
      webPort: 3001,
    }),
  )
  const storeLayer = Layer.provide(StoreLive, Layer.merge(configLayer, BunFileSystem.layer))
  return { storeLayer, configLayer, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface OpenCodeLayerOptions {
  readonly switches?: Ref.Ref<readonly StoredModel[]>
  readonly failSwitch?: boolean
}

const makeOpenCodeLayer = (callCount: Ref.Ref<number>, options: OpenCodeLayerOptions = {}) =>
  Layer.succeed(OpenCode, {
    createSession: (directory: string) =>
      Ref.update(callCount, (n) => n + 1).pipe(
        Effect.andThen(Effect.succeed(fakeInfo(`ses_${directory.replace(/\W/g, "_")}`))),
      ),
    getSession: () => Effect.succeed(fakeInfo("ses_test")),
    prompt: () => Effect.never,
    listPending: () => Effect.succeed([]),
    cancelPending: () => Effect.void,
    interrupt: () => Effect.never,
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
    replyPermission: () => Effect.never,
     listModels: () => Effect.never,
     listAgents: () => Effect.succeed([]),
     switchAgent: () => Effect.never,
     switchModel: ({ model }) => {
       if (options.failSwitch === true) {
         return Effect.fail(new OpenCodeError({ operation: "switch model", cause: new Error("unavailable") }))
       }
       if (options.switches === undefined) return Effect.never
       return Ref.update(options.switches, (values) => [...values, model])
     },
    replyQuestion: () => Effect.never,
    events: () => Stream.never,
  })

const sessionsLayer = (
  callCount: Ref.Ref<number>,
  storeLayer: ReturnType<typeof makeStoreLayer>["storeLayer"],
  configLayer: ReturnType<typeof makeStoreLayer>["configLayer"],
) =>
  Layer.provide(
    SessionsLive,
    Layer.merge(makeOpenCodeLayer(callCount), Layer.merge(storeLayer, configLayer)),
  )

/** Sessions, Store, OpenCode, and AppConfig together so tests can seed defaults. */
const sessionsWithStoreLayer = (
  callCount: Ref.Ref<number>,
  storeLayer: ReturnType<typeof makeStoreLayer>["storeLayer"],
  configLayer: ReturnType<typeof makeStoreLayer>["configLayer"],
  options: OpenCodeLayerOptions = {},
) =>
  Layer.provideMerge(
    SessionsLive,
    Layer.merge(makeOpenCodeLayer(callCount, options), Layer.merge(storeLayer, configLayer)),
  )

describe("Sessions", () => {
  test("getOrCreate creates a session in the default directory", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          const id = yield* sessions.getOrCreate("tg:1")
          const directory = yield* sessions.directoryFor("tg:1")
          const count = yield* Ref.get(callCount)
          return { id, directory, count }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.id).toBe("ses__default_dir")
      expect(result.directory).toBe("/default-dir")
      expect(result.count).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("conversations in the same directory have separate sessions", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          const first = yield* sessions.getOrCreate("tg:1")
          const second = yield* sessions.getOrCreate("tg:2")
          const count = yield* Ref.get(callCount)
          return { first, second, count }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.count).toBe(2)
    } finally {
      cleanup()
    }
  })

  test("the same forum topic reuses its session", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const sessions = yield* Sessions
        const first = yield* sessions.getOrCreate("tg:1:thread:42")
        const second = yield* sessions.getOrCreate("tg:1:thread:42")
        return { first, second, count: yield* Ref.get(callCount) }
      }).pipe(Effect.provide(layer)))
      expect(result.first).toBe(result.second)
      expect(result.count).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("a directory override creates a session in that directory", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          yield* sessions.setDirectory("tg:1", "/project-x")
          const id = yield* sessions.getOrCreate("tg:1")
          const directory = yield* sessions.directoryFor("tg:1")
          return { id, directory }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.id).toBe("ses__project_x")
      expect(result.directory).toBe("/project-x")
    } finally {
      cleanup()
    }
  })

  test("changing directories creates a session in the new directory", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          const first = yield* sessions.getOrCreate("tg:1")
          yield* sessions.setDirectory("tg:1", "/project-x")
          const second = yield* sessions.getOrCreate("tg:1")
          return { first, second, count: yield* Ref.get(callCount) }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.first).toBe("ses__default_dir")
      expect(result.second).toBe("ses__project_x")
      expect(result.count).toBe(2)
    } finally {
      cleanup()
    }
  })

  test("selecting the current directory keeps its active session", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          const first = yield* sessions.getOrCreate("tg:1")
          yield* sessions.setDirectory("tg:1", "/default-dir")
          const second = yield* sessions.getOrCreate("tg:1")
          return { first, second, count: yield* Ref.get(callCount) }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.second).toBe(result.first)
      expect(result.count).toBe(1)
    } finally {
      cleanup()
    }
  })

  test("reset removes the session for the chat directory", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsLayer(callCount, storeLayer, configLayer)
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Sessions
          yield* sessions.getOrCreate("tg:1")
          yield* sessions.reset("tg:1")
          const id = yield* sessions.getOrCreate("tg:1")
          const count = yield* Ref.get(callCount)
          return { id, count }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.count).toBe(2)
    } finally {
      cleanup()
    }
  })

  test("a new session applies the directory default model", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const switches = await Effect.runPromise(Ref.make<readonly StoredModel[]>([]))
    const layer = sessionsWithStoreLayer(callCount, storeLayer, configLayer, { switches })
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const store = yield* Store
        const sessions = yield* Sessions
        yield* store.setDirectoryModelFallback(
          "/default-dir",
          Option.some({ id: "default-model", providerID: "provider", variant: "high" }),
        )
        const id = yield* sessions.getOrCreate("tg:1")
        return { id, switches: yield* Ref.get(switches) }
      }).pipe(Effect.provide(layer)))
      expect(result.switches).toEqual([
        { id: "default-model", providerID: "provider", variant: "high" },
      ])
    } finally {
      cleanup()
    }
  })

  test("a new session without a default applies no model", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const switches = await Effect.runPromise(Ref.make<readonly StoredModel[]>([]))
    const layer = sessionsWithStoreLayer(callCount, storeLayer, configLayer, { switches })
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const sessions = yield* Sessions
        const id = yield* sessions.getOrCreate("tg:1")
        return { id, switches: yield* Ref.get(switches) }
      }).pipe(Effect.provide(layer)))
      expect(result.switches).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("a failed default model switch does not fail session creation", async () => {
    const { storeLayer, configLayer, cleanup } = makeStoreLayer()
    const callCount = await Effect.runPromise(Ref.make(0))
    const layer = sessionsWithStoreLayer(callCount, storeLayer, configLayer, { failSwitch: true })
    try {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const store = yield* Store
        const sessions = yield* Sessions
        yield* store.setDirectoryModelFallback(
          "/default-dir",
          Option.some({ id: "default-model", providerID: "provider" }),
        )
        return yield* sessions.getOrCreate("tg:1")
      }).pipe(Effect.provide(layer)))
      expect(result).toBe("ses__default_dir")
    } finally {
      cleanup()
    }
  })
})
