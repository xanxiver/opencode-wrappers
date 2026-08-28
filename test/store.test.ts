import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { Live as StoreLive, Store } from "../src/core/store.js"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"

const BunFileSystemLayer = BunFileSystem.layer

const makeStateFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "opencode2-uis-store-"))
  return join(dir, "state.json")
}

const storeLayer = (stateFile: string) =>
  Layer.provide(
    StoreLive,
    Layer.merge(
      Layer.succeed(
        AppConfigTag,
        new AppConfig({
          telegramBotToken: "test-token",
          projectDirectory: "/tmp",
          stateFile,
          webDatabaseFile: `${stateFile}.sqlite`,
          telegramRunTimeout: "10 minutes",
          webPort: 3001,
        }),
      ),
      BunFileSystemLayer,
    ),
  )

const run = <A, E>(effect: Effect.Effect<A, E, Store>, stateFile: string) =>
  Effect.runPromise(effect.pipe(Effect.provide(storeLayer(stateFile))))

describe("Store", () => {
  test("malformed persisted JSON starts with an empty state instead of defecting", async () => {
    const stateFile = makeStateFile()
    writeFileSync(stateFile, "{not-json")
    try {
      const directory = await run(Effect.gen(function* () {
        const store = yield* Store
        return yield* store.getDirectory("tg:1")
      }), stateFile)
      expect(Option.isNone(directory)).toBe(true)
    } finally {
      rmSync(dirname(stateFile), { recursive: true, force: true })
    }
  })

  test("a failed write does not change the in-memory state", async () => {
    const unwritableStatePath = mkdtempSync(join(tmpdir(), "opencode2-uis-store-directory-"))
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const write = yield* Effect.exit(store.setDirectory("tg:1", "/project-x"))
          const directory = yield* store.getDirectory("tg:1")
          return { failed: Exit.isFailure(write), directory }
        }),
        unwritableStatePath,
      )
      expect(value.failed).toBe(true)
      expect(value.directory).toEqual(Option.none())
    } finally {
      rmSync(unwritableStatePath, { force: true, recursive: true })
    }
  })

  test("session ids are keyed by directory and shared", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForDirectory("/a", "ses_1")
          yield* store.setSessionIDForDirectory("/a", "ses_2")
          const first = yield* store.getSessionIDForDirectory("/a")
          const other = yield* store.getSessionIDForDirectory("/b")
          return { first, other }
        }),
        stateFile,
      )
      expect(value.first).toEqual(Option.some("ses_2"))
      expect(value.other).toEqual(Option.none())
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("remove deletes the session for a directory", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForDirectory("/a", "ses_1")
          yield* store.removeSessionIDForDirectory("/a")
          return yield* store.getSessionIDForDirectory("/a")
        }),
        stateFile,
      )
      expect(value).toEqual(Option.none())
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("chat directory overrides", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const before = yield* store.getDirectory("tg:1")
          expect(before).toEqual(Option.none())
          yield* store.setDirectory("tg:1", "/project-x")
          return yield* store.getDirectory("tg:1")
        }),
        stateFile,
      )
      expect(value).toEqual(Option.some("/project-x"))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("switches a conversation directory and clears its session atomically", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForConversation("tg:1", "ses_old")
          yield* store.switchConversationDirectory("tg:1", "/project-x")
          return {
            directory: yield* store.getDirectory("tg:1"),
            session: yield* store.getSessionIDForConversation("tg:1"),
          }
        }),
        stateFile,
      )
      expect(value.directory).toEqual(Option.some("/project-x"))
      expect(value.session).toEqual(Option.none())
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("lists every persisted conversation session for compatibility migration", async () => {
    const stateFile = makeStateFile()
    try {
      const entries = await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForConversation("tg:-100:thread:1", "ses_group")
          yield* store.setSessionIDForConversation("tg:7", "ses_private")
          return yield* store.listConversationSessions()
        }),
        stateFile,
      )
      expect(new Set(entries.map(({ conversationId, sessionID }) => `${conversationId}:${sessionID}`))).toEqual(new Set([
        "tg:-100:thread:1:ses_group",
        "tg:7:ses_private",
      ]))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("lists retained session directories after a client switches projects", async () => {
    const stateFile = makeStateFile()
    try {
      const directories = await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForDirectory("/old-project", "ses_old")
          yield* store.setDirectory("tg:1", "/new-project")
          return yield* store.listDirectories()
        }),
        stateFile,
      )
      expect(new Set(directories)).toEqual(new Set(["/old-project", "/new-project"]))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("model preferences are independent by session and agent", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const before = yield* store.getSessionAgentModel("ses_1", "build")
          yield* store.setSessionAgentModel("ses_1", "build", { id: "m1", providerID: "p1" })
          yield* store.setSessionAgentModel("ses_1", "plan", { id: "m2", providerID: "p2", variant: "v" })
          yield* store.setSessionAgentModel("ses_2", "build", { id: "m3", providerID: "p3" })
          return {
            before,
            sessionOneBuild: yield* store.getSessionAgentModel("ses_1", "build"),
            sessionOnePlan: yield* store.getSessionAgentModel("ses_1", "plan"),
            sessionTwoBuild: yield* store.getSessionAgentModel("ses_2", "build"),
          }
        }),
        stateFile,
      )
      expect(value.before).toEqual(Option.none())
      expect(value.sessionOneBuild).toEqual(Option.some({ id: "m1", providerID: "p1" }))
      expect(value.sessionOnePlan).toEqual(Option.some({ id: "m2", providerID: "p2", variant: "v" }))
      expect(value.sessionTwoBuild).toEqual(Option.some({ id: "m3", providerID: "p3" }))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("a session-agent model preference survives a store reload", async () => {
    const stateFile = makeStateFile()
    try {
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionAgentModel("ses_1", "build", {
            id: "persisted",
            providerID: "provider",
            variant: "high",
          })
        }),
        stateFile,
      )
      const model = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return yield* store.getSessionAgentModel("ses_1", "build")
        }),
        stateFile,
      )
      expect(model).toEqual(Option.some({ id: "persisted", providerID: "provider", variant: "high" }))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("old state loads its directory model as a fallback", async () => {
    const stateFile = makeStateFile()
    try {
      writeFileSync(stateFile, JSON.stringify({
        sessions: { "/a": "ses_1" },
        directories: {},
        models: { "/a": { id: "legacy", providerID: "provider" } },
      }))
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const session = yield* store.getSessionIDForDirectory("/a")
           const fallback = yield* store.getDirectoryModelFallback("/a")
           const pair = yield* store.getSessionAgentModel("ses_1", "build")
           const verbosity = yield* store.getStreamVerbosity("tg:1")
           return { session, fallback, pair, verbosity }
        }),
        stateFile,
      )
      expect(value.session).toEqual(Option.some("ses_1"))
       expect(value.fallback).toEqual(Option.some({ id: "legacy", providerID: "provider" }))
       expect(value.pair).toEqual(Option.none())
       expect(value.verbosity).toBe("normal")
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("loose prompt mode round-trips per conversation and persists", async () => {
    const stateFile = makeStateFile()
    try {
      const first = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const initial = yield* store.getLoosePrompts("tg:1:10")
          yield* store.setLoosePrompts("tg:1:10", true)
          yield* store.setLoosePrompts("tg:1:20", false)
          const enabled = yield* store.getLoosePrompts("tg:1:10")
          const disabled = yield* store.getLoosePrompts("tg:1:20")
          return { initial, enabled, disabled }
        }),
        stateFile,
      )
      expect(first.initial).toBe(false)
      expect(first.enabled).toBe(true)
      expect(first.disabled).toBe(false)

      const second = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return {
            enabled: yield* store.getLoosePrompts("tg:1:10"),
            disabled: yield* store.getLoosePrompts("tg:1:20"),
          }
        }),
        stateFile,
      )
      expect(second.enabled).toBe(true)
      expect(second.disabled).toBe(false)
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("auto continue mode round-trips per conversation and persists", async () => {
    const stateFile = makeStateFile()
    try {
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          expect(yield* store.getAutoContinue("tg:9")).toBe(false)
          yield* store.setAutoContinue("tg:9", true)
        }),
        stateFile,
      )

      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return yield* store.getAutoContinue("tg:9")
        }),
        stateFile,
      )
      expect(value).toBe(true)
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("stream verbosity is topic-scoped and survives a store reload", async () => {
    const stateFile = makeStateFile()
    try {
      const initial = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const defaultLevel = yield* store.getStreamVerbosity("tg:9:thread:1")
          yield* store.setStreamVerbosity("tg:9:thread:1", "quiet")
          yield* store.setStreamVerbosity("tg:9:thread:2", "detailed")
          return defaultLevel
        }),
        stateFile,
      )
      expect(initial).toBe("normal")

      const levels = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return {
            firstTopic: yield* store.getStreamVerbosity("tg:9:thread:1"),
            secondTopic: yield* store.getStreamVerbosity("tg:9:thread:2"),
            otherChat: yield* store.getStreamVerbosity("tg:10"),
          }
        }),
        stateFile,
      )
      expect(levels).toEqual({
        firstTopic: "quiet",
        secondTopic: "detailed",
        otherChat: "normal",
      })
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("state persists across store instances", async () => {
    const stateFile = makeStateFile()
    try {
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForDirectory("/a", "ses_persisted")
          yield* store.setDirectory("tg:1", "/a")
        }),
        stateFile,
      )
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const session = yield* store.getSessionIDForDirectory("/a")
          const directory = yield* store.getDirectory("tg:1")
          return { session, directory }
        }),
        stateFile,
      )
      expect(value.session).toEqual(Option.some("ses_persisted"))
      expect(value.directory).toEqual(Option.some("/a"))
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("missing state file starts empty", async () => {
    const stateFile = join(tmpdir(), `opencode2-uis-missing-${Date.now()}.json`)
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          return yield* store.getSessionIDForDirectory("/a")
        }),
        stateFile,
      )
      expect(value).toEqual(Option.none())
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("creates the state directory on first write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode2-uis-store-"))
    const nested = join(dir, "nested", "deeper")
    const stateFile = join(nested, "state.json")
    try {
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.setSessionIDForDirectory("/a", "ses_1")
        }),
        stateFile,
      )
      const { readFileSync, existsSync } = await import("node:fs")
      expect(existsSync(stateFile)).toBe(true)
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"))
      expect(parsed.sessions).toEqual({ "/a": "ses_1" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("legacy chat->session state migrates and keeps sessions", async () => {
    const stateFile = makeStateFile()
    try {
      const { writeFileSync } = await import("node:fs")
      writeFileSync(stateFile, JSON.stringify({ "tg:1": "ses_legacy", "tg:2": "ses_legacy_2" }))
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const session1 = yield* store.getSessionIDForDirectory("tg:1")
          const directory1 = yield* store.getDirectory("tg:1")
          const session2 = yield* store.getSessionIDForDirectory("tg:2")
          return { session1, directory1, session2 }
        }),
        stateFile,
      )
      expect(value.session1).toEqual(Option.some("ses_legacy"))
      expect(value.directory1).toEqual(Option.some("tg:1"))
      expect(value.session2).toEqual(Option.some("ses_legacy_2"))
      // migration rewrites the file in the new format
      const { readFileSync } = await import("node:fs")
      const rewritten = JSON.parse(readFileSync(stateFile, "utf8"))
      expect(rewritten.sessions).toEqual({ "tg:1": "ses_legacy", "tg:2": "ses_legacy_2" })
      expect(rewritten.directories).toEqual({ "tg:1": "tg:1", "tg:2": "tg:2" })
      expect(rewritten.models).toEqual({})
    } finally {
      rmSync(stateFile, { force: true })
    }
  })
})
