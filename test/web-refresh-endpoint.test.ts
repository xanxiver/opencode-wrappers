import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { AuthStateLive, issueRefreshToken } from "../src/web/backend/auth.js"
import { LoginRateLimiterLive } from "../src/web/backend/login-rate-limit.js"
import { WebPreferences, Live as WebPreferencesLive } from "../src/web/backend/preferences.js"
import { refreshRoute } from "../src/web/backend/server.js"

const makeConfig = (directory: string) => new AppConfig({
  telegramBotToken: "test-token",
  projectDirectory: directory,
  stateFile: join(directory, "state.json"),
  webDatabaseFile: join(directory, "web.sqlite"),
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
  webUsername: "alice",
  webJwtSecret: "a-strong-test-secret-with-more-than-32-bytes",
})

const serviceLayer = (config: AppConfig) => Layer.provide(
  WebPreferencesLive,
  Layer.mergeAll(
    Layer.succeed(AppConfigTag, config),
    BunCrypto.layer,
    BunFileSystem.layer,
    BunPath.layer,
  ),
)

const request = (token: string) => new Request("http://localhost/api/auth/refresh", {
  method: "POST",
  headers: { cookie: `opencode_refresh=${encodeURIComponent(token)}` },
})

describe("web refresh endpoint", () => {
  test("rate limits repeated invalid three-part tokens and clears after rotation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "web-refresh-endpoint-"))
    try {
      const config = makeConfig(directory)
      const validToken = await Effect.runPromise(issueRefreshToken(config.webUsername!, config.webJwtSecret!).pipe(
        Effect.provide(AuthStateLive),
        Effect.provide(BunCrypto.layer),
      ))
      await Effect.runPromise(Effect.gen(function* () {
        const preferences = yield* WebPreferences
        yield* preferences.registerRefreshToken(config.webUsername!, validToken, Math.floor(Date.now() / 1000) + 900)
      }).pipe(Effect.provide(serviceLayer(config))))

      const { handler, dispose } = HttpRouter.toWebHandler(refreshRoute.pipe(
        Layer.provideMerge(Layer.mergeAll(
          LoginRateLimiterLive,
          AuthStateLive,
          serviceLayer(config),
          HttpServer.layerServices,
          Layer.succeed(AppConfigTag, config),
          BunCrypto.layer,
          BunFileSystem.layer,
          BunPath.layer,
        )),
      ), { disableLogger: true })
      try {
        const beforeRotation: Response[] = []
        for (let index = 0; index < 4; index += 1) beforeRotation.push(await handler(request("header.payload.signature"), Context.empty()))
        expect(beforeRotation.map((response) => response.status)).toEqual([401, 401, 401, 401])

        const rotated = await handler(request(validToken), Context.empty())
        expect(rotated.status).toBe(200)
        expect(rotated.headers.get("set-cookie")).toContain("opencode_refresh=")

        const invalidResponses: Response[] = []
        for (let index = 0; index < 5; index += 1) invalidResponses.push(await handler(request("header.payload.signature"), Context.empty()))
        expect(invalidResponses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401])

        const blocked = await handler(request("header.payload.signature"), Context.empty())
        expect(blocked.status).toBe(429)
        expect(blocked.headers.get("retry-after")).toBeTruthy()
      } finally {
        await dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
