import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { AppViewModelError, json, makeAppEffectRunner, refreshAccessToken, WebApiClientLive } from "../src/web/state/api-client.js"

type TestFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

const apiLayer = (fetch: TestFetch) => WebApiClientLive.pipe(
  // SAFETY: TestFetch implements the callable fetch contract; the browser preconnect member is unused by these tests.
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
)

describe("web API client", () => {
  const OkResponse = Schema.Struct({ ok: Schema.Boolean })

  test("interrupts managed browser effects when the runner closes", async () => {
    const runner = makeAppEffectRunner()
    const cleaned = Effect.runSync(Deferred.make<void>())
    runner.fork(Effect.never.pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))))
    await Effect.runPromise(Effect.yieldNow)
    runner.close()
    await Effect.runPromise(Deferred.await(cleaned))
  })

  test("coalesces concurrent refresh requests", async () => {
    let calls = 0
    const fetch: TestFetch = async () => {
      calls += 1
      await Promise.resolve()
      return new Response(null, { status: 204 })
    }
    const result = await Effect.runPromise(Effect.all([refreshAccessToken, refreshAccessToken], { concurrency: 2 }).pipe(
      Effect.provide(apiLayer(fetch)),
    ))
    expect(result).toEqual([true, true])
    expect(calls).toBe(1)
  })

  test("refreshes once after an unauthorized request and retries it", async () => {
    const calls: string[] = []
    const fetch: TestFetch = async (input) => {
      calls.push(String(input))
      if (calls.length === 1) return new Response(JSON.stringify({ error: "expired" }), { status: 401 })
      if (calls.length === 2) return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    const result = await Effect.runPromise(json("/api/projects", OkResponse).pipe(Effect.provide(apiLayer(fetch))))
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(["http://localhost/api/projects", "http://localhost/api/auth/refresh", "http://localhost/api/projects"])
  })

  test("rejects a successful response that does not match the endpoint schema", async () => {
    const fetch: TestFetch = async () =>
      new Response(JSON.stringify({ ok: "yes" }), { status: 200 })
    const error = await Effect.runPromise(Effect.flip(json("/api/projects", OkResponse)).pipe(
      Effect.provide(apiLayer(fetch)),
    ))
    expect(error).toBeInstanceOf(AppViewModelError)
    expect(error.operation).toBe("decode API response from /api/projects")
  })

  test("reports an invalid request URL as a typed failure", async () => {
    const fetch: TestFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    const error = await Effect.runPromise(Effect.flip(json("http://[", OkResponse)).pipe(
      Effect.provide(apiLayer(fetch)),
    ))
    expect(error).toBeInstanceOf(AppViewModelError)
    expect(error.operation).toBe("build API request URL")
  })

  test("returns a typed error when the request timeout aborts fetch", async () => {
    const fetch: TestFetch = async (_input, init) => {
      if (init?.signal?.aborted) throw new Error("aborted")
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
      return new Response()
    }
    const cause = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(json("/api/projects", Schema.Unknown)))
      yield* Effect.yieldNow
      yield* TestClock.adjust("90 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(apiLayer(fetch)), Effect.provide(TestClock.layer())))
    expect(cause).toBeInstanceOf(AppViewModelError)
    if (cause instanceof AppViewModelError) expect(cause.message).toContain("timed out after 90 seconds")
  })

  test("propagates caller cancellation to fetch", async () => {
    const fetch: TestFetch = async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true })
      })
      return new Response()
    }
    const controller = new AbortController()
    try {
      const request = Effect.runPromise(json("/api/projects", Schema.Unknown, { signal: controller.signal }).pipe(
        Effect.provide(apiLayer(fetch)),
      ))
      controller.abort()
      await request
      expect(false).toBe(true)
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppViewModelError)
      if (cause instanceof AppViewModelError) expect(cause.message).toContain("caller aborted")
    }
  })
})
