import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Session } from "@opencode-ai/client/effect"
import { OpenCodeError, rootSessionID } from "../src/core/opencode.js"
import { sessionRequestMatchesRoute } from "../src/telegram/run.js"

const sessionInfo = (id: string, parentID?: string) => {
  const base = {
    id,
    projectID: "project",
    location: { directory: "/tmp/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  return Schema.decodeUnknownSync(Session.Info)(parentID === undefined ? base : { ...base, parentID })
}

type SessionRow = readonly { readonly id: string; readonly parentID?: string }[]

const opencode = (rows: SessionRow) => {
  const byID = new Map(rows.map((row) => [row.id, row]))
  return {
    getSession: (sessionID: string) => {
      const row = byID.get(sessionID)
      return row === undefined
        ? Effect.fail(new OpenCodeError({ operation: "session.get", cause: new Error(`unknown session ${sessionID}`) }))
        : Effect.succeed(sessionInfo(row.id, row.parentID))
    },
  }
}

const routes = (map: Record<string, { readonly chatId: number; readonly threadId?: number }>) => ({
  getSessionRoute: (sessionID: string) => Effect.succeed(Option.fromNullishOr(map[sessionID])),
})

describe("rootSessionID", () => {
  test("resolves a session without a parent to itself", async () => {
    const result = await Effect.runPromise(rootSessionID(opencode([{ id: "ses_root" }]), "ses_root"))
    expect(result).toBe("ses_root")
  })

  test("climbs a child session to the root", async () => {
    const result = await Effect.runPromise(rootSessionID(
      opencode([{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }]),
      "ses_child",
    ))
    expect(result).toBe("ses_root")
  })

  test("climbs nested children to the root", async () => {
    const result = await Effect.runPromise(rootSessionID(
      opencode([
        { id: "ses_root" },
        { id: "ses_middle", parentID: "ses_root" },
        { id: "ses_leaf", parentID: "ses_middle" },
      ]),
      "ses_leaf",
    ))
    expect(result).toBe("ses_root")
  })

  test("propagates a missing session as a typed error", async () => {
    const failed = await Effect.runPromise(
      rootSessionID(opencode([{ id: "ses_root" }]), "ses_missing").pipe(Effect.isFailure),
    )
    expect(failed).toBe(true)
  })
})

describe("sessionRequestMatchesRoute", () => {
  const knownRoute = { chatId: 7, threadId: 42 }

  test("passes a session whose own route matches", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute }),
      opencode([{ id: "ses_root" }]),
      "ses_root",
      7,
      Option.some(42),
    ))
    expect(result).toBe(true)
  })

  test("rejects a session whose own route does not match", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute }),
      opencode([{ id: "ses_root" }]),
      "ses_root",
      7,
      Option.none(),
    ))
    expect(result).toBe(false)
  })

  test("accepts a child session climbing to a matching root route", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute }),
      opencode([{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }]),
      "ses_child",
      7,
      Option.some(42),
    ))
    expect(result).toBe(true)
  })

  test("uses the root topic when a child has a stale chat-level route", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute, ses_child: { chatId: 7 } }),
      opencode([{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }]),
      "ses_child",
      7,
      Option.some(42),
    ))
    expect(result).toBe(true)
  })

  test("accepts a nested child climbing to a matching root route", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute }),
      opencode([
        { id: "ses_root" },
        { id: "ses_middle", parentID: "ses_root" },
        { id: "ses_leaf", parentID: "ses_middle" },
      ]),
      "ses_leaf",
      7,
      Option.some(42),
    ))
    expect(result).toBe(true)
  })

  test("rejects a child whose root route does not match", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_root: knownRoute }),
      opencode([{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }]),
      "ses_child",
      9,
      Option.some(11),
    ))
    expect(result).toBe(false)
  })

  test("rejects a child whose root has no route", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({}),
      opencode([{ id: "ses_root" }, { id: "ses_child", parentID: "ses_root" }]),
      "ses_child",
      7,
      Option.some(42),
    ))
    expect(result).toBe(false)
  })

  test("keeps a foreign root session out even when it has its own route", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({ ses_other: { chatId: 99, threadId: 1 } }),
      opencode([{ id: "ses_other" }]),
      "ses_other",
      7,
      Option.some(42),
    ))
    expect(result).toBe(false)
  })

  test("returns false instead of failing when the tree lookup fails", async () => {
    const result = await Effect.runPromise(sessionRequestMatchesRoute(
      routes({}),
      opencode([]),
      "ses_unknown",
      7,
      Option.some(42),
    ))
    expect(result).toBe(false)
  })
})
