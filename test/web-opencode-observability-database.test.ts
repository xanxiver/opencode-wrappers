import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { readOpenCodeObservabilitySessions } from "../src/web/backend/opencode-observability-database.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const makeDatabase = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kissa-opencode-observability-"))
  directories.push(directory)
  const path = join(directory, "opencode.db")
  const database = new Database(path)
  database.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      directory TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    )
  `)
  database.query(`
    INSERT INTO session (
      id, project_id, parent_id, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated, time_archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ses_child", "project", "ses_parent", "/work/project", "build", JSON.stringify({ id: "gpt-5", providerID: "openai" }), 1.25, 100, 20, 5, 40, 3, 10, 20, null)
  database.close()
  return path
}

describe("readOpenCodeObservabilitySessions", () => {
  test("reads usage fields from the configured OpenCode database", async () => {
    const path = await makeDatabase()
    const sessions = await Effect.runPromise(readOpenCodeObservabilitySessions(path))

    expect(sessions).toEqual([{
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "project",
      agent: "build",
      model: { id: "gpt-5", providerID: "openai" },
      cost: 1.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 3 } },
      time: { created: 10, updated: 20 },
      location: { directory: "/work/project" },
    }])
  })

  test("returns a typed failure when the configured database cannot be read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kissa-opencode-observability-missing-"))
    directories.push(directory)
    const exit = await Effect.runPromiseExit(readOpenCodeObservabilitySessions(join(directory, "missing.db")))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
