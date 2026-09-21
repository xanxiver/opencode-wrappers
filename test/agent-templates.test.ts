import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { AgentTemplates, Live as AgentTemplatesLive } from "../src/telegram/agent-templates.js"
import { InteractionStoreMemory } from "../src/telegram/interaction-store.js"

const layer = AgentTemplatesLive.pipe(Layer.provide(InteractionStoreMemory))

const run = <A, E>(effect: Effect.Effect<A, E, AgentTemplates>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

describe("AgentTemplates", () => {
  test("adds a pairing and creates the template on first use", async () => {
    const stored = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      const result = yield* templates.add({
        template: "Work",
        agentID: "build",
        model: { id: "model", providerID: "provider" },
      })
      return { result, entry: yield* templates.get("work") }
    }))
    expect(stored.result).toBe("created")
    expect(stored.entry).toEqual(
      Option.some({ build: { id: "model", providerID: "provider" } }),
    )
  })

  test("rejects a duplicate pairing without changing the stored model", async () => {
    const stored = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "one", providerID: "p" } })
      const result = yield* templates.add({ template: "work", agentID: "build", model: { id: "two", providerID: "p" } })
      return { result, entry: yield* templates.get("work") }
    }))
    expect(stored.result).toBe("exists")
    expect(stored.entry).toEqual(Option.some({ build: { id: "one", providerID: "p" } }))
  })

  test("replaces an existing pairing and reports missing entries", async () => {
    const stored = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      const missingTemplate = yield* templates.replace({
        template: "nope",
        agentID: "build",
        model: { id: "m", providerID: "p" },
      })
      yield* templates.add({ template: "work", agentID: "build", model: { id: "one", providerID: "p" } })
      const missingPairing = yield* templates.replace({
        template: "work",
        agentID: "plan",
        model: { id: "m", providerID: "p" },
      })
      const replaced = yield* templates.replace({
        template: "work",
        agentID: "build",
        model: { id: "two", providerID: "p", variant: "high" },
      })
      return { missingTemplate, missingPairing, replaced, entry: yield* templates.get("work") }
    }))
    expect(stored.missingTemplate).toBe("template-missing")
    expect(stored.missingPairing).toBe("pairing-missing")
    expect(stored.replaced).toBe("replaced")
    expect(stored.entry).toEqual(Option.some({ build: { id: "two", providerID: "p", variant: "high" } }))
  })

  test("removes the template after its last pairing is removed", async () => {
    const stored = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "build", model: { id: "one", providerID: "p" } })
      yield* templates.add({ template: "work", agentID: "plan", model: { id: "two", providerID: "p" } })
      const removed = yield* templates.removePairing({ template: "work", agentID: "plan" })
      const removedLast = yield* templates.removePairing({ template: "work", agentID: "build" })
      return { removed, removedLast, entry: yield* templates.get("work"), list: yield* templates.list() }
    }))
    expect(stored.removed).toBe("removed")
    expect(stored.removedLast).toBe("removed-template")
    expect(stored.entry).toEqual(Option.none())
    expect(stored.list).toEqual([])
  })

  test("reports missing templates and pairings on removal", async () => {
    const stored = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      const missingTemplate = yield* templates.removePairing({ template: "nope", agentID: "build" })
      const missingWhole = yield* templates.removeTemplate("nope")
      yield* templates.add({ template: "work", agentID: "build", model: { id: "one", providerID: "p" } })
      const missingPairing = yield* templates.removePairing({ template: "work", agentID: "plan" })
      const removed = yield* templates.removeTemplate("work")
      return { missingTemplate, missingWhole, missingPairing, removed }
    }))
    expect(stored.missingTemplate).toBe("template-missing")
    expect(stored.missingWhole).toBe("missing")
    expect(stored.missingPairing).toBe("pairing-missing")
    expect(stored.removed).toBe("removed")
  })

  test("lists templates and pairings in sorted order", async () => {
    const summaries = await run(Effect.gen(function* () {
      const templates = yield* AgentTemplates
      yield* templates.add({ template: "work", agentID: "plan", model: { id: "two", providerID: "p" } })
      yield* templates.add({ template: "audit", agentID: "build", model: { id: "one", providerID: "p" } })
      yield* templates.add({ template: "work", agentID: "build", model: { id: "one", providerID: "p" } })
      return yield* templates.list()
    }))
    expect(summaries.map((summary) => summary.name)).toEqual(["audit", "work"])
    expect(summaries[1]?.pairings.map((pairing) => pairing.agentID)).toEqual(["build", "plan"])
  })
})
