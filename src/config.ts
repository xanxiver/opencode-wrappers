import { Config, ConfigProvider, Context, Data, Duration, Effect, Layer, Option, Schema } from "effect"
import { homedir } from "node:os"
import { resolve } from "node:path"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
}> {}

/** Expand a leading `~` and absolutize a path. */
export const expandHome = (value: string): string =>
  value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value)

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value

export class AppConfig extends Schema.Class<AppConfig>("AppConfig")({
  telegramBotToken: Schema.NonEmptyString,
  opencodeBaseUrl: Schema.optional(Schema.String),
  opencodeUsername: Schema.optional(Schema.String),
  opencodePassword: Schema.optional(Schema.String),
  projectDirectory: Schema.NonEmptyString,
  stateFile: Schema.NonEmptyString,
  /** Comma-separated Telegram user ids allowed to use the bot. Empty = deny all. */
  telegramAllowedUsers: Schema.optional(Schema.String),
  /** Run limit. Use `none` to disable the limit. */
  telegramRunTimeout: Schema.String,
}) {}

/** Parse a positive timeout such as `10 minutes`. */
export const parseRunTimeout = (value: string): Option.Option<Duration.Duration> => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|seconds?|minutes?|hours?|days?)$/i.exec(value.trim())
  if (match === null) return Option.none()
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return Option.none()
  const unit = match[2].toLowerCase()
  const multiplier = unit.startsWith("millisecond")
    ? 1
    : unit.startsWith("second")
      ? 1_000
      : unit.startsWith("minute")
        ? 60_000
        : unit.startsWith("hour")
          ? 3_600_000
          : 86_400_000
  return Option.some(Duration.millis(amount * multiplier))
}

export const AppConfigTag: Context.Service<AppConfig, AppConfig> = Context.Service<AppConfig, AppConfig>(
  "opencode2-uis/AppConfig",
)

const raw = Config.all({
  telegramBotToken: Config.string("TELEGRAM_BOT_TOKEN"),
  opencodeBaseUrl: Config.option(Config.string("OPENCODE_BASE_URL")),
  opencodeUsername: Config.option(Config.string("OPENCODE_USERNAME")),
  opencodePassword: Config.option(Config.string("OPENCODE_PASSWORD")),
  projectDirectory: Config.string("PROJECT_DIRECTORY").pipe(Config.withDefault(process.cwd())),
  stateFile: Config.string("STATE_FILE").pipe(Config.withDefault("data/state.json")),
  telegramAllowedUsers: Config.option(Config.string("TELEGRAM_ALLOWED_USERS")),
  telegramRunTimeout: Config.string("TELEGRAM_RUN_TIMEOUT").pipe(Config.withDefault("10 minutes")),
})

export const Live: Layer.Layer<AppConfig, ConfigError> = Layer.effect(
  AppConfigTag,
  raw.parse(ConfigProvider.fromEnv()).pipe(
    Effect.mapError(() => new ConfigError({ message: "invalid configuration" })),
    Effect.map((env) => ({
      ...env,
       opencodeBaseUrl: emptyToUndefined(Option.getOrUndefined(env.opencodeBaseUrl)),
       opencodeUsername: emptyToUndefined(Option.getOrUndefined(env.opencodeUsername)),
       opencodePassword: emptyToUndefined(Option.getOrUndefined(env.opencodePassword)),
      telegramAllowedUsers: Option.getOrUndefined(env.telegramAllowedUsers),
      projectDirectory: expandHome(env.projectDirectory),
      stateFile: expandHome(env.stateFile),
    })),
    Effect.flatMap((env) => {
      const timeout = env.telegramRunTimeout.trim().toLowerCase()
      const valid = timeout === "none" || Option.isSome(parseRunTimeout(timeout))
      return valid
        ? Schema.decodeUnknownEffect(AppConfig)(env).pipe(
          Effect.mapError(() => new ConfigError({ message: "invalid configuration" })),
        )
        : Effect.fail(new ConfigError({ message: "TELEGRAM_RUN_TIMEOUT must be a duration or none" }))
    }),
  ),
)
