import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EDIT_MIN_INTERVAL_MS, editDelay } from "../src/telegram/api.js"
import { nextProgressEdit } from "../src/telegram/run.js"
import {
  MAX_MESSAGE_LENGTH,
  MODEL_PAGE_SIZE,
  REASONING_DISPLAY_LIMIT,
  modelPageKeyboard,
  normalizeCommand,
  parseModelCallback,
  parseModelPageCallback,
  parseModelVariantCallback,
  parsePermissionCallback,
  parsePromptCommand,
  parseQuestionCallback,
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
    expect(renderModelPageHeader(0, 25)).toBe("Select a model (page 1 of 3, 1-10 of 25):")
    expect(renderModelPageHeader(2, 25)).toBe("Select a model (page 3 of 3, 21-25 of 25):")
  })
})

describe("modelPageKeyboard", () => {
  const models = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, providerID: "p" }))

  test("builds model buttons with per-model callback data", () => {
    const keyboard = modelPageKeyboard(1, models, 0, 25)
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some((b) => b.callback_data === "model:1:0")).toBe(true)
    expect(buttons.some((b) => b.callback_data === "model:1:9")).toBe(true)
  })

  test("uses absolute model indexes on later pages", () => {
    const keyboard = modelPageKeyboard(1, models, 1, 25)
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some((b) => b.callback_data === "model:1:10")).toBe(true)
    expect(buttons.some((b) => b.callback_data === "model:1:19")).toBe(true)
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
    const keyboard = modelPageKeyboard(3, models, 2, 25)
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
