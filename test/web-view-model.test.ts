import { describe, expect, test } from "bun:test"
import { appStateAtom, isRetryableUserMessage, retainPromptEvidenceAfterFailure } from "../src/web/state/app-view-model.js"
import { AtomRegistry } from "effect/unstable/reactivity"

describe("retainPromptEvidenceAfterFailure", () => {
  test("keeps current busy and queue evidence until server reconciliation", () => {
    const registry = AtomRegistry.make()
    const current = {
      ...registry.get(appStateAtom),
      busy: true,
      queuedPrompts: [{ id: "local", sessionID: "ses_1", text: "next", attachments: [] }],
    }
    const next = retainPromptEvidenceAfterFailure(current, "send prompt failed")

    expect(next.busy).toBe(true)
    expect(next.queuedPrompts).toEqual(current.queuedPrompts)
    expect(next.error).toBe("send prompt failed")
  })
})

describe("isRetryableUserMessage", () => {
  test("does not keep an older prompt retryable after a later prompt", () => {
    const messages = [
      { type: "user", text: "first" },
      { type: "assistant", finish: "error", error: { message: "failed" } },
      { type: "user", text: "second" },
    ]

    expect(isRetryableUserMessage(messages, 0)).toBe(false)
    expect(isRetryableUserMessage(messages, 2)).toBe(false)
  })

  test("keeps a failed prompt retryable when it has no later prompt", () => {
    const messages = [
      { type: "user", text: "first" },
      { type: "assistant", finish: "error" },
    ]

    expect(isRetryableUserMessage(messages, 0)).toBe(true)
  })

  test("does not mark a successful response retryable", () => {
    const messages = [
      { type: "user", text: "first" },
      { type: "assistant", finish: "stop" },
    ]

    expect(isRetryableUserMessage(messages, 0)).toBe(false)
  })
})
