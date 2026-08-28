import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { homedir } from "node:os"
import {
  AppConfig,
  expandHome,
  isLoopbackWebHost,
  isStrongWebJwtSecret,
  parseTelegramBotPool,
} from "../src/config.js"

describe("expandHome", () => {
  test("expands a leading tilde", () => {
    expect(expandHome("~/Projects")).toBe(`${homedir()}/Projects`)
    expect(expandHome("~/x/y")).toBe(`${homedir()}/x/y`)
  })

  test("keeps absolute paths", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x")
  })

  test("resolves relative paths against the cwd", () => {
    expect(expandHome("data/state.json")).toBe(`${process.cwd()}/data/state.json`)
  })

  test("leaves plain tilde-expansion untouched for non-tilde values", () => {
    expect(expandHome(".")).toBe(process.cwd())
  })
})

describe("isStrongWebJwtSecret", () => {
  test("accepts a secret with at least 32 bytes", () => {
    expect(isStrongWebJwtSecret("aB3!xY7@qR2#nM9$kL4%pT6&vC8*eF5?")).toBe(true)
  })

  test("rejects shorter secrets", () => {
    expect(isStrongWebJwtSecret("a".repeat(31))).toBe(false)
  })

  test("rejects trivial repeated secrets", () => {
    expect(isStrongWebJwtSecret("a".repeat(32))).toBe(false)
  })

  test("measures UTF-8 bytes rather than JavaScript characters", () => {
    expect(isStrongWebJwtSecret("é".repeat(12) + "abcDEF1234")).toBe(true)
  })
})

describe("isLoopbackWebHost", () => {
  test("accepts loopback host forms", () => {
    expect(isLoopbackWebHost("localhost")).toBe(true)
    expect(isLoopbackWebHost("127.0.0.1")).toBe(true)
    expect(isLoopbackWebHost("::1")).toBe(true)
  })

  test("rejects externally reachable hosts", () => {
    expect(isLoopbackWebHost("0.0.0.0")).toBe(false)
    expect(isLoopbackWebHost("192.168.1.20")).toBe(false)
  })
})

describe("parseTelegramBotPool", () => {
  test("uses no workers when the optional value is absent", async () => {
    expect(await Effect.runPromise(parseTelegramBotPool(undefined, "controller-token"))).toEqual([])
  })

  test("decodes stable worker ids and tokens", async () => {
    const workers = await Effect.runPromise(parseTelegramBotPool(JSON.stringify([
      { id: "delivery-1", token: "worker-token-1" },
      { id: "delivery-2", token: "worker-token-2" },
    ]), "controller-token"))

    expect(workers.map(({ id, token }) => ({ id, token }))).toEqual([
      { id: "delivery-1", token: "worker-token-1" },
      { id: "delivery-2", token: "worker-token-2" },
    ])
  })

  test("rejects malformed JSON without exposing its contents", async () => {
    const secret = "super-secret-worker-token"
    const exit = await Effect.runPromiseExit(parseTelegramBotPool(`[{"token":"${secret}"}`, "controller-token"))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret)
  })

  test("rejects reserved and duplicate worker identities", async () => {
    const reserved = await Effect.runPromiseExit(parseTelegramBotPool(JSON.stringify([
      { id: "controller", token: "worker-token" },
    ]), "controller-token"))
    const duplicate = await Effect.runPromiseExit(parseTelegramBotPool(JSON.stringify([
      { id: "delivery-1", token: "worker-token-1" },
      { id: "delivery-1", token: "worker-token-2" },
    ]), "controller-token"))

    expect(Exit.isFailure(reserved)).toBe(true)
    expect(Exit.isFailure(duplicate)).toBe(true)
  })

  test("rejects duplicate and controller token reuse without printing the token", async () => {
    const secret = "same-secret-token"
    const duplicate = await Effect.runPromiseExit(parseTelegramBotPool(JSON.stringify([
      { id: "delivery-1", token: secret },
      { id: "delivery-2", token: secret },
    ]), "controller-token"))
    const controllerReuse = await Effect.runPromiseExit(parseTelegramBotPool(JSON.stringify([
      { id: "delivery-1", token: secret },
    ]), secret))

    for (const exit of [duplicate, controllerReuse]) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret)
    }
  })
})

test("shared web configuration does not require a Telegram token", () => {
  const config = new AppConfig({
    projectDirectory: process.cwd(),
    stateFile: `${process.cwd()}/data/state.json`,
    webDatabaseFile: `${process.cwd()}/data/web.sqlite`,
    telegramRunTimeout: "10 minutes",
    webPort: 3001,
  })

  expect(config.telegramBotToken).toBeUndefined()
})
