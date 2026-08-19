import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath, BunRuntime } from "@effect/platform-bun"
import { AppConfigTag, ConfigError, Live as ConfigLive } from "../config.js"
import { GitChangesLive } from "../core/git-changes.js"
import { Live as OpenCodeLive } from "../core/opencode.js"
import { Live as SessionsLive } from "../core/sessions.js"
import { Live as StoreLive } from "../core/store.js"
import { DurableExecutorStoreLive } from "../core/durable-executor.js"
import { Live as TelegramApiLive } from "./api.js"
import { AccessLive } from "./access.js"
import { run as runBot } from "./bot.js"
import { TelegramDurableExecutorLive } from "./durable-executor.js"
import { InteractionStoreLive } from "./interaction-store.js"
import { Live as ModelRegistryLive } from "./models.js"
import { Live as PermissionsLive } from "./permissions.js"
import { Live as PickersLive } from "./pickers.js"
import { Live as QuestionRegistryLive } from "./questions.js"
import { resurfacePending } from "./resurface.js"

const program = Effect.gen(function* () {
  const config = yield* AppConfigTag
  if (config.telegramBotToken === undefined) {
    return yield* new ConfigError({ message: "TELEGRAM_BOT_TOKEN is required by the Telegram wrapper" })
  }
  yield* Effect.annotateLogs({ component: "main", boundary: "startup" })(
    Effect.logInfo("starting telegram bot"),
  )
  yield* Effect.forkChild(resurfacePending())
  yield* runBot()
})

const app = program.pipe(
  // Layers with requirements must be provided BEFORE their dependencies,
  // because Effect.provide re-adds a layer's requirements to R.
  Effect.provide(TelegramDurableExecutorLive),
  Effect.provide(GitChangesLive),
  Effect.provide(BunChildProcessSpawner.layer),
  Effect.provide(SessionsLive),
  Effect.provide(TelegramApiLive),
  Effect.provide(AccessLive),
  Effect.provide(ModelRegistryLive),
  Effect.provide(PermissionsLive),
  Effect.provide(QuestionRegistryLive),
  Effect.provide(PickersLive),
  Effect.provide(InteractionStoreLive),
  Effect.provide(DurableExecutorStoreLive),
  Effect.provide(OpenCodeLive),
  Effect.provide(StoreLive),
  Effect.provide(ConfigLive),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(BunFileSystem.layer),
  Effect.provide(BunPath.layer),
  Effect.provide(BunCrypto.layer),
)

BunRuntime.runMain(app)
