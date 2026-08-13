import { describe, expect, test } from "bun:test"
import { parseMessageCommand } from "../src/telegram/handlers/message.js"

describe("Telegram message command parsing", () => {
  test("splits a command and trims its argument", () => {
    expect(parseMessageCommand("/models  openai ")).toEqual({
      name: "/models",
      argument: "openai",
      hasArgument: true,
    })
  })

  test("preserves the distinction between no argument and an empty argument", () => {
    expect(parseMessageCommand("/models")).toEqual({
      name: "/models",
      argument: "",
      hasArgument: false,
    })
    expect(parseMessageCommand("/models ")).toEqual({
      name: "/models",
      argument: "",
      hasArgument: true,
    })
  })
})
