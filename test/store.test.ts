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

  test("model memory round-trips per directory", async () => {
    const stateFile = makeStateFile()
    try {
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const before = yield* store.getModel("/a")
          yield* store.setModel("/a", { id: "m1", providerID: "p1" })
          yield* store.setModel("/a", { id: "m2", providerID: "p2", variant: "v" })
          const after = yield* store.getModel("/a")
          const other = yield* store.getModel("/b")
          return { before, after, other }
        }),
        stateFile,
      )
      expect(value.before).toEqual(Option.none())
      expect(value.after).toEqual(Option.some({ id: "m2", providerID: "p2", variant: "v" }))
      expect(value.other).toEqual(Option.none())
    } finally {
      rmSync(stateFile, { force: true })
    }
  })

  test("a state file without the models field loads with no models", async () => {
    const stateFile = makeStateFile()
    try {
      const { writeFileSync } = await import("node:fs")
      writeFileSync(stateFile, JSON.stringify({ sessions: { "/a": "ses_1" }, directories: {} }))
      const value = await run(
        Effect.gen(function* () {
          const store = yield* Store
          const session = yield* store.getSessionIDForDirectory("/a")
          const model = yield* store.getModel("/a")
          return { session, model }
        }),
        stateFile,
      )
      expect(value.session).toEqual(Option.some("ses_1"))
      expect(value.model).toEqual(Option.none())
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
