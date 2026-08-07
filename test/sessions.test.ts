import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { OpenCode } from "../src/core/opencode.js"
import { Live as SessionsLive, Sessions } from "../src/core/sessions.js"
import { Live as StoreLive } from "../src/core/store.js"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { Session } from "@opencode-ai/client/effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fakeInfo = (id: string): Session.Info =>
  Schema.decodeUnknownSync(Session.Info)({
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
      telegramRunTimeout: "10 minutes",
    }),
  )
  const storeLayer = Layer.provide(StoreLive, Layer.merge(configLayer, BunFileSystem.layer))
  return { storeLayer, configLayer, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const makeOpenCodeLayer = (callCount: Ref.Ref<number>) =>
  Layer.succeed(OpenCode, {
    createSession: (directory: string) =>
      Ref.update(callCount, (n) => n + 1).pipe(
        Effect.andThen(Effect.succeed(fakeInfo(`ses_${directory.replace(/\W/g, "_")}`))),
      ),
    getSession: () => Effect.succeed(fakeInfo("ses_test")),
    prompt: () => Effect.never,
    interrupt: () => Effect.never,
    wait: () => Effect.void,
    activeSessions: () => Effect.succeed([]),
    compact: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    listProjects: () => Effect.succeed([]),
    listProjectDirectories: () => Effect.succeed([]),
    listPendingPermissions: () => Effect.succeed([]),
    listPendingQuestions: () => Effect.succeed([]),
    replyPermission: () => Effect.never,
    listModels: () => Effect.never,
    switchModel: () => Effect.never,
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

  test("chats in the same directory share the session", async () => {
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
})
