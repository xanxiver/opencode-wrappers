import { describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { Effect, Option } from "effect"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import type { ChangesSummary } from "../src/core/git-changes.js"
import { EDIT_MIN_INTERVAL_MS, editDelay } from "../src/telegram/api.js"
import { MAX_RECOVERY_MESSAGE_PAGES, assistantResponseForInput, detectSupportedMediaMime, matchesSessionRoute, mediaFromResponseText, nextProgressEdit, recoveredResponseForInput, recoveredResponseFromPages } from "../src/telegram/run.js"
import {
  MAX_MESSAGE_LENGTH,
  MODEL_PAGE_SIZE,
  REASONING_DISPLAY_LIMIT,
  agentKeyboard,
  modelPageKeyboard,
  modelProviderKeyboard,
  normalizeCommand,
  parseAgentCallback,
  parseAgentCancelCallback,
  parseAgentPromptCommand,
  parseModelCallback,
  parseModelPageCallback,
  parseModelProviderCallback,
  parseModelVariantCallback,
  parseDirectoryPageCallback,
  parsePermissionCallback,
  parsePromptCommand,
  promptWithReply,
  parseQuestionCallback,
  renderChangesSummary,
  appendChangesSummary,
  renderRunQueue,
  runQueueStateLabel,
  renderFinal,
  renderModelLabel,
  renderModelPageHeader,
  renderPermission,
  renderPermissionDecision,
  renderProgress,
  renderQuestion,
  renderQuestionWithSelection,
  renderUsage,
  truncate,
} from "../src/telegram/render.js"

describe("project picker", () => {
  test("parses project page callbacks", () => {
    expect(Option.getOrThrow(parseDirectoryPageCallback("dirp:12:2"))).toEqual({ token: 12, page: 2 })
    expect(parseDirectoryPageCallback("dirp:12:-1")).toEqual(Option.none())
    expect(parseDirectoryPageCallback("dirp:nope:2")).toEqual(Option.none())
  })
})

describe("normalizeCommand", () => {
  test("strips the bot mention from commands", () => {
    expect(normalizeCommand("/model@MyBot")).toBe("/model")
    expect(normalizeCommand("/project@bot /tmp/x")).toBe("/project /tmp/x")
    expect(normalizeCommand("/prompt@MyBot fix this")).toBe("/prompt fix this")
  })

  test("leaves plain text unchanged", () => {
    expect(normalizeCommand("hello there")).toBe("hello there")
    expect(normalizeCommand("user@example.com")).toBe("user@example.com")
  })
})

describe("model provider picker", () => {
  test("parses provider callbacks and rejects invalid indexes", () => {
    expect(Option.getOrThrow(parseModelProviderCallback("modelpr:12:3"))).toEqual({ token: 12, index: 3 })
    expect(parseModelProviderCallback("modelpr:12:-1")).toEqual(Option.none())
    expect(parseModelProviderCallback("modelpr:nope:3")).toEqual(Option.none())
  })

  test("renders providers with a cancel action", () => {
    expect(modelProviderKeyboard(4, [{ id: "alpha" }, { id: "beta" }])).toEqual({
      inline_keyboard: [
        [
          { text: "alpha", callback_data: "modelpr:4:0" },
          { text: "beta", callback_data: "modelpr:4:1" },
        ],
        [{ text: "Cancel", callback_data: "modelc:4" }],
      ],
    })
  })
})

describe("parsePromptCommand", () => {
  test("parses /prompt with text", () => {
    expect(parsePromptCommand("/prompt fix the bug")).toEqual(Option.some("fix the bug"))
    expect(parsePromptCommand("/prompt   spaced text  ")).toEqual(Option.some("spaced text"))
  })

  test("parses bare /prompt as an empty prompt", () => {
    expect(parsePromptCommand("/prompt")).toEqual(Option.some(""))
  })

  test("returns none for non-prompt messages", () => {
    expect(parsePromptCommand(undefined)).toEqual(Option.none())
    expect(parsePromptCommand("hello")).toEqual(Option.none())
    expect(parsePromptCommand("/model")).toEqual(Option.none())
    expect(parsePromptCommand("/promptx")).toEqual(Option.none())
    expect(parsePromptCommand("/prompt@bot")).toEqual(Option.none())
  })
})

describe("agent commands", () => {
  test("parses an agent and prompt", () => {
    expect(parseAgentPromptCommand("/pwa build fix the queue")).toEqual(
      Option.some({ agent: "build", prompt: "fix the queue" }),
    )
    expect(parseAgentPromptCommand("/pwa  build   fix the queue  ")).toEqual(
      Option.some({ agent: "build", prompt: "fix the queue" }),
    )
  })

  test("rejects incomplete agent prompts", () => {
    expect(parseAgentPromptCommand("/pwa")).toEqual(Option.none())
    expect(parseAgentPromptCommand("/pwa build")).toEqual(Option.none())
    expect(parseAgentPromptCommand("/prompt build task")).toEqual(Option.none())
  })

  test("parses picker callbacks and renders compact buttons", () => {
    expect(parseAgentCallback("agent:4:1")).toEqual(Option.some({ token: 4, index: 1 }))
    expect(parseAgentCallback("agent:0:1")).toEqual(Option.none())
    expect(parseAgentCancelCallback("agentc:4")).toEqual(Option.some(4))
    expect(agentKeyboard(4, [{ name: "Build" }, { name: "Plan" }])).toEqual({
      inline_keyboard: [
        [
          { text: "Build", callback_data: "agent:4:0" },
          { text: "Plan", callback_data: "agent:4:1" },
        ],
        [{ text: "Cancel", callback_data: "agentc:4" }],
      ],
    })
  })
})

describe("promptWithReply", () => {
  test("includes replied message context and the requested task", () => {
    expect(promptWithReply("summarize this", "A long message")).toBe(
      "Message to respond to:\n\nA long message\n\nTask:\nsummarize this",
    )
  })

  test("uses the replied message when the prompt has no task", () => {
    expect(promptWithReply("", "A long message")).toBe("Message to respond to:\n\nA long message")
  })

  test("does not add empty reply context", () => {
    expect(promptWithReply("summarize this", "  ")).toBe("summarize this")
  })
})

describe("truncate", () => {
  test("leaves short text unchanged", () => {
    expect(truncate("hello")).toBe("hello")
  })

  test("leaves text at the limit unchanged", () => {
    const text = "a".repeat(MAX_MESSAGE_LENGTH)
    expect(truncate(text)).toBe(text)
  })

  test("truncates long text and keeps head and tail", () => {
    const text = "A".repeat(1000) + "B".repeat(1000)
    const result = truncate(text, 500)
    expect(result.length).toBeLessThanOrEqual(500)
    expect(result).toContain("truncated")
    expect(result.startsWith("A".repeat(10))).toBe(true)
    expect(result.endsWith("B".repeat(10))).toBe(true)
  })

  test("truncate with small max keeps the result within the limit", () => {
    const result = truncate("abcdefghijklmnop", 10)
    expect(result.length).toBeLessThanOrEqual(10)
    expect(result).toContain("…")
  })
})

describe("renderProgress", () => {
  test("shows working placeholder when empty", () => {
    expect(renderProgress({ text: "", reasoning: "", activity: Option.none() })).toBe("Working…")
  })

  test("shows text", () => {
    expect(renderProgress({ text: "hello", reasoning: "", activity: Option.none() })).toBe("hello")
  })

  test("shows text and activity", () => {
    expect(
      renderProgress({ text: "partial", reasoning: "", activity: Option.some("Tool: git diff") }),
    ).toBe("partial\n\nTool: git diff")
  })

  test("shows reasoning while thinking", () => {
    expect(
      renderProgress({ text: "", reasoning: "let me check the code", activity: Option.none() }),
    ).toBe("Thinking: let me check the code")
  })

  test("shows reasoning above text", () => {
    expect(
      renderProgress({ text: "answer", reasoning: "thinking hard", activity: Option.none() }),
    ).toBe("Thinking: thinking hard\n\nanswer")
  })

  test("separates adjacent bold reasoning updates", () => {
    expect(
      renderProgress({ text: "", reasoning: "**first****second**", activity: Option.none() }),
    ).toBe("Thinking: **first**\n\n**second**")
  })

  test("caps reasoning display length", () => {
    const long = "r".repeat(REASONING_DISPLAY_LIMIT + 500)
    const rendered = renderProgress({ text: "", reasoning: long, activity: Option.none() })
    expect(rendered.length).toBeLessThan(REASONING_DISPLAY_LIMIT + 100)
    expect(rendered.startsWith("Thinking: ")).toBe(true)
    expect(rendered).toContain("truncated")
  })
})

describe("renderPermission", () => {
  test("renders action and resources", () => {
    const text = renderPermission("tool.bash", ["bash: ls", "read /etc/passwd"])
    expect(text).toContain("tool.bash")
    expect(text).toContain("bash: ls")
    expect(text).toContain("read /etc/passwd")
  })
})

describe("renderFinal", () => {
  test("renders each outcome", () => {
    expect(renderFinal("work", "done")).toContain("Done.")
    expect(renderFinal("work", "failed")).toContain("Failed.")
    expect(renderFinal("work", "interrupted")).toContain("Interrupted.")
    expect(renderFinal("work", "timeout")).toContain("Timed out.")
    expect(renderFinal("work", "error")).toContain("Error.")
  })

  test("shows a placeholder when there is no text", () => {
    expect(renderFinal("", "done")).toContain("no text output")
  })
})


describe("renderUsage", () => {
  test("renders token counts and cost", () => {
    const text = renderUsage({
      cost: 0.0123,
      tokens: { input: 1000, output: 500, reasoning: 200 },
    })
    expect(text).toContain("1000 in")
    expect(text).toContain("500 out")
    expect(text).toContain("200 reasoning")
    expect(text).toContain("0.0123")
  })

  test("omits the reasoning count when zero", () => {
    const text = renderUsage({ cost: 0, tokens: { input: 1, output: 1, reasoning: 0 } })
    expect(text).not.toContain("reasoning")
  })
})

describe("renderPermissionDecision", () => {
  test("maps each reply", () => {
    expect(renderPermissionDecision("once")).toBe("Allowed once.")
    expect(renderPermissionDecision("always")).toBe("Always allowed.")
    expect(renderPermissionDecision("reject")).toBe("Rejected.")
  })
})

describe("parsePermissionCallback", () => {
  test("parses valid payloads", () => {
    expect(parsePermissionCallback("perm:1:once")).toEqual(Option.some({ token: 1, reply: "once" }))
    expect(parsePermissionCallback("perm:42:always")).toEqual(Option.some({ token: 42, reply: "always" }))
    expect(parsePermissionCallback("perm:7:reject")).toEqual(Option.some({ token: 7, reply: "reject" }))
  })

  test("rejects invalid payloads", () => {
    expect(parsePermissionCallback("perm:0:once")).toEqual(Option.none())
    expect(parsePermissionCallback("perm:-1:once")).toEqual(Option.none())
    expect(parsePermissionCallback("perm:abc:once")).toEqual(Option.none())
    expect(parsePermissionCallback("perm:1:maybe")).toEqual(Option.none())
    expect(parsePermissionCallback("perm:1")).toEqual(Option.none())
    expect(parsePermissionCallback("perm:1:once:extra")).toEqual(Option.none())
    expect(parsePermissionCallback("other:1:once")).toEqual(Option.none())
    expect(parsePermissionCallback("")).toEqual(Option.none())
  })
})

describe("parseModelCallback", () => {
  test("parses valid payloads", () => {
    expect(parseModelCallback("model:1:0")).toEqual(Option.some({ token: 1, index: 0 }))
    expect(parseModelCallback("model:42:3")).toEqual(Option.some({ token: 42, index: 3 }))
  })

  test("rejects invalid payloads", () => {
    expect(parseModelCallback("model:0:0")).toEqual(Option.none())
    expect(parseModelCallback("model:abc:0")).toEqual(Option.none())
    expect(parseModelCallback("model:1:-1")).toEqual(Option.none())
    expect(parseModelCallback("model:1")).toEqual(Option.none())
    expect(parseModelCallback("other:1:0")).toEqual(Option.none())
    expect(parseModelCallback("")).toEqual(Option.none())
  })
})

describe("parseModelPageCallback", () => {
  test("parses valid payloads", () => {
    expect(parseModelPageCallback("modelp:1:0")).toEqual(Option.some({ token: 1, page: 0 }))
    expect(parseModelPageCallback("modelp:42:2")).toEqual(Option.some({ token: 42, page: 2 }))
  })

  test("rejects invalid payloads", () => {
    expect(parseModelPageCallback("modelp:0:0")).toEqual(Option.none())
    expect(parseModelPageCallback("modelp:1:-1")).toEqual(Option.none())
    expect(parseModelPageCallback("modelp:1:abc")).toEqual(Option.none())
    expect(parseModelPageCallback("modelp:1")).toEqual(Option.none())
    expect(parseModelPageCallback("model:1:0")).toEqual(Option.none())
    expect(parseModelPageCallback("")).toEqual(Option.none())
  })
})

describe("parseModelVariantCallback", () => {
  test("parses valid payloads", () => {
    expect(parseModelVariantCallback("modelv:1:0")).toEqual(Option.some({ token: 1, index: 0 }))
    expect(parseModelVariantCallback("modelv:42:3")).toEqual(Option.some({ token: 42, index: 3 }))
  })

  test("rejects invalid payloads", () => {
    expect(parseModelVariantCallback("modelv:0:0")).toEqual(Option.none())
    expect(parseModelVariantCallback("modelv:1:-1")).toEqual(Option.none())
    expect(parseModelVariantCallback("modelv:1:abc")).toEqual(Option.none())
    expect(parseModelVariantCallback("modelv:1")).toEqual(Option.none())
    expect(parseModelVariantCallback("model:1:2")).toEqual(Option.none())
    expect(parseModelVariantCallback("")).toEqual(Option.none())
  })
})

describe("parseQuestionCallback", () => {
  test("parses option, skip and confirm payloads", () => {
    expect(parseQuestionCallback("q:1:0:2")).toEqual(
      Option.some({ token: 1, questionIndex: 0, choice: { kind: "option", index: 2 } }),
    )
    expect(parseQuestionCallback("q:1:0:skip")).toEqual(
      Option.some({ token: 1, questionIndex: 0, choice: { kind: "skip" } }),
    )
    expect(parseQuestionCallback("q:7:3:confirm")).toEqual(
      Option.some({ token: 7, questionIndex: 3, choice: { kind: "confirm" } }),
    )
  })

  test("rejects invalid payloads", () => {
    expect(parseQuestionCallback("q:0:0:1")).toEqual(Option.none())
    expect(parseQuestionCallback("q:1:-1:1")).toEqual(Option.none())
    expect(parseQuestionCallback("q:1:0:abc")).toEqual(Option.none())
    expect(parseQuestionCallback("q:1:0")).toEqual(Option.none())
    expect(parseQuestionCallback("other:1:0:1")).toEqual(Option.none())
    expect(parseQuestionCallback("")).toEqual(Option.none())
  })
})

describe("renderModelLabel", () => {
  test("includes model and provider", () => {
    expect(renderModelLabel("claude-3-5", "anthropic")).toBe("claude-3-5 (anthropic)")
  })
})

describe("renderModelPageHeader", () => {
  test("single page keeps the simple form", () => {
    expect(renderModelPageHeader(0, 5)).toBe("Select a model (5):")
  })

  test("multi page shows page numbers and range", () => {
    expect(renderModelPageHeader(0, 25)).toBe("Select a model (page 1 of 5, 1-5 of 25):")
    expect(renderModelPageHeader(4, 25)).toBe("Select a model (page 5 of 5, 21-25 of 25):")
  })
})

describe("modelPageKeyboard", () => {
  const models = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, providerID: "p" }))

  test("builds model buttons with per-model callback data", () => {
    const keyboard = modelPageKeyboard(1, models, 0, 25)
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some((b) => b.callback_data === "model:1:0")).toBe(true)
    expect(buttons.some((b) => b.callback_data === "model:1:4")).toBe(true)
  })

  test("uses absolute model indexes on later pages", () => {
    const keyboard = modelPageKeyboard(1, models, 1, 25)
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some((b) => b.callback_data === "model:1:5")).toBe(true)
    expect(buttons.some((b) => b.callback_data === "model:1:9")).toBe(true)
  })

  test("adds Cancel to every model page", () => {
    const keyboard = modelPageKeyboard(1, models, 0, 25)
    expect(keyboard.inline_keyboard.flat()).toContainEqual({ text: "Cancel", callback_data: "modelc:1" })
  })

  test("adds Next on the first page", () => {
    const keyboard = modelPageKeyboard(1, models, 0, 25)
    const flat = keyboard.inline_keyboard.flat()
    expect(flat.some((b) => b.text === "Next" && b.callback_data === "modelp:1:1")).toBe(true)
    expect(flat.some((b) => b.text === "Previous")).toBe(false)
  })

  test("adds Previous and Next on middle pages", () => {
    const keyboard = modelPageKeyboard(2, models, 1, 25)
    const flat = keyboard.inline_keyboard.flat()
    expect(flat.some((b) => b.text === "Previous" && b.callback_data === "modelp:2:0")).toBe(true)
    expect(flat.some((b) => b.text === "Next" && b.callback_data === "modelp:2:2")).toBe(true)
  })

  test("adds Previous on the last page", () => {
    const keyboard = modelPageKeyboard(3, models, 4, 25)
    const flat = keyboard.inline_keyboard.flat()
    expect(flat.some((b) => b.text === "Previous")).toBe(true)
    expect(flat.some((b) => b.text === "Next")).toBe(false)
  })

  test("no navigation when everything fits on one page", () => {
    const keyboard = modelPageKeyboard(1, models, 0, MODEL_PAGE_SIZE)
    const flat = keyboard.inline_keyboard.flat()
    expect(flat.some((b) => b.text === "Next" || b.text === "Previous")).toBe(false)
  })
})

describe("renderQuestion", () => {
  const view = { header: "H", question: "Q", options: [{ label: "a", description: "" }] }

  test("asks to reply when there are no options", () => {
    expect(renderQuestion({ header: "H", question: "Q", options: [] })).toContain(
      "Reply to this message with your answer.",
    )
  })

  test("adds the custom hint when custom answers are allowed", () => {
    expect(renderQuestion({ ...view, custom: true })).toContain(
      "Or reply to this message with your answer.",
    )
  })

  test("omits the custom hint by default", () => {
    expect(renderQuestion(view)).not.toContain("Or reply")
  })
})

describe("renderQuestionWithSelection", () => {
  test("appends the selection state", () => {
    const text = renderQuestionWithSelection(
      { header: "H", question: "Q", options: [{ label: "a", description: "" }] },
      ["a", "b"],
    )
    expect(text).toContain("Selected: a, b")
  })

  test("shows none when nothing is selected", () => {
    const text = renderQuestionWithSelection(
      { header: "H", question: "Q", options: [{ label: "a", description: "" }] },
      [],
    )
    expect(text).toContain("Selected: (none)")
  })
})

describe("editDelay", () => {
  test("allows an immediate first edit", () => {
    expect(editDelay(0, Date.now())).toBe(0)
  })

  test("waits for the remaining interval", () => {
    const now = Date.now()
    expect(editDelay(now - 400, now)).toBe(EDIT_MIN_INTERVAL_MS - 400)
  })

  test("allows edits after the interval has passed", () => {
    const now = Date.now()
    expect(editDelay(now - EDIT_MIN_INTERVAL_MS - 100, now)).toBe(0)
  })
})

describe("nextProgressEdit", () => {
  const base = {
    text: "hello",
    reasoning: "",
    activity: Option.none(),
    lastSent: "Working…",
    dirty: true,
  }

  test("proposes an edit when the content changed", () => {
    expect(nextProgressEdit(base)).toEqual(Option.some("hello"))
  })

  test("proposes nothing when not dirty", () => {
    expect(nextProgressEdit({ ...base, dirty: false })).toEqual(Option.none())
  })

  test("proposes nothing when the text equals the last sent text", () => {
    expect(nextProgressEdit({ ...base, lastSent: "hello" })).toEqual(Option.none())
  })

  test("proposes nothing for an empty first tick (same as the working message)", () => {
    expect(
      nextProgressEdit({
        text: "",
        reasoning: "",
        activity: Option.none(),
        lastSent: "Working…",
        dirty: true,
      }),
    ).toEqual(Option.none())
  })
})

describe("matchesSessionRoute", () => {
  test("matches only the source chat and topic", () => {
    const route = { chatId: 7, threadId: 42 }
    expect(matchesSessionRoute(route, 7, 42)).toBe(true)
    expect(matchesSessionRoute(route, 8, 42)).toBe(false)
    expect(matchesSessionRoute(route, 7, 99)).toBe(false)
    expect(matchesSessionRoute(route, 7)).toBe(false)
  })

  test("matches a source chat without a topic", () => {
    expect(matchesSessionRoute({ chatId: 7 }, 7)).toBe(true)
    expect(matchesSessionRoute({ chatId: 7 }, 7, 42)).toBe(false)
  })
})

describe("mediaFromResponseText", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")

  test("reads an absolute-path media contract and removes it from text", async () => {
    const path = `/tmp/telegram-media-test-${process.pid}.png`
    await Bun.write(path, png)
    try {
      const result = await Effect.runPromise(mediaFromResponseText(
        `Here is the screenshot.\n<telegram-media>{"type":"file","path":"${path}","mime":"image/png","name":"screen.png"}</telegram-media>\n<telegram-media>{"type":"file","path":"${path}","mime":"image/png","name":"screen.png"}</telegram-media>`,
      ).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)))
      expect(result.text).toBe("Here is the screenshot.")
      expect(result.media).toHaveLength(1)
      expect(result.media[0]?.name).toBe("screen.png")
      expect(result.media[0]?.mime).toBe("image/png")
      expect(result.media[0]?.bytes.length).toBeGreaterThan(0)
    } finally {
      await unlink(path).catch(() => undefined)
    }
  })

  test("rejects a non-media file even when it declares an image MIME type", async () => {
    const path = `/tmp/telegram-media-test-${process.pid}.txt`
    await Bun.write(path, "private text")
    try {
      const result = await Effect.runPromise(mediaFromResponseText(
        `<telegram-media>{"type":"file","path":"${path}","mime":"image/png","name":"screen.png"}</telegram-media>`,
      ).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)))
      expect(result.media).toEqual([])
    } finally {
      await unlink(path).catch(() => undefined)
    }
  })

  test("rejects a supported file when its declared MIME type does not match its bytes", async () => {
    const path = `/tmp/telegram-media-test-${process.pid}-mismatch.png`
    await Bun.write(path, png)
    try {
      const result = await Effect.runPromise(mediaFromResponseText(
        `<telegram-media>{"type":"file","path":"${path}","mime":"video/mp4","name":"clip.mp4"}</telegram-media>`,
      ).pipe(Effect.provide(BunFileSystem.layer), Effect.provide(BunPath.layer)))
      expect(result.media).toEqual([])
    } finally {
      await unlink(path).catch(() => undefined)
    }
  })

  test("validates supported image and video containers", () => {
    expect(detectSupportedMediaMime(png)).toBe("image/png")
    expect(detectSupportedMediaMime(Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=", "base64"))).toBe("image/jpeg")
    expect(detectSupportedMediaMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x18, 0x53, 0x80, 0x67, 0x77, 0x65, 0x62, 0x6d, 0x1f, 0x43, 0xb6, 0x75]))).toBe("video/webm")
    expect(detectSupportedMediaMime(Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0, 0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]))).toBe("video/mp4")
    expect(detectSupportedMediaMime(Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))).toBeUndefined()
    expect(detectSupportedMediaMime(Buffer.from("iVBORw0KGgo=", "base64"))).toBeUndefined()
    expect(detectSupportedMediaMime(new TextEncoder().encode("plain text"))).toBeUndefined()
  })

  test("caps the number of persisted media artifacts", async () => {
    const contracts = Array.from({ length: 12 }, (_, index) => {
      const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")
      bytes[13] = index
      const data = `data:image/gif;base64,${bytes.toString("base64")}`
      return `<telegram-media>{"type":"file","uri":"${data}","mime":"image/gif","name":"image-${index}.gif"}</telegram-media>`
    }).join("\n")
    const result = await Effect.runPromise(mediaFromResponseText(contracts).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ))
    expect(result.media).toHaveLength(10)
  })
})

describe("assistantResponseForInput", () => {
  const messages = [
    { id: "assistant-newest", type: "assistant", content: [{ type: "text", text: "final response" }] },
    { id: "assistant-new", type: "assistant", content: [{ type: "text", text: "tool step" }] },
    { id: "input-new", type: "user", content: [] },
    { id: "assistant-old", type: "assistant", content: [{ type: "text", text: "old response" }] },
    { id: "input-old", type: "user", content: [] },
  ]

  test("selects only the assistant response after the accepted input", () => {
    expect(assistantResponseForInput(messages, "input-new")).toBe("tool step\n\nfinal response")
    expect(assistantResponseForInput(messages, "input-old")).toBe("old response")
  })

  test("does not fall back to an older assistant response", () => {
    expect(assistantResponseForInput(messages.slice(2), "input-new")).toBeUndefined()
    expect(assistantResponseForInput(messages, "missing-input")).toBeUndefined()
  })

  test("recovers media contracts from the complete assistant turn", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const turn = [
      { id: "assistant", type: "assistant", content: [{ type: "text", text: `Done\n<telegram-media>{"type":"file","uri":"data:image/png;base64,${png}","mime":"image/png","name":"done.png"}</telegram-media>` }] },
      { id: "input", type: "user", content: [] },
    ]
    const response = await Effect.runPromise(recoveredResponseForInput(turn, "input").pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ))
    expect(Option.isSome(response)).toBe(true)
    if (Option.isSome(response)) {
      expect(response.value.text).toBe("Done")
      expect(response.value.media).toHaveLength(1)
    }
  })

  test("recovers tool media when the assistant turn has no text", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const turn = [
      { id: "assistant", type: "assistant", content: [{
        type: "tool",
        state: { content: [{ type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "tool.png" }] },
      }] },
      { id: "input", type: "user", content: [] },
    ]
    const response = await Effect.runPromise(recoveredResponseForInput(turn, "input").pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ))
    expect(Option.isSome(response)).toBe(true)
    if (Option.isSome(response)) expect(response.value.media).toHaveLength(1)
  })

  test("pages beyond the newest 100 messages to recover the accepted input", async () => {
    const newest = Array.from({ length: 100 }, (_, index) => ({
      id: `assistant-${index}`,
      type: "assistant",
      content: [{ type: "text", text: index === 99 ? "Recovered answer" : "" }],
    }))
    const cursors: Array<string | undefined> = []
    const response = await Effect.runPromise(recoveredResponseFromPages("accepted-input", (cursor) => {
      cursors.push(cursor)
      return Effect.succeed(cursor === undefined
        ? { data: newest, cursor: { next: "older-page" } }
        : { data: [{ id: "accepted-input", type: "user", content: [] }], cursor: {} })
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ))
    expect(cursors).toEqual([undefined, "older-page"])
    expect(Option.isSome(response) && response.value.text).toContain("Recovered answer")
  })

  test("bounds recovery when the accepted input is absent", async () => {
    let calls = 0
    const response = await Effect.runPromise(recoveredResponseFromPages("missing", () => {
      calls += 1
      return Effect.succeed({ data: [], cursor: { next: `page-${calls}` } })
    }).pipe(
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ))
    expect(response).toEqual(Option.none())
    expect(calls).toBe(MAX_RECOVERY_MESSAGE_PAGES)
  })
})

describe("renderChangesSummary", () => {
  const base: ChangesSummary = {
    branch: Option.some("main"),
    commit: Option.some("abc1234"),
    files: [],
    insertions: Option.some(0),
    deletions: Option.some(0),
    binaryFiles: 0,
  }

  test("shows the clean working tree state", () => {
    const text = Option.getOrThrow(renderChangesSummary({ kind: "summary", summary: base }))
    expect(text).toContain("Current changes")
    expect(text).toContain("Branch: main @ abc1234")
    expect(text).toContain("Clean working tree")
  })

  test("lists changed files with Git status columns and the tracked diff", () => {
    const text = Option.getOrThrow(renderChangesSummary({
      kind: "summary",
      summary: {
        ...base,
        files: [
          { path: "src/a.ts", status: "M " },
          { path: "src/b.ts", status: " M" },
          { path: "test/new.test.ts", status: "??" },
        ],
        insertions: Option.some(84),
        deletions: Option.some(17),
      },
    }))
    expect(text).toContain("Files: 3 changed")
    expect(text).toContain("Tracked diff: +84 -17")
    expect(text).toContain("M  src/a.ts")
    expect(text).toContain(" M src/b.ts")
    expect(text).toContain("?? test/new.test.ts")
  })

  test("omits the tracked diff when line statistics are unavailable", () => {
    const text = Option.getOrThrow(renderChangesSummary({
      kind: "summary",
      summary: { ...base, insertions: Option.none(), deletions: Option.none() },
    }))
    expect(text).not.toContain("Tracked diff")
  })

  test("caps the file list and reports the remainder", () => {
    const files = Array.from({ length: 12 }, (_, index) => ({ path: `file-${index}.ts`, status: "??" }))
    const text = Option.getOrThrow(renderChangesSummary({ kind: "summary", summary: { ...base, files } }))
    expect(text).toContain("… and 4 more")
  })

  test("reports binary files", () => {
    const text = Option.getOrThrow(renderChangesSummary({
      kind: "summary",
      summary: { ...base, files: [{ path: "logo.png", status: "M " }], binaryFiles: 1 },
    }))
    expect(text).toContain("Binary files: 1")
  })

  test("shows a detached HEAD", () => {
    const text = Option.getOrThrow(renderChangesSummary({
      kind: "summary",
      summary: { ...base, branch: Option.none() },
    }))
    expect(text).toContain("detached HEAD")
  })

  test("escapes control characters in file names", () => {
    const text = Option.getOrThrow(renderChangesSummary({
      kind: "summary",
      summary: { ...base, files: [{ path: "bad\u0001name.ts", status: "??" }] },
    }))
    expect(text).toContain("?? bad?name.ts")
    expect(text).not.toContain("\u0001")
  })

  test("returns none outside a repository", () => {
    expect(renderChangesSummary({ kind: "none" })).toEqual(Option.none())
  })

  test("marks an unavailable summary", () => {
    expect(renderChangesSummary({ kind: "unavailable" })).toEqual(Option.some("Changes: unavailable."))
  })

  test("does not append when nothing should be shown", () => {
    expect(appendChangesSummary("Done.", { kind: "none" })).toBe("Done.")
  })

  test("keeps the final message within Telegram limits", () => {
    const long = "x".repeat(4000)
    const summary: ChangesSummary = {
      ...base,
      files: [{ path: "src/a.ts", status: "M " }],
      insertions: Option.some(10),
      deletions: Option.some(2),
    }
    const appended = appendChangesSummary(long, { kind: "summary", summary })
    expect(appended.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
    expect(appended).toContain("Current changes")
  })
})

describe("renderRunQueue", () => {
  test("shows the empty queue message", () => {
    expect(renderRunQueue([])).toBe("No runs queued for this session.")
  })

  test("renders the pipeline in order with human state labels", () => {
    const text = renderRunQueue([
      { id: "j1", state: "running", text: "Fix the model picker", movable: false },
      { id: "j2", state: "pending", text: "Add a diff command", movable: true },
      { id: "j3", state: "pending", text: "Bump the dependency", movable: true },
    ])
    expect(text).toContain("Queue for this session (2 queued)")
    expect(text).toContain("Running: \"Fix the model picker\"")
    expect(text).toContain("1. \"Add a diff command\"")
    expect(text).toContain("2. \"Bump the dependency\"")
  })

  test("labels starting and finishing states", () => {
    const text = renderRunQueue([
      { id: "j1", state: "dispatching", text: "Start", movable: false },
      { id: "j2", state: "finalizing", text: "Finish", movable: false },
    ])
    expect(text).toContain("Starting: \"Start\"")
    expect(text).toContain("Finishing: \"Finish\"")
  })

  test("marks an empty prompt", () => {
    const text = renderRunQueue([{ id: "j1", state: "running", text: "", movable: false }])
    expect(text).toContain("(empty prompt)")
  })

  test("truncates long prompts", () => {
    const text = renderRunQueue([{ id: "j1", state: "pending", text: "x".repeat(500), movable: true }])
    expect(text).toContain("truncated")
    expect(text.length).toBeLessThan(400)
  })

  test("collapses newlines in multi-line prompts", () => {
    const text = renderRunQueue([{ id: "j1", state: "pending", text: "line one\n\nline two", movable: true }])
    expect(text).toContain("\"line one line two\"")
    expect(text).toContain("1. \"line one line two\"")
  })

  test("keeps unknown states visible as-is", () => {
    expect(runQueueStateLabel("retrying")).toBe("retrying")
    expect(runQueueStateLabel("queued")).toBe("queued")
  })
})
