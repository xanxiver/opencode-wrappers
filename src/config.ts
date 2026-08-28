import { Config, ConfigProvider, Context, Data, Duration, Effect, Layer, Option, Schema } from "effect"
import { homedir } from "node:os"
import { resolve } from "node:path"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const TELEGRAM_CONTROLLER_BOT_KEY = "controller"

export class TelegramBotMemberConfig extends Schema.Class<TelegramBotMemberConfig>("TelegramBotMemberConfig")({
  id: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
}) {}

const TelegramBotPoolSchema = Schema.Array(TelegramBotMemberConfig)
const TELEGRAM_BOT_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
type JsonValue = ReturnType<typeof JSON.parse>

/** Decode the optional outbound delivery pool without retaining secrets in failures. */
export const parseTelegramBotPool = (
  value: string | undefined,
  controllerToken?: string,
): Effect.Effect<readonly TelegramBotMemberConfig[], ConfigError> => Effect.gen(function* () {
  if (value === undefined || value.trim() === "") return []
  const parsed = yield* Effect.try({
    try: (): JsonValue => JSON.parse(value),
    catch: () => new ConfigError({ message: "TELEGRAM_BOT_POOL must be valid JSON" }),
  })
  const members = yield* Schema.decodeUnknownEffect(TelegramBotPoolSchema)(parsed).pipe(
    Effect.mapError(() => new ConfigError({
      message: "TELEGRAM_BOT_POOL must be an array of non-empty id and token entries",
    })),
  )
  const ids = new Set<string>()
  const tokens = new Set<string>()
  for (const member of members) {
    if (!TELEGRAM_BOT_KEY_PATTERN.test(member.id)) {
      return yield* new ConfigError({
        message: "TELEGRAM_BOT_POOL ids must start with a letter and contain only lowercase letters, numbers, or hyphens",
      })
    }
    if (member.id === TELEGRAM_CONTROLLER_BOT_KEY) {
      return yield* new ConfigError({ message: `TELEGRAM_BOT_POOL id ${TELEGRAM_CONTROLLER_BOT_KEY} is reserved` })
    }
    if (ids.has(member.id)) {
      return yield* new ConfigError({ message: "TELEGRAM_BOT_POOL contains a duplicate id" })
    }
    if (tokens.has(member.token) || member.token === controllerToken) {
      return yield* new ConfigError({ message: "TELEGRAM_BOT_POOL contains a duplicate token" })
    }
    ids.add(member.id)
    tokens.add(member.token)
  }
  return members
})

/** Expand a leading `~` and absolutize a path. */
export const expandHome = (value: string): string =>
  value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value)

/** Web JWT secrets must be long and contain enough distinct material to avoid trivial defaults. */
export const isStrongWebJwtSecret = (value: string): boolean =>
  new TextEncoder().encode(value).byteLength >= 32 && new Set(value).size >= 8

export const isLoopbackWebHost = (value: string): boolean =>
  value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]"

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value

const expandOptionalPath = (value: string | undefined): string | undefined => {
  const path = emptyToUndefined(value)
  return path === undefined ? undefined : expandHome(path)
}

export class AppConfig extends Schema.Class<AppConfig>("AppConfig")({
  telegramBotToken: Schema.optional(Schema.NonEmptyString),
  telegramBotPool: Schema.optional(TelegramBotPoolSchema),
  opencodeBaseUrl: Schema.optional(Schema.String),
  opencodeUsername: Schema.optional(Schema.String),
  opencodePassword: Schema.optional(Schema.String),
  projectDirectory: Schema.NonEmptyString,
  stateFile: Schema.NonEmptyString,
  webDatabaseFile: Schema.NonEmptyString,
  /** OpenCode SQLite database used for service-wide usage reporting. */
  opencodeDatabaseFile: Schema.optional(Schema.NonEmptyString),
  /** Comma-separated Telegram user ids allowed to use the bot. Empty = deny all. */
  telegramAllowedUsers: Schema.optional(Schema.String),
  /** Run limit. Use `none` to disable the limit. */
  telegramRunTimeout: Schema.String,
  /** Port for the web API server. */
  webPort: Schema.Int,
  /** Port for the Vite development UI, used for local cookie CSRF checks. */
  webUiPort: Schema.optional(Schema.Int),
  /** Bind address for the web API server. */
  webHost: Schema.optional(Schema.NonEmptyString),
  webSecureCookies: Schema.optional(Schema.Boolean),
  webUsername: Schema.optional(Schema.String),
  webPasswordHash: Schema.optional(Schema.String),
  webJwtSecret: Schema.optional(Schema.String),
  /** Comma-separated origins allowed to make cookie-authenticated cross-origin requests. */
  webTrustedOrigins: Schema.optional(Schema.String),
  /** Comma-separated filesystem roots whose direct child directories are workspace options. */
  webWorkspaceRoots: Schema.optional(Schema.String),
}) {}

/** Parse a positive timeout such as `10 minutes`. */
export const parseRunTimeout = (value: string): Option.Option<Duration.Duration> => {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|seconds?|minutes?|hours?|days?)$/i.exec(value.trim())
  if (match === null) return Option.none()
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return Option.none()
  const unit = match[2].toLowerCase()
  let multiplier = 86_400_000
  if (unit.startsWith("millisecond")) multiplier = 1
  else if (unit.startsWith("second")) multiplier = 1_000
  else if (unit.startsWith("minute")) multiplier = 60_000
  else if (unit.startsWith("hour")) multiplier = 3_600_000
  return Option.some(Duration.millis(amount * multiplier))
}

export const AppConfigTag: Context.Service<AppConfig, AppConfig> = Context.Service<AppConfig, AppConfig>(
  "opencode2-uis/AppConfig",
)

const raw = Config.all({
  telegramBotToken: Config.option(Config.string("TELEGRAM_BOT_TOKEN")),
  telegramBotPoolJson: Config.option(Config.string("TELEGRAM_BOT_POOL")),
  opencodeBaseUrl: Config.option(Config.string("OPENCODE_BASE_URL")),
  opencodeUsername: Config.option(Config.string("OPENCODE_USERNAME")),
  opencodePassword: Config.option(Config.string("OPENCODE_PASSWORD")),
  projectDirectory: Config.string("PROJECT_DIRECTORY").pipe(Config.withDefault(process.cwd())),
  stateFile: Config.string("STATE_FILE").pipe(Config.withDefault("data/state.json")),
  webDatabaseFile: Config.string("WEB_DATABASE_FILE").pipe(Config.withDefault("data/web.sqlite")),
  opencodeDatabaseFile: Config.option(Config.string("OPENCODE_DATABASE_FILE")),
  telegramAllowedUsers: Config.option(Config.string("TELEGRAM_ALLOWED_USERS")),
  telegramRunTimeout: Config.string("TELEGRAM_RUN_TIMEOUT").pipe(Config.withDefault("10 minutes")),
  webPort: Config.port("WEB_PORT").pipe(Config.withDefault(3001)),
  webUiPort: Config.option(Config.port("WEB_UI_PORT")),
  webHost: Config.string("WEB_HOST").pipe(Config.withDefault("127.0.0.1")),
  webSecureCookies: Config.boolean("WEB_SECURE_COOKIES").pipe(Config.withDefault(false)),
  webUsername: Config.option(Config.string("WEB_USERNAME")),
  webPasswordHash: Config.option(Config.string("WEB_PASSWORD_HASH")),
  webJwtSecret: Config.option(Config.string("WEB_JWT_SECRET")),
  webTrustedOrigins: Config.option(Config.string("WEB_TRUSTED_ORIGINS")),
  webWorkspaceRoots: Config.option(Config.string("WEB_WORKSPACE_ROOTS")),
})

export const Live: Layer.Layer<AppConfig, ConfigError> = Layer.effect(
  AppConfigTag,
  raw.parse(ConfigProvider.fromEnv()).pipe(
    Effect.mapError((cause) => new ConfigError({ message: "invalid configuration", cause })),
    Effect.map((env) => ({
      ...env,
       telegramBotToken: emptyToUndefined(Option.getOrUndefined(env.telegramBotToken)),
       telegramBotPoolJson: emptyToUndefined(Option.getOrUndefined(env.telegramBotPoolJson)),
       opencodeBaseUrl: emptyToUndefined(Option.getOrUndefined(env.opencodeBaseUrl)),
       opencodeUsername: emptyToUndefined(Option.getOrUndefined(env.opencodeUsername)),
       opencodePassword: emptyToUndefined(Option.getOrUndefined(env.opencodePassword)),
      telegramAllowedUsers: Option.getOrUndefined(env.telegramAllowedUsers),
      projectDirectory: expandHome(env.projectDirectory),
       stateFile: expandHome(env.stateFile),
       webDatabaseFile: expandHome(env.webDatabaseFile),
       opencodeDatabaseFile: expandOptionalPath(Option.getOrUndefined(env.opencodeDatabaseFile)),
       webUsername: emptyToUndefined(Option.getOrUndefined(env.webUsername)),
       webSecureCookies: env.webSecureCookies,
       webPasswordHash: emptyToUndefined(Option.getOrUndefined(env.webPasswordHash)),
       webJwtSecret: emptyToUndefined(Option.getOrUndefined(env.webJwtSecret)),
        webTrustedOrigins: emptyToUndefined(Option.getOrUndefined(env.webTrustedOrigins)),
        webWorkspaceRoots: emptyToUndefined(Option.getOrUndefined(env.webWorkspaceRoots)),
       webUiPort: Option.getOrUndefined(env.webUiPort),
    })),
    Effect.flatMap((env) => Effect.gen(function* () {
      const timeout = env.telegramRunTimeout.trim().toLowerCase()
      const valid = timeout === "none" || Option.isSome(parseRunTimeout(timeout))
      if (!valid) return yield* new ConfigError({ message: "TELEGRAM_RUN_TIMEOUT must be a duration or none" })
      if (env.webJwtSecret !== undefined && !isStrongWebJwtSecret(env.webJwtSecret)) {
        return yield* new ConfigError({ message: "WEB_JWT_SECRET must contain at least 32 bytes" })
      }
      if (env.webSecureCookies !== true && !isLoopbackWebHost(env.webHost ?? "127.0.0.1")) {
        return yield* new ConfigError({ message: "WEB_SECURE_COOKIES must be true when WEB_HOST is not loopback" })
      }
      const telegramBotPool = yield* parseTelegramBotPool(env.telegramBotPoolJson, env.telegramBotToken)
      const { telegramBotPoolJson: _, ...appConfig } = env
      return yield* Schema.decodeUnknownEffect(AppConfig)({ ...appConfig, telegramBotPool }).pipe(
        Effect.mapError((cause) => new ConfigError({ message: "invalid configuration", cause })),
      )
    })),
  ),
)
