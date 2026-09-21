import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { isAllowedUserSetting, Live, WebPreferences } from "../src/web/backend/preferences.js"

const makeLayer = (databaseFile: string) => Layer.provide(
  Layer.provide(Live, Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)),
  Layer.succeed(AppConfigTag, new AppConfig({
    telegramBotToken: "test-token",
    projectDirectory: "/tmp",
    stateFile: `${databaseFile}.json`,
    webDatabaseFile: databaseFile,
    telegramRunTimeout: "10 minutes",
    webPort: 3001,
  })),
)

describe("WebPreferences", () => {
  test("accepts only supported setting keys and values", () => {
    expect(isAllowedUserSetting("theme", "dark")).toBe(true)
    expect(isAllowedUserSetting("chatWidth", "wide")).toBe(true)
    expect(isAllowedUserSetting("hideSubagents", "true")).toBe(true)
    expect(isAllowedUserSetting("expandChatDetails", "true")).toBe(true)
    expect(isAllowedUserSetting("showAllSessions", "true")).toBe(true)
    expect(isAllowedUserSetting("showAllSessions", "maybe")).toBe(false)
    expect(isAllowedUserSetting("expandChatDetails", "expanded")).toBe(false)
    expect(isAllowedUserSetting("unknown", "value")).toBe(false)
    expect(isAllowedUserSetting("theme", "neon")).toBe(false)
    expect(isAllowedUserSetting("chatWidth", "huge")).toBe(false)
    expect(isAllowedUserSetting("sidebar", "true")).toBe(false)
    expect(isAllowedUserSetting("sidebar", "open")).toBe(true)
    expect(isAllowedUserSetting("mediaDirectories", "/tmp/opencode,/home/user/images")).toBe(true)
    expect(isAllowedUserSetting("mediaDirectories", "relative/images")).toBe(false)
  })

  test("persists project, per-project session, and favorites", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-preferences-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        yield* preferences.setProject("luna", "/workspace/kissa")
        yield* preferences.setSession("luna", "/workspace/kissa", "ses_123")
        yield* preferences.setFavorite("luna", "ses_123", true)
        yield* preferences.setSetting("luna", "theme", "light")
        return yield* preferences.get("luna")
      }).pipe(Effect.provide(layer)))
      expect(result).toEqual({
        lastProject: "/workspace/kissa",
        lastSessions: { "/workspace/kissa": "ses_123" },
        favoriteSessionIDs: ["ses_123"],
        settings: { theme: "light" },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("consumes a refresh token only once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        yield* preferences.registerRefreshToken("luna", "header.payload.signature", 2_000)
        const first = yield* preferences.consumeRefreshToken("luna", "header.payload.signature", 1_000)
        const second = yield* preferences.consumeRefreshToken("luna", "header.payload.signature", 1_000)
        return { first, second }
      }).pipe(Effect.provide(layer)))
      expect(result).toEqual({ first: true, second: false })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps separate active refresh tokens and persists access revocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-state-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        const now = Math.floor(Date.now() / 1000)
        yield* preferences.registerRefreshToken("luna", "header.payload.one", now + 2_000)
        yield* preferences.registerRefreshToken("luna", "header.payload.two", now + 2_000)
        const first = yield* preferences.consumeRefreshToken("luna", "header.payload.one", now)
        const second = yield* preferences.consumeRefreshToken("luna", "header.payload.two", now)
        const beforeRevoke = yield* preferences.isAccessTokenRevoked("luna", "access-token", now)
        yield* preferences.revokeAccessToken("luna", "access-token")
        const afterRevoke = yield* preferences.isAccessTokenRevoked("luna", "access-token", now)
        return { first, second, beforeRevoke, afterRevoke }
      }).pipe(Effect.provide(layer)))
      expect(result).toEqual({ first: true, second: true, beforeRevoke: false, afterRevoke: true })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("consumes a refresh token atomically under concurrent requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-concurrent-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        const now = Math.floor(Date.now() / 1000)
        yield* preferences.registerRefreshToken("luna", "header.payload.concurrent", now + 2_000)
        const consume = preferences.consumeRefreshToken("luna", "header.payload.concurrent", now).pipe(Effect.provide(layer))
        return yield* Effect.all([Effect.promise(() => Effect.runPromise(consume)), Effect.promise(() => Effect.runPromise(consume))])
      }).pipe(Effect.provide(layer)))
      expect(result.filter(Boolean)).toHaveLength(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rotates a refresh token atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-rotation-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        const now = Math.floor(Date.now() / 1000)
        yield* preferences.registerRefreshToken("luna", "header.payload.old", now + 2_000)
        const rotated = yield* preferences.rotateRefreshToken(
          "luna",
          "header.payload.old",
          "header.payload.next",
          now + 2_000,
          now,
        )
        const oldValid = yield* preferences.consumeRefreshToken("luna", "header.payload.old", now)
        const nextValid = yield* preferences.consumeRefreshToken("luna", "header.payload.next", now)
        return { rotated, oldValid, nextValid }
      }).pipe(Effect.provide(layer)))
      expect(result).toEqual({ rotated: true, oldValid: false, nextValid: true })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps the current refresh token when rotation cannot insert its replacement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-rotation-rollback-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        const now = Math.floor(Date.now() / 1000)
        yield* preferences.registerRefreshToken("luna", "header.payload.current", now + 2_000)
        yield* preferences.registerRefreshToken("luna", "header.payload.collision", now + 2_000)
        yield* Effect.exit(preferences.rotateRefreshToken(
          "luna",
          "header.payload.current",
          "header.payload.collision",
          now + 2_000,
          now,
        ))
        return yield* preferences.consumeRefreshToken("luna", "header.payload.current", now)
      }).pipe(Effect.provide(layer)))
      expect(result).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("removes stale refresh records while keeping active records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kissa-web-auth-cleanup-"))
    const databaseFile = join(directory, "web.sqlite")
    try {
      const layer = makeLayer(databaseFile)
      const result = await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        const now = Math.floor(Date.now() / 1000)
        yield* preferences.registerRefreshToken("luna", "header.payload.expired", now - 1)
        yield* preferences.registerRefreshToken("luna", "header.payload.active", now + 2_000)
        const expired = yield* preferences.consumeRefreshToken("luna", "header.payload.expired", now)
        const active = yield* preferences.consumeRefreshToken("luna", "header.payload.active", now)
        return { expired, active }
      }).pipe(Effect.provide(layer)))
      expect(result).toEqual({ expired: false, active: true })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
