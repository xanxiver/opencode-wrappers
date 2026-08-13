import { Database } from "bun:sqlite"
import { Clock, Context, Data, Effect, FileSystem, Layer, Option, Path, Ref } from "effect"
import { AppConfigTag, type AppConfig } from "../config.js"

export class InteractionStoreError extends Data.TaggedError("InteractionStoreError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export type JsonValue = ReturnType<typeof JSON.parse>

export interface InteractionStateStore {
  readonly get: (key: string) => Effect.Effect<Option.Option<JsonValue>, InteractionStoreError>
  readonly set: (key: string, value: JsonValue) => Effect.Effect<void, InteractionStoreError>
  readonly modify: <A>(
    key: string,
    change: (current: Option.Option<JsonValue>) => readonly [A, JsonValue],
  ) => Effect.Effect<A, InteractionStoreError>
}

export class InteractionStore extends Context.Service<InteractionStore, InteractionStateStore>()(
  "opencode2-uis/TelegramInteractionStore",
) {}

export const InteractionStoreLive: Layer.Layer<
  InteractionStore,
  InteractionStoreError,
  AppConfig | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  InteractionStore,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const fail = (operation: string, cause: unknown) => new InteractionStoreError({ operation, cause })
    yield* fs.makeDirectory(paths.dirname(config.webDatabaseFile), { recursive: true }).pipe(
      Effect.mapError((cause) => fail("create interaction database directory", cause)),
    )
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(config.webDatabaseFile, { create: true }),
        catch: (cause) => fail("open interaction database", cause),
      }),
      (database) => Effect.sync(() => database.close()),
    )
    yield* Effect.try({
      try: () => {
        database.run("PRAGMA busy_timeout = 5000")
        database.run(`CREATE TABLE IF NOT EXISTS telegram_interaction_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`)
      },
      catch: (cause) => fail("migrate interaction database", cause),
    })
    yield* fs.chmod(config.webDatabaseFile, 0o600).pipe(
      Effect.mapError((cause) => fail("secure interaction database permissions", cause)),
    )
    return {
      get: (key) => Effect.try({
        try: () => {
          const row = database.query<{ readonly value: string }, [string]>(
            "SELECT value FROM telegram_interaction_state WHERE key = ?",
          ).get(key)
          if (row === null) return Option.none<JsonValue>()
          // SAFETY: JSON.parse returns a JSON-compatible value for values written by set.
          return Option.some(JSON.parse(row.value) as JsonValue)
        },
        catch: (cause) => fail("read interaction state", cause),
      }),
      set: (key, value) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.try({
        try: () => {
          database.query(`INSERT INTO telegram_interaction_state (key, value, updated_at)
            VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          ).run(key, JSON.stringify(value), now)
        },
        catch: (cause) => fail("write interaction state", cause),
      }))),
      modify: (key, change) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.try({
        try: () => {
          database.run("BEGIN IMMEDIATE")
          try {
            const row = database.query<{ readonly value: string }, [string]>(
              "SELECT value FROM telegram_interaction_state WHERE key = ?",
            ).get(key)
            const current = row === null ? Option.none<unknown>() : Option.some(JSON.parse(row.value))
            const [result, value] = change(current)
            database.query(`INSERT INTO telegram_interaction_state (key, value, updated_at)
              VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).run(key, JSON.stringify(value), now)
            database.run("COMMIT")
            return result
          } catch (cause) {
            database.run("ROLLBACK")
            throw cause
          }
        },
        catch: (cause) => cause instanceof InteractionStoreError ? cause : fail("modify interaction state", cause),
      }))),
    }
  }),
)

export const InteractionStoreMemory: Layer.Layer<InteractionStore> = Layer.effect(
  InteractionStore,
  Ref.make<ReadonlyMap<string, unknown>>(new Map()).pipe(
    Effect.map((ref) => ({
      get: (key) => Ref.get(ref).pipe(Effect.map((values) => Option.fromNullishOr(values.get(key)))),
      set: (key, value) => Ref.update(ref, (values) => new Map(values).set(key, value)),
      modify: (key, change) => Ref.modify(ref, (values) => {
        const [result, value] = change(Option.fromNullishOr(values.get(key)))
        return [result, new Map(values).set(key, value)]
      }),
    })),
  ),
)
