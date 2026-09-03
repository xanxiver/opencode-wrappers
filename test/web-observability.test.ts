import { describe, expect, test } from "bun:test"
import { aggregateObservability, type ObservableSession } from "../src/web/backend/observability"

const day = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 7, 10, 12)
const session = (input: Partial<ObservableSession> & Pick<ObservableSession, "id">): ObservableSession => {
  const value: ObservableSession = {
    id: input.id,
    projectID: input.projectID ?? "project-1",
    cost: input.cost ?? 0.25,
    tokens: input.tokens ?? { input: 100, output: 20, reasoning: 10, cache: { read: 40, write: 5 } },
    time: input.time ?? { created: now - day, updated: now - day },
    location: input.location ?? { directory: "/work/alpha" },
  }
  if (input.parentID !== undefined) Object.assign(value, { parentID: input.parentID })
  if (input.agent !== undefined) Object.assign(value, { agent: input.agent })
  if (input.model !== undefined) Object.assign(value, { model: input.model })
  return value
}

describe("aggregateObservability", () => {
  test("builds periods, daily activity, and ranked dimensions", () => {
    const snapshot = aggregateObservability([
      session({ id: "one", agent: "build", model: { providerID: "openai", id: "gpt-5" }, time: { created: now - day, updated: now - 2 * 60 * 60 * 1000 } }),
      session({ id: "two", parentID: "one", agent: "explore", model: { providerID: "openai", id: "gpt-5" }, tokens: { input: 300, output: 40, reasoning: 20, cache: { read: 70, write: 8 } }, location: { directory: "/work/beta" }, time: { created: now - 9 * day, updated: now - 8 * day, archived: now - day } }),
    ], ["one"], now)

    expect(snapshot).toMatchObject({ sessions: 2, primarySessions: 1, subagentSessions: 1, archivedSessions: 1, activeSessions: 1, workspaces: 2, models: 1, agents: 2 })
    expect(snapshot.tokens).toMatchObject({ input: 400, output: 60, reasoning: 30, cacheRead: 110, cacheWrite: 13, total: 490 })
    expect(snapshot.today.sessions).toBe(1)
    expect(snapshot.lastWeek.sessions).toBe(1)
    expect(snapshot.lastMonth.sessions).toBe(2)
    expect(snapshot.daily.reduce((total, point) => total + point.sessions, 0)).toBe(2)
    expect(snapshot.topModels[0]).toMatchObject({ id: "openai/gpt-5", sessions: 2, tokens: 490, active: 1 })
    expect(snapshot.topWorkspaces.map((row) => row.label)).toEqual(["beta", "alpha"])
  })
})
