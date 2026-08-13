import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { InteractionStore, InteractionStoreLive } from "../src/telegram/interaction-store.js"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "telegram-interaction-store-"))
  directories.push(directory)
  const databaseFile = join(directory, "state.sqlite")
  const config = new AppConfig({
    telegramBotToken: "test-token",
    projectDirectory: directory,
    stateFile: join(directory, "state.json"),
    webDatabaseFile: databaseFile,
    telegramRunTimeout: "10 minutes",
    webPort: 3001,
  })
  const layer = InteractionStoreLive.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(AppConfigTag, config),
    BunFileSystem.layer,
    BunPath.layer,
  )))
  return { databaseFile, layer }
}

describe("InteractionStoreLive", () => {
  test("migrates storage and restores JSON state after restart", async () => {
    const { layer } = fixture()
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      yield* store.set("permission", { token: 1, answers: ["yes"] })
    }).pipe(Effect.provide(layer), Effect.scoped))

    const restored = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      return yield* store.get("permission")
    }).pipe(Effect.provide(layer), Effect.scoped))
    expect(restored).toEqual(Option.some({ token: 1, answers: ["yes"] }))
  })

  test("serializes concurrent writes without losing distinct keys", async () => {
    const { layer } = fixture()
    const values = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      yield* Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) =>
        store.set(`key-${index}`, { index }), { concurrency: "unbounded" })
      return yield* Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) => store.get(`key-${index}`))
    }).pipe(Effect.provide(layer), Effect.scoped))
    expect(values.every(Option.isSome)).toBe(true)
  })

  test("serializes writes from separate database connections", async () => {
    const { layer } = fixture()
    const write = (prefix: string) => Effect.gen(function* () {
      const store = yield* InteractionStore
      yield* Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) =>
        store.set(`${prefix}-${index}`, { index }), { concurrency: "unbounded" })
    }).pipe(Effect.provide(layer), Effect.scoped)
    await Effect.runPromise(Effect.all([write("first"), write("second")], { concurrency: "unbounded" }))

    const values = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      return yield* Effect.forEach(["first", "second"], (prefix) =>
        Effect.forEach(Array.from({ length: 20 }, (_, index) => index), (index) => store.get(`${prefix}-${index}`)))
    }).pipe(Effect.provide(layer), Effect.scoped))
    expect(values.flat().every(Option.isSome)).toBe(true)
  })

  test("atomically modifies one key from separate database connections", async () => {
    const { layer } = fixture()
    const increment = Effect.gen(function* () {
      const store = yield* InteractionStore
      yield* Effect.forEach(Array.from({ length: 20 }), () => store.modify("counter", (current) => {
        const value = Schema.decodeUnknownSync(Schema.Number)(Option.getOrElse(current, () => 0))
        return [undefined, value + 1]
      }))
    }).pipe(Effect.provide(layer), Effect.scoped)
    await Effect.runPromise(Effect.all([increment, increment], { concurrency: "unbounded" }))

    const value = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      return yield* store.get("counter")
    }).pipe(Effect.provide(layer), Effect.scoped))
    expect(value).toEqual(Option.some(40))
  })

  test("returns a typed failure for corrupted persisted JSON", async () => {
    const { databaseFile, layer } = fixture()
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      yield* store.set("corrupt", { valid: true })
    }).pipe(Effect.provide(layer), Effect.scoped))
    const database = new Database(databaseFile)
    database.query("UPDATE telegram_interaction_state SET value = ? WHERE key = ?").run("{", "corrupt")
    database.close()

    const exit = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InteractionStore
      return yield* store.get("corrupt")
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("InteractionStoreError")
  })
})
