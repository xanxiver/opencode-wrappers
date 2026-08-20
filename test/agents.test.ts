import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { AGENT_PICKER_TTL_MS, AgentRegistry, Live as AgentRegistryLive } from "../src/telegram/agents.js"

describe("AgentRegistry", () => {
  test("binds a picker token to its Telegram message and consumes it once", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: [{ id: "build", name: "Build" }],
        chatId: 7,
        threadId: 42,
      })
      yield* registry.attachMessageId(token, 10)
      const wrongMessage = yield* registry.take(token, 7, 11)
      const selected = yield* registry.take(token, 7, 10)
      const consumed = yield* registry.take(token, 7, 10)
      return { wrongMessage, selected, consumed }
    }).pipe(Effect.provide(AgentRegistryLive)))

    expect(Option.isNone(result.wrongMessage)).toBe(true)
    expect(Option.getOrUndefined(result.selected)?.agents[0]?.id).toBe("build")
    expect(Option.isNone(result.consumed)).toBe(true)
  })

  test("cancels only the matching picker message", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: [{ id: "build", name: "Build" }],
        chatId: 7,
      })
      yield* registry.attachMessageId(token, 10)
      const wrongChat = yield* registry.cancel(token, 8, 10)
      const cancelled = yield* registry.cancel(token, 7, 10)
      return { wrongChat, cancelled }
    }).pipe(Effect.provide(AgentRegistryLive)))

    expect(Option.isNone(result.wrongChat)).toBe(true)
    expect(Option.isSome(result.cancelled)).toBe(true)
  })

  test("rejects and removes a picker callback after its ttl", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const registry = yield* AgentRegistry
      const token = yield* registry.register({
        sessionID: "ses_1",
        directory: "/work",
        agents: [{ id: "build", name: "Build" }],
        chatId: 7,
      })
      yield* registry.attachMessageId(token, 10)
      yield* TestClock.adjust(AGENT_PICKER_TTL_MS + 1)
      const expired = yield* registry.take(token, 7, 10)
      const removed = yield* registry.take(token, 7, 10)
      return { expired, removed }
    }).pipe(Effect.provide(AgentRegistryLive), Effect.provide(TestClock.layer())))

    expect(Option.isNone(result.expired)).toBe(true)
    expect(Option.isNone(result.removed)).toBe(true)
  })
})
