import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Ref } from "effect"
import { OpenCodeError } from "../src/core/opencode.js"
import { applyRunSelectionUsing, ModelSwitchError } from "../src/telegram/run.js"

describe("applyRunSelectionUsing", () => {
  test("applies the accepted agent before the accepted model", async () => {
    const order = await Effect.runPromise(Ref.make<string[]>([]))

    await Effect.runPromise(applyRunSelectionUsing({
      switchAgent: ({ agent }) => Ref.update(order, (current) => [...current, `agent:${agent}`]),
      switchModel: ({ model }) => Ref.update(order, (current) => [...current, `model:${model.id}`]),
    }, {
      sessionID: "ses_1",
      agent: "build",
      model: { id: "accepted-model", providerID: "provider" },
    }))

    expect(await Effect.runPromise(Ref.get(order))).toEqual([
      "agent:build",
      "model:accepted-model",
    ])
  })

  test("fails with a typed error when the model snapshot cannot be applied", async () => {
    const exit = await Effect.runPromiseExit(applyRunSelectionUsing({
      switchAgent: () => Effect.void,
      switchModel: () => Effect.fail(new OpenCodeError({
        operation: "switch model",
        cause: new Error("unavailable"),
      })),
    }, {
      sessionID: "ses_1",
      model: { id: "accepted-model", providerID: "provider" },
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(ModelSwitchError)
    }
  })
})
