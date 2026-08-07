import { Cause, Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunFileSystem } from "@effect/platform-bun"
import { Live as ConfigLive } from "../config.js"
import { Live as OpenCodeLive } from "../core/opencode.js"
import { Live as SessionsLive } from "../core/sessions.js"
import { Live as StoreLive } from "../core/store.js"
import { Live as TelegramApiLive } from "./api.js"
import { AccessLive } from "./access.js"
import { run as runBot } from "./bot.js"
import { RunCoordinatorLive } from "./handlers/index.js"
import { Live as ModelRegistryLive } from "./models.js"
import { Live as PermissionsLive } from "./permissions.js"
import { Live as PickersLive } from "./pickers.js"
import { Live as QuestionRegistryLive } from "./questions.js"
import { resurfacePending } from "./resurface.js"

const program = Effect.gen(function* () {
  yield* Effect.annotateLogs({ component: "main", boundary: "startup" })(
    Effect.logInfo("starting telegram bot"),
  )
  yield* Effect.forkChild(resurfacePending())
  yield* runBot()
})

const app = program.pipe(
  // Layers with requirements must be provided BEFORE their dependencies,
  // because Effect.provide re-adds a layer's requirements to R.
  Effect.provide(SessionsLive),
  Effect.provide(TelegramApiLive),
  Effect.provide(AccessLive),
  Effect.provide(ModelRegistryLive),
  Effect.provide(PermissionsLive),
  Effect.provide(QuestionRegistryLive),
  Effect.provide(PickersLive),
  Effect.provide(RunCoordinatorLive),
  Effect.provide(OpenCodeLive),
  Effect.provide(StoreLive),
  Effect.provide(ConfigLive),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(BunFileSystem.layer),
)

const exit = await Effect.runPromiseExit(app)
if (Exit.isFailure(exit)) {
  Effect.runSync(
    Effect.annotateLogs({ component: "main", boundary: "process-exit" })(
      Effect.logError("bot terminated", Cause.pretty(exit.cause)),
    ),
  )
  process.exit(1)
}
