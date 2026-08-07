import { describe, expect, test } from "bun:test"
import { toFileAttachment } from "../src/core/attachments.js"

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe("toFileAttachment", () => {
  test("builds a data URI with the correct mime and base64 content", () => {
    const attachment = { name: "hello.md", bytes: text("hello world"), mime: "text/markdown" }
    const file = toFileAttachment(attachment)
    expect(file.uri).toBe(`data:text/markdown;base64,${btoa("hello world")}`)
    expect(file.name).toBe("hello.md")
  })

  test("round-trips binary content", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])
    const file = toFileAttachment({ name: "img.png", bytes, mime: "image/png" })
    expect(file.uri.startsWith("data:image/png;base64,")).toBe(true)
    const encoded = file.uri.slice("data:image/png;base64,".length)
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  test("keeps the original name", () => {
    const file = toFileAttachment({ name: "report.PDF", bytes: text("%PDF-1.7"), mime: "application/pdf" })
    expect(file.name).toBe("report.PDF")
  })
})
