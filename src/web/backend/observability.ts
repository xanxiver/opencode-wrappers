import { basename } from "node:path"

export interface ObservableSession {
  readonly id: string
  readonly parentID?: string
  readonly projectID: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly location: { readonly directory: string }
}

export interface ObservabilityPeriod {
  readonly sessions: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cost: number
}

export interface ObservabilityBreakdown {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly sessions: number
  readonly tokens: number
  readonly active: number
}

const usageTokens = (session: ObservableSession): number => session.tokens.input + session.tokens.output + session.tokens.reasoning

const emptyPeriod = (): ObservabilityPeriod => ({ sessions: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

const periodTotals = (sessions: readonly ObservableSession[], start: number): ObservabilityPeriod => sessions
  .filter((session) => session.time.updated >= start)
  .reduce((total, session) => ({
    sessions: total.sessions + 1,
    input: total.input + session.tokens.input,
    output: total.output + session.tokens.output,
    reasoning: total.reasoning + session.tokens.reasoning,
    cacheRead: total.cacheRead + session.tokens.cache.read,
    cacheWrite: total.cacheWrite + session.tokens.cache.write,
    cost: total.cost + session.cost,
  }), emptyPeriod())

const breakdown = (
  sessions: readonly ObservableSession[],
  activeIDs: ReadonlySet<string>,
  identify: (session: ObservableSession) => { readonly id: string; readonly label: string; readonly detail?: string },
  limit = 5,
): readonly ObservabilityBreakdown[] => {
  const rows = new Map<string, ObservabilityBreakdown>()
  for (const session of sessions) {
    const identity = identify(session)
    const current = rows.get(identity.id)
    rows.set(identity.id, {
      ...identity,
      sessions: (current?.sessions ?? 0) + 1,
      tokens: (current?.tokens ?? 0) + usageTokens(session),
      active: (current?.active ?? 0) + Number(activeIDs.has(session.id)),
    })
  }
  return [...rows.values()].sort((left, right) => right.tokens - left.tokens || right.sessions - left.sessions || left.label.localeCompare(right.label)).slice(0, limit)
}

export const aggregateObservability = (sessions: readonly ObservableSession[], activeSessionIDs: readonly string[], now = Date.now()) => {
  const activeIDs = new Set(activeSessionIDs)
  const dayStart = new Date(now)
  dayStart.setUTCHours(0, 0, 0, 0)
  const day = 24 * 60 * 60 * 1000
  const totals = periodTotals(sessions, Number.NEGATIVE_INFINITY)
  const daily = Array.from({ length: 14 }, (_, index) => {
    const start = dayStart.getTime() - (13 - index) * day
    const period = periodTotals(sessions.filter((session) => session.time.updated < start + day), start)
    return { date: start, sessions: period.sessions, tokens: period.input + period.output + period.reasoning, cost: period.cost }
  })
  const workspaces = new Set(sessions.map((session) => session.location.directory))
  const models = new Set(sessions.flatMap((session) => session.model === undefined ? [] : [`${session.model.providerID}/${session.model.id}`]))
  const agents = new Set(sessions.flatMap((session) => session.agent === undefined ? [] : [session.agent]))

  return {
    sessions: sessions.length,
    primarySessions: sessions.filter((session) => session.parentID === undefined).length,
    subagentSessions: sessions.filter((session) => session.parentID !== undefined).length,
    archivedSessions: sessions.filter((session) => session.time.archived !== undefined).length,
    activeSessions: activeSessionIDs.length,
    workspaces: workspaces.size,
    models: models.size,
    agents: agents.size,
    tokens: { ...totals, total: totals.input + totals.output + totals.reasoning },
    today: periodTotals(sessions, dayStart.getTime()),
    lastWeek: periodTotals(sessions, now - 7 * day),
    lastMonth: periodTotals(sessions, now - 30 * day),
    daily,
    topModels: breakdown(sessions.filter((session) => session.model !== undefined), activeIDs, (session) => ({
      id: `${session.model?.providerID}/${session.model?.id}`,
      label: session.model?.id ?? "Unknown model",
      detail: session.model?.providerID,
    })),
    topAgents: breakdown(sessions, activeIDs, (session) => ({ id: session.agent ?? "unassigned", label: session.agent ?? "Unassigned" })),
    topWorkspaces: breakdown(sessions, activeIDs, (session) => ({
      id: session.location.directory,
      label: basename(session.location.directory) || session.location.directory,
      detail: session.location.directory,
    })),
  }
}
