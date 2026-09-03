import { Buffer } from "node:buffer"
import { Database } from "bun:sqlite"
import { Clock, Context, Crypto, Data, Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { AppConfigTag, type AppConfig } from "../../config.js"

export class WebPreferencesError extends Data.TaggedError("WebPreferencesError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export interface WebPreferencesData {
  readonly lastProject?: string
  readonly lastSessions: Readonly<Record<string, string>>
  readonly favoriteSessionIDs: readonly string[]
  readonly settings: Readonly<Record<string, string>>
}

const allowedUserSettings = new Set(["theme", "themeFamily", "chatWidth", "hideSubagents", "sidebar", "mediaDirectories", "expandChatDetails", "showAllSessions"])

const isMediaDirectories = (value: string): boolean => {
  const directories = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
  return directories.length <= 32 && directories.every((directory) => directory.length <= 512 && !directory.includes("\0") && (directory.startsWith("/") || directory.startsWith("~/")))
}

export const isAllowedUserSetting = (key: string, value: string): boolean => {
  if (!allowedUserSettings.has(key)) return false
  if (key === "theme") return value === "light" || value === "dark"
  if (key === "themeFamily") return ["cosmic", "amethyst", "meadow", "komorebi", "coffee", "tokyo", "spring", "summer", "autumn", "winter", "monochrome", "paper"].includes(value)
  if (key === "chatWidth") return ["full", "wide", "normal", "narrow"].includes(value)
  if (key === "hideSubagents") return value === "true" || value === "false"
  if (key === "expandChatDetails") return value === "true" || value === "false"
  if (key === "showAllSessions") return value === "true" || value === "false"
  if (key === "sidebar") return value === "open" || value === "closed"
  if (key === "mediaDirectories") return isMediaDirectories(value)
  return false
}

const hashRefreshToken = (crypto: Crypto.Crypto, token: string): Effect.Effect<string, PlatformError.PlatformError> =>
  crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
    Effect.map((digest) => Buffer.from(digest).toString("base64url")),
  )

export interface WebPreferencesService {
  readonly get: (username: string) => Effect.Effect<WebPreferencesData, WebPreferencesError>
  readonly setProject: (username: string, directory: string) => Effect.Effect<void, WebPreferencesError>
  readonly setSession: (username: string, directory: string, sessionID: string) => Effect.Effect<void, WebPreferencesError>
  readonly setFavorite: (username: string, sessionID: string, pinned: boolean) => Effect.Effect<void, WebPreferencesError>
  readonly setSetting: (username: string, key: string, value: string) => Effect.Effect<void, WebPreferencesError>
  readonly registerRefreshToken: (username: string, token: string, expiresAt: number) => Effect.Effect<void, WebPreferencesError>
  readonly consumeRefreshToken: (username: string, token: string, now: number) => Effect.Effect<boolean, WebPreferencesError>
  readonly rotateRefreshToken: (username: string, currentToken: string, nextToken: string, nextExpiresAt: number, now: number) => Effect.Effect<boolean, WebPreferencesError>
  readonly revokeRefreshToken: (username: string, token: string) => Effect.Effect<void, WebPreferencesError>
  readonly revokeAccessToken: (username: string, token: string) => Effect.Effect<void, WebPreferencesError>
  readonly isAccessTokenRevoked: (username: string, token: string, now: number) => Effect.Effect<boolean, WebPreferencesError>
}

export class WebPreferences extends Context.Service<WebPreferences, WebPreferencesService>()("opencode2-uis/WebPreferences") {}

const schema = (database: Database): void => {
  database.run("PRAGMA busy_timeout = 5000")
  database.run(`CREATE TABLE IF NOT EXISTS web_preferences (
    username TEXT PRIMARY KEY,
    last_project TEXT
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS web_last_sessions (
    username TEXT NOT NULL,
    directory TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (username, directory)
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS web_favorite_sessions (
    username TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (username, session_id)
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS web_user_settings (
    username TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (username, key)
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS web_refresh_tokens (
    username TEXT NOT NULL,
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  )`)
  database.run(`CREATE TABLE IF NOT EXISTS web_revoked_access_tokens (
    username TEXT NOT NULL,
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`)
}

/** Open the preferences database and apply all idempotent schema migrations. */
export const openWebPreferencesDatabase = (path: string): Database => {
  const database = new Database(path, { create: true })
  try {
    schema(database)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

export const Live: Layer.Layer<WebPreferences, WebPreferencesError, AppConfig | Crypto.Crypto | FileSystem.FileSystem | Path.Path> = Layer.effect(
  WebPreferences,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const crypto = yield* Crypto.Crypto
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const path = config.webDatabaseFile
    const fail = (operation: string, cause: unknown): WebPreferencesError => new WebPreferencesError({ message: `${operation} failed`, cause })
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(
      Effect.mapError((cause) => fail("create preferences database directory", cause)),
    )
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(path, { create: true }),
        catch: (cause) => fail("open preferences database", cause),
      }),
      (database) => Effect.sync(() => database.close()),
    )
    yield* Effect.try({
      try: () => schema(database),
      catch: (cause) => fail("migrate preferences database", cause),
    })
    yield* fs.chmod(path, 0o600).pipe(
      Effect.mapError((cause) => fail("secure preferences database permissions", cause)),
    )
    const withDatabase = <A>(operation: string, action: () => A): Effect.Effect<A, WebPreferencesError> =>
      Effect.try({ try: action, catch: (cause) => fail(operation, cause) })

    return {
      get: (username) => withDatabase("load preferences", () => {
        const preference = database.query<{ last_project: string | null }, [string]>("SELECT last_project FROM web_preferences WHERE username = ?").get(username)
        const sessions = database.query<{ directory: string; session_id: string }, [string]>("SELECT directory, session_id FROM web_last_sessions WHERE username = ?").all(username)
        const favorites = database.query<{ session_id: string }, [string]>("SELECT session_id FROM web_favorite_sessions WHERE username = ? ORDER BY session_id").all(username)
        const settings = database.query<{ key: string; value: string }, [string]>("SELECT key, value FROM web_user_settings WHERE username = ?").all(username)
        const result = {
          lastSessions: Object.fromEntries(sessions.map((item) => [item.directory, item.session_id])),
          favoriteSessionIDs: favorites.map((item) => item.session_id),
          settings: Object.fromEntries(settings.map((item) => [item.key, item.value])),
        }
        if (preference?.last_project === null || preference?.last_project === undefined) return result
        return Object.assign({}, result, { lastProject: preference.last_project })
      }),
      setProject: (username, directory) => withDatabase("save project preference", () => {
        database.query("INSERT INTO web_preferences (username, last_project) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET last_project = excluded.last_project").run(username, directory)
      }),
      setSession: (username, directory, sessionID) => withDatabase("save session preference", () => {
        database.query("INSERT INTO web_last_sessions (username, directory, session_id) VALUES (?, ?, ?) ON CONFLICT(username, directory) DO UPDATE SET session_id = excluded.session_id").run(username, directory, sessionID)
      }),
      setFavorite: (username, sessionID, pinned) => withDatabase("save favorite session", () => {
        if (pinned) database.query("INSERT OR IGNORE INTO web_favorite_sessions (username, session_id) VALUES (?, ?)").run(username, sessionID)
        else database.query("DELETE FROM web_favorite_sessions WHERE username = ? AND session_id = ?").run(username, sessionID)
      }),
      setSetting: (username, key, value) => withDatabase("save user setting", () => {
        database.query("INSERT INTO web_user_settings (username, key, value) VALUES (?, ?, ?) ON CONFLICT(username, key) DO UPDATE SET value = excluded.value").run(username, key, value)
      }),
      registerRefreshToken: (username, token, expiresAt) => Effect.gen(function* () {
        const hash = yield* hashRefreshToken(crypto, token).pipe(Effect.mapError((cause) => fail("hash refresh token", cause)))
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        yield* withDatabase("save refresh token", () => {
          database.run("BEGIN IMMEDIATE")
          try {
            database.query("DELETE FROM web_refresh_tokens WHERE revoked = 1 OR expires_at <= ?").run(now)
            database.query("INSERT OR REPLACE INTO web_refresh_tokens (username, token_hash, expires_at, revoked) VALUES (?, ?, ?, 0)").run(username, hash, expiresAt)
            database.run("COMMIT")
          } catch (cause) {
            database.run("ROLLBACK")
            throw cause
          }
        })
      }),
      consumeRefreshToken: (username, token, now) => Effect.gen(function* () {
        const hash = yield* hashRefreshToken(crypto, token).pipe(Effect.mapError((cause) => fail("hash refresh token", cause)))
        return yield* withDatabase("consume refresh token", () => {
          database.run("BEGIN IMMEDIATE")
          try {
            const result = database.query("UPDATE web_refresh_tokens SET revoked = 1 WHERE username = ? AND token_hash = ? AND revoked = 0 AND expires_at > ?").run(username, hash, now)
            if (result.changes > 0) database.query("DELETE FROM web_refresh_tokens WHERE username = ? AND token_hash = ?").run(username, hash)
            database.run("COMMIT")
            return result.changes > 0
          } catch (cause) {
            database.run("ROLLBACK")
            throw cause
          }
        })
      }),
      rotateRefreshToken: (username, currentToken, nextToken, nextExpiresAt, now) => Effect.gen(function* () {
        const hashes = yield* Effect.all({
          current: hashRefreshToken(crypto, currentToken),
          next: hashRefreshToken(crypto, nextToken),
        }).pipe(Effect.mapError((cause) => fail("hash refresh token rotation", cause)))
        return yield* withDatabase("rotate refresh token", () => {
          database.run("BEGIN IMMEDIATE")
          try {
            database.query("DELETE FROM web_refresh_tokens WHERE revoked = 1 OR expires_at <= ?").run(now)
            const current = database.query("SELECT 1 FROM web_refresh_tokens WHERE username = ? AND token_hash = ? AND revoked = 0 AND expires_at > ? LIMIT 1").get(username, hashes.current, now)
            if (current === null) {
              database.run("COMMIT")
              return false
            }
            database.query("DELETE FROM web_refresh_tokens WHERE username = ? AND token_hash = ?").run(username, hashes.current)
            database.query("INSERT INTO web_refresh_tokens (username, token_hash, expires_at, revoked) VALUES (?, ?, ?, 0)").run(username, hashes.next, nextExpiresAt)
            database.run("COMMIT")
            return true
          } catch (cause) {
            database.run("ROLLBACK")
            throw cause
          }
        })
      }),
      revokeRefreshToken: (username, token) => Effect.gen(function* () {
        const hash = yield* hashRefreshToken(crypto, token).pipe(Effect.mapError((cause) => fail("hash refresh token", cause)))
        yield* withDatabase("revoke refresh token", () => database.query("DELETE FROM web_refresh_tokens WHERE username = ? AND token_hash = ?").run(username, hash))
      }),
      revokeAccessToken: (username, token) => Effect.gen(function* () {
        const hash = yield* hashRefreshToken(crypto, token).pipe(Effect.mapError((cause) => fail("hash access token", cause)))
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        yield* withDatabase("revoke access token", () => database.query("INSERT OR IGNORE INTO web_revoked_access_tokens (username, token_hash, expires_at) VALUES (?, ?, ?)").run(username, hash, now + 15 * 60))
      }),
      isAccessTokenRevoked: (username, token, now) => Effect.gen(function* () {
        const hash = yield* hashRefreshToken(crypto, token).pipe(Effect.mapError((cause) => fail("hash access token", cause)))
        return yield* withDatabase("check access token", () => {
          database.query("DELETE FROM web_revoked_access_tokens WHERE expires_at <= ?").run(now)
          const row = database.query("SELECT 1 FROM web_revoked_access_tokens WHERE username = ? AND token_hash = ? LIMIT 1").get(username, hash)
          return row !== null && row !== undefined
        })
      }),
    }
  }),
)
