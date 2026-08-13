import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Form } from "@opencode-ai/client/effect"
import {
  normalizeBaseUrl,
  questionFormAnswer,
  questionRequestFromForm,
  shouldDiscoverOpenCodeService,
} from "../src/core/opencode.js"

const questionForm = Schema.decodeUnknownSync(Form.Info)({
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Choice",
      description: "Choose one",
      type: "string",
      options: [
        { value: "alpha-value", label: "Alpha", description: "Choose alpha" },
        { value: "beta-value", label: "Beta" },
      ],
      custom: true,
    },
    {
      key: "q1",
      title: "Tags",
      description: "Choose several",
      type: "multiselect",
      options: [
        { value: "one-value", label: "One" },
        { value: "two-value", label: "Two" },
      ],
      custom: false,
    },
  ],
})

describe("normalizeBaseUrl", () => {
  test("adds HTTP to a discovered host and port", async () => {
    const result = await Effect.runPromise(normalizeBaseUrl("127.0.0.1:49374"))
    expect(result).toBe("http://127.0.0.1:49374")
  })

  test("keeps explicit HTTP and HTTPS URLs", async () => {
    expect(await Effect.runPromise(normalizeBaseUrl("http://localhost:4096"))).toBe(
      "http://localhost:4096",
    )
    expect(await Effect.runPromise(normalizeBaseUrl("https://opencode.example.com"))).toBe(
      "https://opencode.example.com",
    )
  })

  test("rejects unsupported URL protocols", async () => {
    await expect(Effect.runPromise(normalizeBaseUrl("file:///tmp/opencode"))).rejects.toMatchObject({
      operation: "endpoint.url",
    })
  })
})

describe("shouldDiscoverOpenCodeService", () => {
  test("does not discover when an explicit endpoint is configured", () => {
    expect(shouldDiscoverOpenCodeService("https://opencode.example.com")).toBe(false)
  })

  test("discovers when no endpoint is configured", () => {
    expect(shouldDiscoverOpenCodeService(undefined)).toBe(true)
  })
})

describe("question form compatibility", () => {
  test("normalizes a V2 question form for existing clients", () => {
    expect(questionRequestFromForm(questionForm)).toEqual({
      id: "frm_1",
      sessionID: "ses_1",
      questions: [
        {
          header: "Choice",
          question: "Choose one",
          options: [
            { label: "Alpha", description: "Choose alpha" },
            { label: "Beta", description: "" },
          ],
          custom: true,
          multiple: false,
        },
        {
          header: "Tags",
          question: "Choose several",
          options: [
            { label: "One", description: "" },
            { label: "Two", description: "" },
          ],
          custom: false,
          multiple: true,
        },
      ],
    })
  })

  test("ignores forms that were not created by the question tool", () => {
    expect(questionRequestFromForm({ ...questionForm, metadata: { kind: "other" } })).toBeUndefined()
  })

  test("converts labels and custom answers to keyed form values", () => {
    expect(questionFormAnswer(questionForm, [["Beta"], ["One", "custom"]])).toEqual({
      q0: "beta-value",
      q1: ["one-value", "custom"],
    })
  })
})
