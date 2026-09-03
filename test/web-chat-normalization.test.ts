import { describe, expect, test } from "bun:test"
import { normalizeChatMessages } from "../src/web/state/app-view-model"

describe("chat message normalization", () => {
  test("groups assistant tool steps into one conversational turn", () => {
    const messages = normalizeChatMessages([
      { id: "user-1", type: "user", text: "Build it" },
      { id: "assistant-1", type: "assistant", content: [{ type: "reasoning", text: "Checking" }, { type: "tool", name: "read", state: { status: "completed", content: [{ type: "text", text: "file contents" }] } }] },
      { id: "synthetic-1", type: "synthetic", text: "duplicate tool transport output" },
      { id: "assistant-2", type: "assistant", finish: "stop", content: [{ type: "text", text: "Done." }] },
    ])

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "Done.",
      reasoning: "Checking",
      tools: ["read · completed"],
    })
  })

  test("keeps attachment-only prompts and failed replies visible", () => {
    const messages = normalizeChatMessages([
      { id: "user-1", type: "user", text: "", files: [{ name: "image.png" }] },
      { id: "assistant-1", type: "assistant", finish: "error", error: { message: "failed" }, content: [] },
    ])
    expect(messages.map((message) => message.text)).toEqual(["[1 attachment]", "Response failed."])
  })

  test("separates text parts within one assistant message", () => {
    const messages = normalizeChatMessages([
      {
        id: "assistant-1",
        type: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "Second paragraph." },
        ],
      },
    ])

    expect(messages.map((message) => message.text)).toEqual([
      "First paragraph.\n\nSecond paragraph.",
    ])
  })
})
