import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppConfig, AppConfigTag } from "../src/config.js"
import { Access, Live, parseAllowedUsers } from "../src/telegram/access.js"

const configLayer = (telegramAllowedUsers: string | undefined) =>
  Layer.succeed(
    AppConfigTag,
    new AppConfig({
      telegramBotToken: "test-token",
      projectDirectory: "/tmp",
      stateFile: "/tmp/state.json",
      webDatabaseFile: "/tmp/web.sqlite",
      telegramAllowedUsers,
      telegramRunTimeout: "10 minutes",
      webPort: 3001,
    }),
  )

const isAllowed = (allowedUsers: string | undefined, userId: number) =>
  Effect.gen(function* () {
    const access = yield* Access
    return access.isAllowed(userId)
  }).pipe(Effect.provide(Live), Effect.provide(configLayer(allowedUsers)))

describe("parseAllowedUsers", () => {
  test("empty input means deny all", () => {
    expect(parseAllowedUsers(undefined)).toEqual(new Set())
    expect(parseAllowedUsers("")).toEqual(new Set())
    expect(parseAllowedUsers("   ")).toEqual(new Set())
  })

  test("parses comma-separated ids", () => {
    expect(parseAllowedUsers("123")).toEqual(new Set([123]))
    expect(parseAllowedUsers("1, 2 ,3")).toEqual(new Set([1, 2, 3]))
  })

  test("skips invalid entries", () => {
    expect(parseAllowedUsers("1,abc,2")).toEqual(new Set([1, 2]))
    expect(parseAllowedUsers("-5,0,7")).toEqual(new Set([7]))
    expect(parseAllowedUsers("1,,2")).toEqual(new Set([1, 2]))
  })
})

describe("Access", () => {
  test("denies everyone when no whitelist is configured", async () => {
    expect(await Effect.runPromise(isAllowed(undefined, 42))).toBe(false)
    expect(await Effect.runPromise(isAllowed("", 42))).toBe(false)
  })

  test("allows only listed user ids", async () => {
    expect(await Effect.runPromise(isAllowed("42", 42))).toBe(true)
    expect(await Effect.runPromise(isAllowed("42", 43))).toBe(false)
    expect(await Effect.runPromise(isAllowed("10, 20", 20))).toBe(true)
    expect(await Effect.runPromise(isAllowed("10, 20", 30))).toBe(false)
  })
})
