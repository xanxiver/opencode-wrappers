import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { isTrustedOrigin, originFromReferer } from "../src/web/backend/csrf.js"
import { LoginRateLimiter, LoginRateLimiterLive } from "../src/web/backend/login-rate-limit.js"
import { isPathInsideRoots } from "../src/web/backend/path-security.js"
import { allowedDirectory, listFilesystemWorkspaces, readAllowedImage } from "../src/web/backend/server.js"

const securityConfig = (root: string) => new AppConfig({
  telegramBotToken: "test-token",
  projectDirectory: root,
  stateFile: join(root, "state.json"),
  webDatabaseFile: join(root, "web.sqlite"),
  webWorkspaceRoots: root,
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
})

const runPathEffect = <A, E>(effect: Effect.Effect<A, E, import("effect").FileSystem.FileSystem | import("effect").Path.Path>) =>
  Effect.runPromiseExit(effect.pipe(
    Effect.provide(BunFileSystem.layer),
    Effect.provide(BunPath.layer),
  ))

describe("web trusted origins", () => {
  test("requires an origin and exact host or configured origin", () => {
    expect(isTrustedOrigin(undefined, "127.0.0.1:3001", [])).toBe(false)
    expect(isTrustedOrigin("http://127.0.0.1:3001", "127.0.0.1:3001", [])).toBe(true)
    expect(isTrustedOrigin("http://127.0.0.1:3000", "127.0.0.1:3001", [])).toBe(false)
    expect(isTrustedOrigin("http://127.0.0.1:3000", "127.0.0.1:3001", ["http://127.0.0.1:3000"])).toBe(true)
  })

  test("extracts a safe origin from a referer", () => {
    expect(originFromReferer("http://127.0.0.1:3001/app")).toBe("http://127.0.0.1:3001")
    expect(originFromReferer("not a URL")).toBeUndefined()
    expect(isTrustedOrigin(originFromReferer("http://127.0.0.1:3001/app"), "127.0.0.1:3001", [])).toBe(true)
  })
})

describe("web login rate limiter", () => {
  test("blocks after five failures and clears on success", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const limiter = yield* LoginRateLimiter
      for (let index = 0; index < 5; index += 1) yield* limiter.recordFailure("login", "client", 1_000 + index)
      const blocked = yield* limiter.retryAfter("login", "client", 2_000)
      yield* limiter.clear("login", "client")
      const cleared = yield* limiter.retryAfter("login", "client", 2_000)
      return { blocked, cleared }
    }).pipe(Effect.provide(LoginRateLimiterLive)))
    expect(result.blocked).toBeGreaterThan(0)
    expect(result.cleared).toBeUndefined()
  })

  test("expires failures after the window", async () => {
    const retryAfter = await Effect.runPromise(Effect.gen(function* () {
      const limiter = yield* LoginRateLimiter
      for (let index = 0; index < 5; index += 1) yield* limiter.recordFailure("login", "client", 1_000 + index)
      return yield* limiter.retryAfter("login", "client", 901_001)
    }).pipe(Effect.provide(LoginRateLimiterLive)))
    expect(retryAfter).toBeUndefined()
  })
})

describe("web media path boundaries", () => {
  test("includes each configured workspace root as a selectable project", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "web-workspace-root-"))
    const child = join(sandbox, "child")
    mkdirSync(child)
    try {
      const options = await Effect.runPromise(listFilesystemWorkspaces(securityConfig(sandbox)).pipe(
        Effect.provide(BunFileSystem.layer),
        Effect.provide(BunPath.layer),
      ))
      expect(options.map((option) => option.directory)).toContain(sandbox)
      expect(options.map((option) => option.directory)).toContain(child)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("accepts descendants and rejects traversal-like paths", () => {
    expect(isPathInsideRoots("/workspace/images/photo.png", ["/workspace"])).toBe(true)
    expect(isPathInsideRoots("/workspace-other/photo.png", ["/workspace"])).toBe(false)
    expect(isPathInsideRoots("/tmp/photo.png", ["/workspace"])).toBe(false)
  })

  test("rejects workspace directories outside configured roots after realpath resolution", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "web-path-security-"))
    const root = join(sandbox, "root")
    const child = join(root, "project")
    const outside = join(sandbox, "outside")
    mkdirSync(child, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(root, "escaped"))
    try {
      const config = securityConfig(root)
      const inside = await runPathEffect(allowedDirectory(child).pipe(Effect.provideService(AppConfigTag, config)))
      const directOutside = await runPathEffect(allowedDirectory(outside).pipe(Effect.provideService(AppConfigTag, config)))
      const symlinkOutside = await runPathEffect(allowedDirectory(join(root, "escaped")).pipe(Effect.provideService(AppConfigTag, config)))
      expect(Exit.isSuccess(inside)).toBe(true)
      expect(Exit.isFailure(directOutside)).toBe(true)
      expect(Exit.isFailure(symlinkOutside)).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("does not turn empty workspace-root entries into the process directory", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "web-empty-root-"))
    try {
      const config = new AppConfig({
        ...securityConfig(sandbox),
        webWorkspaceRoots: `${sandbox},`,
      })
      const cwd = await runPathEffect(allowedDirectory(process.cwd()).pipe(Effect.provideService(AppConfigTag, config)))
      expect(Exit.isFailure(cwd)).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test("rejects absolute image reads outside workspace roots when no media setting exists", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "web-media-security-"))
    const root = join(sandbox, "root")
    const outside = join(sandbox, "outside")
    mkdirSync(root)
    mkdirSync(outside)
    const insideImage = join(root, "inside.png")
    const outsideImage = join(outside, "outside.png")
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
    writeFileSync(insideImage, png)
    writeFileSync(outsideImage, png)
    try {
      const config = securityConfig(root)
      const inside = await runPathEffect(readAllowedImage(insideImage, undefined, undefined).pipe(Effect.provideService(AppConfigTag, config)))
      const escaped = await runPathEffect(readAllowedImage(outsideImage, undefined, undefined).pipe(Effect.provideService(AppConfigTag, config)))
      expect(Exit.isSuccess(inside)).toBe(true)
      expect(Exit.isFailure(escaped)).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
