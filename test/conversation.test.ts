import { describe, expect, test } from "bun:test"
import { conversationFromMessage, conversationId } from "../src/telegram/conversation.js"

describe("Telegram conversation identity", () => {
  test("keeps root chat ids compatible", () => {
    expect(conversationId({ chatId: 7 })).toBe("tg:7")
  })

  test("separates forum topics", () => {
    expect(conversationId({ chatId: 7, threadId: 42 })).toBe("tg:7:thread:42")
    expect(conversationId({ chatId: 7, threadId: 43 })).not.toBe(conversationId({ chatId: 7, threadId: 42 }))
  })

  test("extracts the topic from a Telegram message", () => {
    expect(conversationFromMessage({ message_id: 1, chat: { id: 7 }, message_thread_id: 42 })).toEqual({ chatId: 7, threadId: 42 })
  })
})
