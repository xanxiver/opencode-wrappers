import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { parseMessageCommand, parseQueueMove, parseQueuePosition } from "../src/telegram/handlers/message.js"

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

  test("parses queue move positions", () => {
    expect(parseQueueMove("3 1")).toEqual(Option.some({ from: 3, to: 1 }))
    expect(parseQueueMove(" 2   5 ")).toEqual(Option.some({ from: 2, to: 5 }))
    expect(parseQueueMove("2")).toEqual(Option.none())
    expect(parseQueueMove("0 1")).toEqual(Option.none())
    expect(parseQueueMove("2 -3")).toEqual(Option.none())
    expect(parseQueueMove("a b")).toEqual(Option.none())
    expect(parseQueueMove("")).toEqual(Option.none())
  })

  test("parses a single queue position", () => {
    expect(parseQueuePosition("2")).toEqual(Option.some(2))
    expect(parseQueuePosition(" 7 ")).toEqual(Option.some(7))
    expect(parseQueuePosition("0")).toEqual(Option.none())
    expect(parseQueuePosition("-1")).toEqual(Option.none())
    expect(parseQueuePosition("x")).toEqual(Option.none())
    expect(parseQueuePosition("")).toEqual(Option.none())
  })
})
