import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { logDebugEvent } from "../src/core/logging.js"

describe("logDebugEvent", () => {
  test("emits enabled debug diagnostics through the default information threshold", () => {
    const entries: Array<{ readonly level: string; readonly message: string }> = []
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      entries.push({
        level: logLevel,
        message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
      })
    })

    Effect.runSync(logDebugEvent(
      true,
      "telegram/run",
      "message-stream",
      "Telegram message stream started",
      { runID: "run-1", textLength: 0 },
    ).pipe(Effect.provide(Logger.layer([logger]))))

    expect(entries).toEqual([{
      level: "Debug",
      message: "Telegram message stream started",
    }])
  })

  test("does not emit disabled diagnostics", () => {
    const entries: string[] = []
    const logger = Logger.make<unknown, void>(({ message }) => {
      entries.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
    })

    Effect.runSync(logDebugEvent(
      false,
      "telegram/run",
      "message-stream",
      "Telegram message stream started",
    ).pipe(Effect.provide(Logger.layer([logger]))))

    expect(entries).toEqual([])
  })
})
