import { BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, Path } from "effect"
import { expandHome } from "../config.js"
import { openWebPreferencesDatabase, WebPreferencesError } from "../web/backend/preferences.js"

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const configuredPath = yield* Config.string("WEB_DATABASE_FILE").pipe(Config.withDefault("data/web.sqlite"))
  const path = expandHome(configuredPath.trim().length === 0 ? "data/web.sqlite" : configuredPath.trim())
  const existed = yield* fs.exists(path)
  yield* fs.makeDirectory(paths.dirname(path), { recursive: true })
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => openWebPreferencesDatabase(path),
      catch: (cause) => new WebPreferencesError({ message: "open preferences database failed", cause }),
    }),
    (database) => Effect.sync(() => database.close()),
  )
  yield* Console.log(existed ? `SQLite preferences ready: ${path}` : `Created SQLite preferences: ${path}`)
}).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer))

BunRuntime.runMain(main)
