import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { AppConfig } from "../src/config.js"
import {
  DEFAULT_YOMU_BASE_URL,
  buildYomuUrl,
  decodeYomuPayload,
  encodeYomuPayload,
  parseSharedKey,
  uploadYomuMedia,
} from "../src/core/yomu.js"
import { buildYomuLink } from "../src/telegram/run.js"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const hexKey = (byte: number) => Array.from({ length: 32 }, () => byte.toString(16).padStart(2, "0")).join("")
const base64UrlKey = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url")

const config = (overrides: {
  readonly yomuAesKey?: string
  readonly yomuUploadToken?: string
  readonly yomuBaseUrl?: string
} = {}) => new AppConfig({
  projectDirectory: "/tmp",
  stateFile: "/tmp/state.json",
  webDatabaseFile: "/tmp/web.sqlite",
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
  ...overrides,
})

const replaceFetch = <A>(stub: typeof fetch, run: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch
  globalThis.fetch = stub
  return run().finally(() => {
    globalThis.fetch = original
  })
}

/** Create a fetch double for upload tests. */
const stubFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch => {
  // SAFETY: the handler mirrors the global fetch call shape used by the upload client.
  return handler as typeof fetch
}

describe("yomu shared keys", () => {
  test("parses 64 hex chars and 43 base64url chars", () => {
    const hex = parseSharedKey(hexKey(0x2a))
    const base64 = parseSharedKey(base64UrlKey(0x2a))
    expect(Option.isSome(hex) && hex.value.byteLength).toBe(32)
    expect(Option.isSome(base64) && base64.value.byteLength).toBe(32)
    expect(Option.isSome(hex) && Option.isSome(base64) && hex.value.every((value, index) => value === base64.value[index])).toBe(true)
  })

  test("rejects empty, short, and padded keys", () => {
    expect(Option.isNone(parseSharedKey(""))).toBe(true)
    expect(Option.isNone(parseSharedKey(hexKey(1).slice(0, 62)))).toBe(true)
    expect(Option.isNone(parseSharedKey(base64UrlKey(1).slice(0, 42)))).toBe(true)
    expect(Option.isNone(parseSharedKey(`${base64UrlKey(1)}=`))).toBe(true)
  })
})

describe("yomu payload codec", () => {
  const sample = [
    "# Sample report",
    "",
    "A table and a diagram:",
    "",
    "| step | state |",
    "| --- | --- |",
    "| build | ✅ |",
    "",
    "```mermaid",
    "graph TD; A-->B;",
    "```",
    "",
    "Unicode: 日本語 — emoji 🚀",
  ].join("\n")

  test("round-trips a markdown message", async () => {
    const key = Option.getOrThrow(parseSharedKey(hexKey(7)))
    const payload = await run(encodeYomuPayload({ markdown: sample, key }))
    const restored = await run(decodeYomuPayload({ payload, key }))
    expect(restored).toBe(sample)
  })

  test("produces an unpadded base64url IV-prefixed payload", async () => {
    const key = Option.getOrThrow(parseSharedKey(hexKey(3)))
    const payload = await run(encodeYomuPayload({ markdown: "hello", key }))
    expect(payload).not.toContain("=")
    expect(payload).not.toContain("+")
    expect(payload).not.toContain("/")
    expect(Buffer.from(payload, "base64url").byteLength).toBeGreaterThan(12)
  })

  test("a wrong key cannot decode the payload", async () => {
    const key = Option.getOrThrow(parseSharedKey(hexKey(1)))
    const wrong = Option.getOrThrow(parseSharedKey(hexKey(2)))
    const payload = await run(encodeYomuPayload({ markdown: sample, key }))
    const exit = await Effect.runPromiseExit(decodeYomuPayload({ payload, key: wrong }))
    expect(exit._tag).toBe("Failure")
  })

  test("rejects a message over the Yomu markdown limit", async () => {
    const key = Option.getOrThrow(parseSharedKey(hexKey(5)))
    const page = "x".repeat(1024)
    const oversized = Array.from({ length: 257 }, () => page).join("")
    const exit = await Effect.runPromiseExit(encodeYomuPayload({ markdown: oversized, key }))
    expect(exit._tag).toBe("Failure")
  })
})

describe("yomu url", () => {
  test("defaults to the calm variant and the public base URL", () => {
    const url = new URL(buildYomuUrl({ payload: "abc" }))
    expect(url.origin + url.pathname).toBe(`${DEFAULT_YOMU_BASE_URL}/`)
    expect(url.searchParams.get("variant")).toBe("calm")
    expect(url.searchParams.get("m")).toBe("abc")
  })

  test("honours a custom variant and base URL", () => {
    const url = new URL(buildYomuUrl({ payload: "abc", variant: "term", baseUrl: "https://yomu.example" }))
    expect(url.origin).toBe("https://yomu.example")
    expect(url.searchParams.get("variant")).toBe("term")
  })
})

describe("yomu media upload", () => {
  test("presigns and uploads with the bearer token", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly authorization?: string; readonly contentType?: string }> = []
    const stub = stubFetch(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input)
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? undefined,
        contentType: headers.get("content-type") ?? undefined,
      })
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({
          uploadUrl: "https://r2.example/put?sig=1",
          objectUrl: "https://cdn.example/object.png",
        }), { status: 200 })
      }
      return new Response(null, { status: 200 })
    })

    const objectUrl = await replaceFetch(stub, () =>
      run(uploadYomuMedia({
        baseUrl: "https://yomu.reveshu.com",
        token: "upload-token",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mime: "image/png",
      })))

    expect(objectUrl).toBe("https://cdn.example/object.png")
    expect(calls).toHaveLength(2)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://yomu.reveshu.com/api/upload?type=image%2Fpng&size=4")
    expect(calls[0]?.authorization).toBe("Bearer upload-token")
    expect(calls[1]?.method).toBe("PUT")
    expect(calls[1]?.contentType).toBe("image/png")
  })

  test("fails when the presign is rejected", async () => {
    const stub = stubFetch(async () => new Response("no", { status: 401 }))
    const exit = await replaceFetch(stub, () =>
      Effect.runPromiseExit(uploadYomuMedia({
        baseUrl: "https://yomu.reveshu.com",
        token: "bad",
        bytes: new Uint8Array([1]),
        mime: "image/png",
      })))
    expect(exit._tag).toBe("Failure")
  })
})

describe("buildYomuLink", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

  test("returns none without a configured key", async () => {
    const result = await run(buildYomuLink({
      response: { rawText: "# Hello", placements: [] },
      toolMedia: [],
      config: config(),
    }))
    expect(Option.isNone(result)).toBe(true)
  })

  test("replaces markers with uploaded object urls and keeps untruncated text", async () => {
    const marker = `<telegram-media>{"type":"file","path":"/tmp/shot.png","mime":"image/png","name":"shot.png"}</telegram-media>`
    const rawText = `intro ${marker} outro`
    const media = {
      key: "/tmp/shot.png:image/png",
      name: "shot.png",
      mime: "image/png",
      bytes: pngBytes,
    }
    const calls: string[] = []
    const stub = stubFetch(async (input, init) => {
      calls.push(init?.method ?? "GET")
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({
          uploadUrl: "https://r2.example/put",
          objectUrl: "https://cdn.example/shot.png",
        }), { status: 200 })
      }
      return new Response(null, { status: 200 })
    })

    const url = await replaceFetch(stub, () =>
      run(buildYomuLink({
        response: {
          rawText,
          placements: [{
            start: "intro ".length,
            end: "intro ".length + marker.length,
            part: undefined,
            media,
          }],
        },
        toolMedia: [],
        config: config({ yomuAesKey: hexKey(9), yomuUploadToken: "token", yomuBaseUrl: "https://yomu.test" }),
      })))

    expect(calls).toEqual(["POST", "PUT"])
    expect(Option.isSome(url)).toBe(true)
    const link = new URL(Option.getOrThrow(url))
    expect(link.origin).toBe("https://yomu.test")
    const key = Option.getOrThrow(parseSharedKey(hexKey(9)))
    const markdown = await run(decodeYomuPayload({ payload: link.searchParams.get("m") ?? "", key }))
    expect(markdown).toBe("intro ![shot.png](https://cdn.example/shot.png) outro")
    expect(markdown).not.toContain("<telegram-media>")
  })

  test("drops markers when uploads are not configured", async () => {
    const marker = `<telegram-media>{"type":"file","path":"/tmp/shot.png","mime":"image/png","name":"shot.png"}</telegram-media>`
    const rawText = `intro ${marker} outro`
    const url = await run(buildYomuLink({
      response: {
        rawText,
        placements: [{
          start: "intro ".length,
          end: "intro ".length + marker.length,
          part: undefined,
          media: { key: "k", name: "shot.png", mime: "image/png", bytes: pngBytes },
        }],
      },
      toolMedia: [],
      config: config({ yomuAesKey: hexKey(11) }),
    }))
    const key = Option.getOrThrow(parseSharedKey(hexKey(11)))
    const markdown = await run(decodeYomuPayload({ payload: new URL(Option.getOrThrow(url)).searchParams.get("m") ?? "", key }))
    expect(markdown).toBe("intro  outro")
    expect(markdown).not.toContain("<telegram-media>")
    expect(markdown).not.toContain("[media:")
  })

  test("appends tool media that has no marker position", async () => {
    const stub = stubFetch(async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({
          uploadUrl: "https://r2.example/put",
          objectUrl: "https://cdn.example/extra.png",
        }), { status: 200 })
      }
      return new Response(null, { status: 200 })
    })
    const url = await replaceFetch(stub, () =>
      run(buildYomuLink({
        response: { rawText: "body", placements: [] },
        toolMedia: [{ key: "extra", name: "extra.png", mime: "image/png", bytes: pngBytes }],
        config: config({ yomuAesKey: hexKey(13), yomuUploadToken: "token" }),
      })))
    const key = Option.getOrThrow(parseSharedKey(hexKey(13)))
    const markdown = await run(decodeYomuPayload({ payload: new URL(Option.getOrThrow(url)).searchParams.get("m") ?? "", key }))
    expect(markdown).toBe("body\n\n---\n\n![extra.png](https://cdn.example/extra.png)")
  })
})
