import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import {
  chatIdFromConversation,
  controllerRoute,
  conversationFromMessage,
  conversationId,
  deliveryRoute,
  isGroupConversation,
  requestContext,
} from "../src/telegram/conversation.js"

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

  test("builds explicit controller and delivery routes", () => {
    const destination = { chatId: -1007, threadId: 42 }
    expect(controllerRoute(destination)).toEqual({ botKey: "controller", ...destination })
    expect(deliveryRoute("delivery-3", destination)).toEqual({ botKey: "delivery-3", ...destination })
    expect(requestContext(destination)).toEqual({
      ...destination,
      conversationId: "tg:-1007:thread:42",
      controllerRoute: { botKey: "controller", ...destination },
    })
  })

  test("recognizes persisted group conversations without accepting unrelated keys", () => {
    expect(Option.getOrUndefined(chatIdFromConversation("tg:-1007:thread:42"))).toBe(-1007)
    expect(isGroupConversation("tg:-1007:thread:42")).toBe(true)
    expect(isGroupConversation("tg:7")).toBe(false)
    expect(Option.isNone(chatIdFromConversation("web:user-1"))).toBe(true)
  })
})
