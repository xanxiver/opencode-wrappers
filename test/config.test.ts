import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { AppConfig, expandHome, isLoopbackWebHost, isStrongWebJwtSecret } from "../src/config.js"

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
