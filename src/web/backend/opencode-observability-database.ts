import { Database } from "bun:sqlite"
import { Data, Effect, Schema } from "effect"
import type { ObservableSession } from "./observability.js"

interface SessionRow {
  readonly id: string
  readonly project_id: string
  readonly parent_id: string | null
  readonly directory: string
  readonly agent: string | null
  readonly model: string | null
  readonly cost: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly tokens_reasoning: number
  readonly tokens_cache_read: number
  readonly tokens_cache_write: number
  readonly time_created: number
  readonly time_updated: number
  readonly time_archived: number | null
}

export class OpenCodeObservabilityDatabaseError extends Data.TaggedError("OpenCodeObservabilityDatabaseError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const decodeModel = (value: string | null): ObservableSession["model"] => {
  if (value === null) return undefined
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ id: Schema.String, providerID: Schema.String })))(value)
  } catch {
    return undefined
  }
}

const toObservableSession = (row: SessionRow): ObservableSession => {
  const model = decodeModel(row.model)
  const session: ObservableSession = {
    id: row.id,
    projectID: row.project_id,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
    },
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
    location: { directory: row.directory },
  }
  if (row.parent_id !== null) Object.assign(session, { parentID: row.parent_id })
  if (row.agent !== null) Object.assign(session, { agent: row.agent })
  if (model !== undefined) Object.assign(session, { model })
  if (row.time_archived !== null) Object.assign(session.time, { archived: row.time_archived })
  return session
}

export const readOpenCodeObservabilitySessions = Effect.fn("OpenCodeObservabilityDatabase.readSessions")((path: string) =>
  Effect.try({
    try: () => {
      const database = new Database(path, { readonly: true })
      try {
        return database.query<SessionRow, []>(`
          SELECT id, project_id, parent_id, directory, agent, model, cost,
            tokens_input, tokens_output, tokens_reasoning,
            tokens_cache_read, tokens_cache_write,
            time_created, time_updated, time_archived
          FROM session
          ORDER BY time_updated DESC
        `).all().map(toObservableSession)
      } finally {
        database.close()
      }
    },
    catch: (cause) => new OpenCodeObservabilityDatabaseError({
      message: "could not read OpenCode observability data",
      cause,
    }),
  }),
)
