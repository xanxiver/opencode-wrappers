import { describe, expect, test } from "bun:test"
import { parseInlineParts } from "../src/web/components/message-content"

describe("local media references", () => {
  test("parses plain, Markdown, and file URL image references", () => {
    expect(parseInlineParts("/tmp/image.png")).toEqual([{ kind: "image", value: "/tmp/image.png", path: "/tmp/image.png" }])
    expect(parseInlineParts("![preview](../media/image.webp)")).toEqual([{ kind: "image", value: "preview", path: "../media/image.webp" }])
    expect(parseInlineParts("file:///tmp/image%20with%20spaces.jpg")).toEqual([{ kind: "image", value: "file:///tmp/image%20with%20spaces.jpg", path: "file:///tmp/image%20with%20spaces.jpg" }])
  })
})
