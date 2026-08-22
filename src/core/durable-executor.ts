import { Database } from "bun:sqlite"
import { Clock, Context, Crypto, Data, Effect, FileSystem, Layer, Option, Path } from "effect"
import { AppConfigTag, type AppConfig } from "../config.js"

export type DurableJobState =
  | "pending"
  | "dispatching"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_review"

export interface DurableJob {
  readonly id: string
  readonly sourceKey: string
  readonly channel: string
  readonly owner: string
  readonly payload: string
  readonly state: DurableJobState
  readonly attempt: number
  readonly availableAt: number
  readonly leaseGeneration?: string
  readonly leaseExpiresAt?: number
  readonly sessionID?: string
  readonly inputID?: string
  readonly progressMessageID?: number
  readonly deliveredMediaCount: number
  readonly mediaDeliveryIndex?: number
  readonly terminalResult?: string
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly queueOrder: number
}

export interface DurableJobLease {
  readonly job: DurableJob
  readonly generation: string
  readonly recoveredFrom: DurableJobState
}

export class DurableExecutorError extends Data.TaggedError("DurableExecutorError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class DurableLeaseLost extends Data.TaggedError("DurableLeaseLost")<{
  readonly jobID: string
}> {}

export interface DurableExecutorRepository {
  readonly submit: (input: {
    readonly sourceKey: string
    readonly channel: string
    readonly owner: string
    readonly payload: string
    readonly sessionID?: string
  }) => Effect.Effect<{ readonly job: DurableJob; readonly created: boolean }, DurableExecutorError>
  readonly claimNext: (channel: string) => Effect.Effect<Option.Option<DurableJobLease>, DurableExecutorError>
  readonly forceClaim: (
    channel: string,
    owner: string,
    replacementPayload?: string,
  ) => Effect.Effect<Option.Option<DurableJobLease>, DurableExecutorError>
  readonly renew: (jobID: string, generation: string) => Effect.Effect<boolean, DurableExecutorError>
  readonly markDispatching: (jobID: string, generation: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly markRunning: (jobID: string, generation: string, inputID?: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly markProgressMessage: (jobID: string, generation: string, messageID: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly beginProgressDelivery: (jobID: string, generation: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly markFinalizing: (jobID: string, generation: string, terminalResult: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly beginMediaDelivery: (jobID: string, generation: string, index: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly markMediaDelivered: (jobID: string, generation: string, count: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly complete: (jobID: string, generation: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly retry: (jobID: string, generation: string, lastError: string, delayMs: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly defer: (jobID: string, generation: string, lastError: string, delayMs: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  readonly fail: (jobID: string, generation: string, lastError: string, needsReview?: boolean) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Resolve a reviewed ambiguous job and scrub its retained diagnostic data. */
  readonly resolveReview: (jobID: string) => Effect.Effect<boolean, DurableExecutorError>
  /** Scrub sensitive evidence after the bounded manual-review window. */
  readonly purgeExpiredReviews: Effect.Effect<number, DurableExecutorError>
  readonly release: (jobID: string, generation: string) => Effect.Effect<void, DurableExecutorError>
  readonly releaseWorkerLeases: Effect.Effect<void, DurableExecutorError>
  readonly get: (jobID: string) => Effect.Effect<Option.Option<DurableJob>, DurableExecutorError>
  readonly listOwner: (channel: string, owner: string) => Effect.Effect<readonly DurableJob[], DurableExecutorError>
  /** Reorder unclaimed pending jobs for one owner using one-based positions. */
  readonly movePending: (
    channel: string,
    owner: string,
    from: number,
    to: number,
  ) => Effect.Effect<{ readonly moved: boolean; readonly count: number }, DurableExecutorError>
  /** Delete one unclaimed pending job for one owner by one-based position. */
  readonly deletePending: (
    channel: string,
    owner: string,
    position: number,
  ) => Effect.Effect<{ readonly deleted: boolean; readonly count: number }, DurableExecutorError>
  /** Delete every unclaimed pending job for one owner; returns the removed count. */
  readonly clearPending: (channel: string, owner: string) => Effect.Effect<number, DurableExecutorError>
}

export class DurableExecutorStore extends Context.Service<DurableExecutorStore, DurableExecutorRepository>()(
  "opencode2-uis/DurableExecutorStore",
) {}

export const DURABLE_JOB_LEASE_MS = 2 * 60 * 1000
export const NEEDS_REVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID = -1

interface JobRow {
  readonly id: string
  readonly source_key: string
  readonly channel: string
  readonly owner: string
  readonly payload: string
  readonly state: DurableJobState
  readonly attempt: number
  readonly available_at: number
  readonly lease_generation: string | null
  readonly lease_expires_at: number | null
  readonly session_id: string | null
  readonly input_id: string | null
  readonly progress_message_id: number | null
  readonly delivered_media_count: number
  readonly media_delivery_index: number | null
  readonly terminal_result: string | null
  readonly last_error: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly queue_order: number
}

const fromRow = (row: JobRow): DurableJob => {
  const job = {
    id: row.id,
    sourceKey: row.source_key,
    channel: row.channel,
    owner: row.owner,
    payload: row.payload,
    state: row.state,
    attempt: row.attempt,
    availableAt: row.available_at,
    deliveredMediaCount: row.delivered_media_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    queueOrder: row.queue_order,
  }
  if (row.lease_generation !== null) Object.assign(job, { leaseGeneration: row.lease_generation })
  if (row.lease_expires_at !== null) Object.assign(job, { leaseExpiresAt: row.lease_expires_at })
  if (row.session_id !== null) Object.assign(job, { sessionID: row.session_id })
  if (row.input_id !== null) Object.assign(job, { inputID: row.input_id })
  if (row.progress_message_id !== null) Object.assign(job, { progressMessageID: row.progress_message_id })
  if (row.media_delivery_index !== null) Object.assign(job, { mediaDeliveryIndex: row.media_delivery_index })
  if (row.terminal_result !== null) Object.assign(job, { terminalResult: row.terminal_result })
  if (row.last_error !== null) Object.assign(job, { lastError: row.last_error })
  return job
}

const migrate = (database: Database): void => {
  database.run("PRAGMA busy_timeout = 5000")
  database.run(`CREATE TABLE IF NOT EXISTS executor_jobs (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    owner TEXT NOT NULL,
    payload TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'needs_review')),
    attempt INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    lease_worker TEXT,
    lease_generation TEXT,
    lease_expires_at INTEGER,
    session_id TEXT,
    input_id TEXT,
    progress_message_id INTEGER,
    delivered_media_count INTEGER NOT NULL DEFAULT 0,
    media_delivery_index INTEGER,
    terminal_result TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    queue_order INTEGER,
    completed_at INTEGER
  )`)
  const columns = database.query<{ readonly name: string }, []>("PRAGMA table_info(executor_jobs)").all()
  if (!columns.some((column) => column.name === "progress_message_id")) {
    database.run("ALTER TABLE executor_jobs ADD COLUMN progress_message_id INTEGER")
  }
  if (!columns.some((column) => column.name === "delivered_media_count")) {
    database.run("ALTER TABLE executor_jobs ADD COLUMN delivered_media_count INTEGER NOT NULL DEFAULT 0")
  }
  if (!columns.some((column) => column.name === "media_delivery_index")) {
    database.run("ALTER TABLE executor_jobs ADD COLUMN media_delivery_index INTEGER")
  }
  if (!columns.some((column) => column.name === "queue_order")) {
    database.run("ALTER TABLE executor_jobs ADD COLUMN queue_order INTEGER")
  }
  database.run("UPDATE executor_jobs SET queue_order = rowid WHERE queue_order IS NULL")
  database.run("CREATE INDEX IF NOT EXISTS executor_jobs_claim ON executor_jobs(channel, state, available_at, created_at, id)")
  database.run("CREATE INDEX IF NOT EXISTS executor_jobs_owner ON executor_jobs(channel, owner, state, created_at, id)")
  database.run("CREATE INDEX IF NOT EXISTS executor_jobs_queue ON executor_jobs(channel, owner, state, queue_order)")
}

export const openDurableExecutorDatabase = (path: string): Database => {
  const database = new Database(path, { create: true })
  try {
    migrate(database)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

export const DurableExecutorStoreLive: Layer.Layer<
  DurableExecutorStore,
  DurableExecutorError,
  AppConfig | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> = Layer.effect(
  DurableExecutorStore,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const crypto = yield* Crypto.Crypto
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const workerID = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new DurableExecutorError({ operation: "generate worker id", cause })),
    )
    const fail = (operation: string, cause: unknown) => new DurableExecutorError({ operation, cause })
    yield* fs.makeDirectory(paths.dirname(config.webDatabaseFile), { recursive: true }).pipe(
      Effect.mapError((cause) => fail("create executor database directory", cause)),
    )
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Database(config.webDatabaseFile, { create: true }),
        catch: (cause) => fail("open executor database", cause),
      }),
      (database) => Effect.sync(() => database.close()),
    )
    yield* Effect.try({ try: () => migrate(database), catch: (cause) => fail("migrate executor database", cause) })
    yield* fs.chmod(config.webDatabaseFile, 0o600).pipe(
      Effect.mapError((cause) => fail("secure executor database permissions", cause)),
    )
    const withDatabase = <A>(operation: string, action: () => A): Effect.Effect<A, DurableExecutorError> =>
      Effect.try({ try: action, catch: (cause) => cause instanceof DurableExecutorError ? cause : fail(operation, cause) })
    const transaction = <A>(action: () => A): A => {
      database.run("BEGIN IMMEDIATE")
      try {
        const value = action()
        database.run("COMMIT")
        return value
      } catch (cause) {
        database.run("ROLLBACK")
        throw cause
      }
    }
    const selectByID = (id: string): JobRow | null =>
      database.query<JobRow, [string]>("SELECT * FROM executor_jobs WHERE id = ?").get(id)
    const transition = (
      operation: string,
      jobID: string,
      generation: string,
      sql: string,
      values: readonly (string | number | null)[],
    ): Effect.Effect<void, DurableExecutorError | DurableLeaseLost> =>
      Effect.try({
        try: () => {
          const result = database.query(sql).run(...values, jobID, generation)
          if (result.changes === 0) throw new DurableLeaseLost({ jobID })
        },
        catch: (cause) => cause instanceof DurableLeaseLost ? cause : fail(operation, cause),
      })

    return {
      submit: (input) => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => fail("generate job id", cause)))
        return yield* withDatabase("submit durable job", () => transaction(() => {
          const existing = database.query<JobRow, [string]>("SELECT * FROM executor_jobs WHERE source_key = ?").get(input.sourceKey)
          if (existing !== null) return { job: fromRow(existing), created: false }
          database.query(`INSERT INTO executor_jobs (
            id, source_key, channel, owner, payload, state, attempt, available_at, session_id, created_at, updated_at, queue_order
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, (SELECT COALESCE(MAX(queue_order), 0) + 1 FROM executor_jobs))`).run(
            id,
            input.sourceKey,
            input.channel,
            input.owner,
            input.payload,
            now,
            input.sessionID ?? null,
            now,
            now,
          )
          const row = selectByID(id)
          if (row === null) throw fail("read submitted durable job", new Error("inserted job is missing"))
          return { job: fromRow(row), created: true }
        }))
      }),
      claimNext: (channel) => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const generation = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => fail("generate lease id", cause)))
        return yield* withDatabase("claim durable job", () => transaction(() => {
          const row = database.query<JobRow, [string, number, number, number]>(`SELECT candidate.* FROM executor_jobs candidate
            WHERE candidate.channel = ?
              AND candidate.state IN ('pending', 'dispatching', 'running', 'finalizing')
              AND candidate.available_at <= ?
              AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < ?)
              AND (
                candidate.state <> 'pending'
                OR NOT EXISTS (
                  SELECT 1 FROM executor_jobs predecessor
                  WHERE predecessor.channel = candidate.channel
                    AND predecessor.owner = candidate.owner
                    AND predecessor.state IN ('pending', 'dispatching', 'running', 'finalizing')
                    AND (
                       predecessor.queue_order < candidate.queue_order
                       OR (predecessor.queue_order = candidate.queue_order AND predecessor.rowid < candidate.rowid)
                    )
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM executor_jobs active
                WHERE active.channel = candidate.channel
                  AND active.owner = candidate.owner
                  AND active.id <> candidate.id
                  AND active.state IN ('dispatching', 'running', 'finalizing')
                  AND active.lease_expires_at >= ?
              )
            ORDER BY CASE candidate.state WHEN 'pending' THEN 1 ELSE 0 END, candidate.queue_order, candidate.rowid
            LIMIT 1`).get(channel, now, now, now)
          if (row === null) return Option.none<DurableJobLease>()
          const updated = database.query(`UPDATE executor_jobs SET
            attempt = attempt + 1, lease_worker = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
            WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)`).run(
            workerID,
            generation,
            now + DURABLE_JOB_LEASE_MS,
            now,
            row.id,
            now,
          )
          if (updated.changes === 0) return Option.none<DurableJobLease>()
          const claimed = selectByID(row.id)
          if (claimed === null) throw fail("read claimed durable job", new Error("claimed job is missing"))
          return Option.some({ job: fromRow(claimed), generation, recoveredFrom: row.state })
        }))
      }),
      forceClaim: (channel, owner, replacementPayload) => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const generation = yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => fail("generate forced lease id", cause)))
        return yield* withDatabase("force claim durable job", () => transaction(() => {
          const row = database.query<JobRow, [string, string]>(`SELECT * FROM executor_jobs
            WHERE channel = ? AND owner = ? AND state IN ('dispatching', 'running', 'finalizing')
            ORDER BY queue_order, rowid LIMIT 1`).get(channel, owner)
          if (row === null) return Option.none<DurableJobLease>()
          database.query(`UPDATE executor_jobs SET lease_worker = ?, lease_generation = ?, lease_expires_at = ?,
            payload = COALESCE(?, payload), progress_message_id = CASE
              WHEN ? IS NULL OR state = 'finalizing' THEN progress_message_id
              ELSE NULL
            END,
            updated_at = ? WHERE id = ?`).run(
            workerID,
            generation,
            now + DURABLE_JOB_LEASE_MS,
            replacementPayload ?? null,
            replacementPayload ?? null,
            now,
            row.id,
          )
          const claimed = selectByID(row.id)
          if (claimed === null) throw fail("read force-claimed durable job", new Error("force-claimed job is missing"))
          return Option.some({ job: fromRow(claimed), generation, recoveredFrom: row.state })
        }))
      }),
      renew: (jobID, generation) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        withDatabase("renew durable job lease", () => database.query(`UPDATE executor_jobs SET
          lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_generation = ?
        `).run(now + DURABLE_JOB_LEASE_MS, now, jobID, generation).changes > 0),
      )),
      markDispatching: (jobID, generation) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("mark durable job dispatching", jobID, generation, `UPDATE executor_jobs SET
          state = 'dispatching', updated_at = ? WHERE id = ? AND lease_generation = ? AND state = 'pending'`, [now]),
      )),
      markRunning: (jobID, generation, inputID) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("mark durable job running", jobID, generation, `UPDATE executor_jobs SET
          state = 'running', input_id = COALESCE(?, input_id), updated_at = ? WHERE id = ? AND lease_generation = ?`,
        [inputID ?? null, now]),
      )),
      markProgressMessage: (jobID, generation, messageID) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("record durable job progress message", jobID, generation, `UPDATE executor_jobs SET
          progress_message_id = ?, updated_at = ? WHERE id = ? AND lease_generation = ?`, [messageID, now]),
      )),
      beginProgressDelivery: (jobID, generation) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("begin durable progress delivery", jobID, generation, `UPDATE executor_jobs SET
          progress_message_id = ?, updated_at = ? WHERE id = ? AND lease_generation = ? AND progress_message_id IS NULL`,
        [PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID, now]),
      )),
      markFinalizing: (jobID, generation, terminalResult) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("mark durable job finalizing", jobID, generation, `UPDATE executor_jobs SET
          state = 'finalizing', terminal_result = ?, updated_at = ? WHERE id = ? AND lease_generation = ?`,
        [terminalResult, now]),
      )),
      beginMediaDelivery: (jobID, generation, index) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("begin durable media delivery", jobID, generation, `UPDATE executor_jobs SET
          media_delivery_index = ?, updated_at = ? WHERE id = ? AND lease_generation = ?`, [index, now]),
      )),
      markMediaDelivered: (jobID, generation, count) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("record durable media delivery", jobID, generation, `UPDATE executor_jobs SET
          delivered_media_count = ?, media_delivery_index = NULL, updated_at = ?
          WHERE id = ? AND lease_generation = ?`, [count, now]),
      )),
      complete: (jobID, generation) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("complete durable job", jobID, generation, `UPDATE executor_jobs SET
          state = 'completed', lease_worker = NULL, lease_generation = NULL, lease_expires_at = NULL,
          payload = '{}', terminal_result = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND lease_generation = ?`, [now, now]),
      )),
      retry: (jobID, generation, lastError, delayMs) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("retry durable job", jobID, generation, `UPDATE executor_jobs SET
          state = 'pending', available_at = ?, last_error = ?, lease_worker = NULL, lease_generation = NULL,
          lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_generation = ?`, [now + delayMs, lastError, now]),
      )),
      defer: (jobID, generation, lastError, delayMs) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        transition("defer durable job", jobID, generation, `UPDATE executor_jobs SET
          available_at = ?, last_error = ?, lease_worker = NULL, lease_generation = NULL,
          lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_generation = ?`, [now + delayMs, lastError, now]),
      )),
      fail: (jobID, generation, lastError, needsReview = false) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        needsReview
          ? transition("mark durable job for review", jobID, generation, `UPDATE executor_jobs SET
              state = 'needs_review', last_error = ?, lease_worker = NULL, lease_generation = NULL, lease_expires_at = NULL,
              updated_at = ? WHERE id = ? AND lease_generation = ?`, [lastError, now])
          : transition("fail durable job", jobID, generation, `UPDATE executor_jobs SET
              state = 'failed', last_error = ?, lease_worker = NULL, lease_generation = NULL, lease_expires_at = NULL,
              payload = '{}', terminal_result = NULL, updated_at = ? WHERE id = ? AND lease_generation = ?`, [lastError, now]),
      )),
      resolveReview: (jobID) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        withDatabase("resolve durable job review", () => {
          const result = database.query(`UPDATE executor_jobs SET state = 'failed', payload = '{}', terminal_result = NULL,
            updated_at = ? WHERE id = ? AND state = 'needs_review'`).run(now, jobID)
          return result.changes > 0
        }),
      )),
      purgeExpiredReviews: Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        withDatabase("purge expired durable job reviews", () => database.query(`UPDATE executor_jobs SET
          state = 'failed', payload = '{}', terminal_result = NULL,
          last_error = 'manual review expired and retained data was removed', updated_at = ?
          WHERE state = 'needs_review' AND updated_at <= ?`).run(now, now - NEEDS_REVIEW_RETENTION_MS).changes),
      )),
      release: (jobID, generation) => withDatabase("release durable job lease", () => {
        database.query(`UPDATE executor_jobs SET lease_worker = NULL, lease_generation = NULL, lease_expires_at = NULL
          WHERE id = ? AND lease_generation = ?`).run(jobID, generation)
      }),
      releaseWorkerLeases: withDatabase("release worker durable job leases", () => {
        database.query(`UPDATE executor_jobs SET lease_worker = NULL, lease_generation = NULL, lease_expires_at = NULL
          WHERE lease_worker = ? AND state IN ('dispatching', 'running', 'finalizing')`).run(workerID)
      }),
      get: (jobID) => withDatabase("read durable job", () => Option.fromNullishOr(selectByID(jobID)).pipe(Option.map(fromRow))),
      listOwner: (channel, owner) => withDatabase("list owner durable jobs", () =>
        database.query<JobRow, [string, string]>("SELECT * FROM executor_jobs WHERE channel = ? AND owner = ? ORDER BY queue_order, rowid").all(channel, owner).map(fromRow)),
      movePending: (channel, owner, from, to) => withDatabase("move pending durable job", () => transaction(() => {
        const rows = database.query<Pick<JobRow, "id" | "queue_order">, [string, string]>(`SELECT id, queue_order
          FROM executor_jobs
          WHERE channel = ? AND owner = ? AND state = 'pending' AND lease_generation IS NULL
          ORDER BY queue_order, rowid`).all(channel, owner)
        if (from < 1 || to < 1 || from > rows.length || to > rows.length) {
          return { moved: false, count: rows.length }
        }
        if (from === to) return { moved: true, count: rows.length }
        const orders = rows.map((row) => row.queue_order)
        const selected = rows[from - 1]
        if (selected === undefined) return { moved: false, count: rows.length }
        rows.splice(from - 1, 1)
        rows.splice(to - 1, 0, selected)
        const update = database.query("UPDATE executor_jobs SET queue_order = ? WHERE id = ? AND state = 'pending' AND lease_generation IS NULL")
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index]
          const order = orders[index]
          if (row === undefined || order === undefined) continue
          update.run(order, row.id)
        }
        return { moved: true, count: rows.length }
      })),
      deletePending: (channel, owner, position) => withDatabase("delete pending durable job", () => transaction(() => {
        const rows = database.query<Pick<JobRow, "id">, [string, string]>(`SELECT id FROM executor_jobs
          WHERE channel = ? AND owner = ? AND state = 'pending' AND lease_generation IS NULL
          ORDER BY queue_order, rowid`).all(channel, owner)
        const selected = position >= 1 ? rows[position - 1] : undefined
        if (selected === undefined) return { deleted: false, count: rows.length }
        database.query("DELETE FROM executor_jobs WHERE id = ? AND state = 'pending' AND lease_generation IS NULL").run(selected.id)
        return { deleted: true, count: rows.length }
      })),
      clearPending: (channel, owner) => withDatabase("clear pending durable jobs", () =>
        database.query("DELETE FROM executor_jobs WHERE channel = ? AND owner = ? AND state = 'pending' AND lease_generation IS NULL")
          .run(channel, owner).changes),
    }
  }),
)
