import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { normalizeBaseUrl } from "../src/core/opencode.js"

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
