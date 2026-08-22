import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppConfig, AppConfigTag } from "../src/config.js"
import {
  DurableExecutorStore,
  DurableExecutorStoreLive,
  DurableLeaseLost,
  NEEDS_REVIEW_RETENTION_MS,
  PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID,
  type DurableJob,
  type DurableExecutorError,
  type DurableExecutorRepository,
} from "../src/core/durable-executor.js"
import { GitChangesError, type ChangesSummaryResult, type GitChangesService } from "../src/core/git-changes.js"
import { agentSwitchRetriesExhausted, decodeAttachmentSnapshots, encodeAttachmentSnapshots, finalEditDisposition, redactedReviewEvidence, resolveOwnedDurableReview, runQueueItems, settleFinalEditError, withChangesSummaryUsing } from "../src/telegram/durable-executor.js"
import { ApiError } from "../src/telegram/api.js"
import { AgentSwitchError } from "../src/telegram/run.js"

const config = () => new AppConfig({
  telegramBotToken: "test-token",
  projectDirectory: tmpdir(),
  stateFile: join(tmpdir(), `${crypto.randomUUID()}.json`),
  webDatabaseFile: join(tmpdir(), `${crypto.randomUUID()}.sqlite`),
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
})

const run = <A>(effect: Effect.Effect<A, ApiError | DurableExecutorError | DurableLeaseLost, DurableExecutorStore>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(DurableExecutorStoreLive),
    Effect.provideService(AppConfigTag, config()),
    Effect.provide(BunFileSystem.layer),
    Effect.provide(BunPath.layer),
    Effect.provide(BunCrypto.layer),
  ))

const runWithTestClock = <A>(effect: Effect.Effect<A, DurableExecutorError | DurableLeaseLost, DurableExecutorStore>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(DurableExecutorStoreLive),
    Effect.provideService(AppConfigTag, config()),
    Effect.provide(BunFileSystem.layer),
    Effect.provide(BunPath.layer),
    Effect.provide(BunCrypto.layer),
    Effect.provide(TestClock.layer()),
  ))

const submit = (store: DurableExecutorRepository, sourceKey: string, owner = "1") =>
  store.submit({
    sourceKey,
    channel: "telegram",
    owner,
    payload: JSON.stringify({ text: sourceKey }),
  })

describe("DurableExecutorStore", () => {
  test("classifies permanent final edits so they cannot block the owner queue", () => {
    expect(finalEditDisposition({ transient: false, description: "Bad Request: message to edit not found" })).toBe("fail")
    expect(finalEditDisposition({ transient: true })).toBe("retry")
    expect(finalEditDisposition({ transient: false, description: "Bad Request: message is not modified" })).toBe("accepted")
  })
  test("a permanent final edit rejection fails the job and promotes the next owner job", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:edit-failure")
      yield* submit(store, "telegram:1:after-edit-failure")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.markFinalizing(first.value.job.id, first.value.generation, "final result")
      const delivered = yield* settleFinalEditError(store, first.value, new ApiError({
        operation: "editMessageText",
        code: 400,
        description: "message to edit not found",
        transient: false,
      }))
      return { delivered, failed: yield* store.get(first.value.job.id), next: yield* store.claimNext("telegram") }
    }))
    expect(result?.delivered).toBe(false)
    expect(result !== undefined && Option.isSome(result.failed) && result.failed.value.state).toBe("failed")
    expect(result !== undefined && Option.isSome(result.next) && result.next.value.job.sourceKey).toBe("telegram:1:after-edit-failure")
  })

  test("redacts attachment contents while exposing usable review evidence", async () => {
    const job: DurableJob = {
      id: "job-review",
      sourceKey: "telegram:1:review",
      channel: "telegram",
      owner: "session:ses_1",
      payload: JSON.stringify({
        chatId: 1,
        message: { message_id: 1, chat: { id: 1 } },
        text: "Please inspect this deployment",
        sessionID: "ses_1",
        directory: "/tmp/project",
        attachments: [{ name: "secret.txt", mime: "text/plain", base64: "TOP_SECRET_BASE64" }],
      }),
      state: "needs_review",
      attempt: 1,
      availableAt: 0,
      deliveredMediaCount: 0,
      terminalResult: JSON.stringify({ text: "Recovered response", media: [] }),
      createdAt: 0,
      updatedAt: 0,
      queueOrder: 0,
    }
    const evidence = await Effect.runPromise(redactedReviewEvidence(job))
    expect(evidence).toContain("Please inspect this deployment")
    expect(evidence).toContain("secret.txt")
    expect(evidence).toContain("Recovered response")
    expect(evidence).not.toContain("TOP_SECRET_BASE64")
  })
  test("attachment snapshots preserve accepted bytes across a restart boundary", () => {
    const attachments = [{ name: "input.md", mime: "text/markdown", bytes: Uint8Array.from([0, 1, 2, 255]) }]
    expect(decodeAttachmentSnapshots(encodeAttachmentSnapshots(attachments))).toEqual(attachments)
  })
  test("submission is idempotent by source key", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const first = yield* submit(store, "telegram:1:10")
      const second = yield* submit(store, "telegram:1:10")
      return { first, second }
    }))

    expect(result.first.created).toBe(true)
    expect(result.second.created).toBe(false)
    expect(result.second.job.id).toBe(result.first.job.id)
  })

  test("moves pending jobs by one-based queue position", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "first")
      yield* submit(store, "second")
      yield* submit(store, "third")
      const moved = yield* store.movePending("telegram", "1", 3, 1)
      const ordered = yield* store.listOwner("telegram", "1")
      const claimed = yield* store.claimNext("telegram")
      return { moved, ordered, claimed }
    }))

    expect(result.moved).toEqual({ moved: true, count: 3 })
    expect(result.ordered.map((job) => job.sourceKey)).toEqual(["third", "first", "second"])
    expect(Option.getOrUndefined(result.claimed)?.job.sourceKey).toBe("third")
  })

  test("rejects queue positions outside the movable pending jobs", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "first")
      yield* submit(store, "second")
      yield* store.claimNext("telegram")
      return yield* store.movePending("telegram", "1", 2, 1)
    }))

    expect(result).toEqual({ moved: false, count: 1 })
  })

  test("deletes one queued job by position and keeps claimed jobs", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "first")
      yield* submit(store, "second")
      yield* submit(store, "third")
      const claimed = yield* store.claimNext("telegram")
      const deleted = yield* store.deletePending("telegram", "1", 2)
      const ordered = yield* store.listOwner("telegram", "1")
      const rejected = yield* store.deletePending("telegram", "1", 9)
      return { claimedJobID: Option.getOrUndefined(claimed)?.job.id, deleted, ordered, rejected }
    }))

    expect(result.deleted).toEqual({ deleted: true, count: 2 })
    expect(result.rejected).toEqual({ deleted: false, count: 1 })
    expect(result.ordered.map((job) => [job.sourceKey, job.state])).toEqual([
      ["first", "pending"],
      ["second", "pending"],
    ])
    expect(result.ordered.some((job) => job.id === result.claimedJobID)).toBe(true)
  })

  test("clears every queued job and keeps the running one", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "first")
      yield* submit(store, "second")
      yield* submit(store, "third")
      const claimed = yield* store.claimNext("telegram")
      const removed = yield* store.clearPending("telegram", "1")
      const again = yield* store.clearPending("telegram", "1")
      const remaining = yield* store.listOwner("telegram", "1")
      return { claimedJobID: Option.getOrUndefined(claimed)?.job.id, removed, again, remaining }
    }))

    expect(result.removed).toBe(2)
    expect(result.again).toBe(0)
    expect(result.remaining.map((job) => [job.sourceKey, job.state])).toEqual([["first", "pending"]])
    expect(result.remaining.some((job) => job.id === result.claimedJobID)).toBe(true)
  })

  test("a claimed job keeps its payload and is reclaimed in place", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const submitted = yield* submit(store, "telegram:1:11")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.release(first.value.job.id, first.value.generation)
      const recovered = yield* store.claimNext("telegram")
      return { submitted, first: first.value, recovered }
    }))

    expect(result).toBeDefined()
    if (result === undefined || Option.isNone(result.recovered)) return
    expect(result.recovered.value.job.id).toBe(result.submitted.job.id)
    expect(result.recovered.value.job.payload).toBe(result.first.job.payload)
    expect(result.recovered.value.recoveredFrom).toBe("pending")
  })

  test("one owner cannot promote a second job while its first job is active", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:12")
      yield* submit(store, "telegram:1:13")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      const blocked = yield* store.claimNext("telegram")
      yield* store.markFinalizing(first.value.job.id, first.value.generation, "first result")
      yield* store.complete(first.value.job.id, first.value.generation)
      const completed = yield* store.get(first.value.job.id)
      const second = yield* store.claimNext("telegram")
      return { first: first.value, blocked, completed, second }
    }))

    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result.blocked).toEqual(Option.none())
    expect(Option.isSome(result.completed) && result.completed.value.payload).toBe("{}")
    expect(Option.isSome(result.second)).toBe(true)
    if (Option.isSome(result.second)) expect(result.second.value.job.sourceKey).toBe("telegram:1:13")
  })

  test("terminal failures scrub payloads while review jobs retain data until resolution", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const failedSubmission = yield* submit(store, "telegram:1:failed")
      const failedLease = yield* store.claimNext("telegram")
      if (Option.isNone(failedLease)) return undefined
      yield* store.markFinalizing(failedSubmission.job.id, failedLease.value.generation, "sensitive response")
      yield* store.fail(failedSubmission.job.id, failedLease.value.generation, "permanent failure")

      const reviewSubmission = yield* submit(store, "telegram:1:review", "2")
      const reviewLease = yield* store.claimNext("telegram")
      if (Option.isNone(reviewLease)) return undefined
      yield* store.markFinalizing(reviewSubmission.job.id, reviewLease.value.generation, "sensitive response")
      yield* store.fail(reviewSubmission.job.id, reviewLease.value.generation, "ambiguous result", true)
      const reviewBeforeResolution = yield* store.get(reviewSubmission.job.id)
      const resolved = yield* store.resolveReview(reviewSubmission.job.id)
      return {
        failed: yield* store.get(failedSubmission.job.id),
        reviewBeforeResolution,
        reviewAfterResolution: yield* store.get(reviewSubmission.job.id),
        resolved,
      }
    }))

    expect(result).toBeDefined()
    if (result === undefined) return
    expect(Option.isSome(result.failed) && result.failed.value.payload).toBe("{}")
    expect(Option.isSome(result.reviewBeforeResolution) && result.reviewBeforeResolution.value.payload).not.toBe("{}")
    expect(Option.isSome(result.reviewBeforeResolution) && result.reviewBeforeResolution.value.terminalResult).toBe("sensitive response")
    expect(result.resolved).toBe(true)
    expect(Option.isSome(result.reviewAfterResolution) && result.reviewAfterResolution.value.payload).toBe("{}")
    expect(Option.isSome(result.reviewAfterResolution) && result.reviewAfterResolution.value.terminalResult).toBeUndefined()
  })

  test("resolves review data only for the current session owner", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const submitted = yield* submit(store, "telegram:1:owned-review", "session:owned")
      const lease = yield* store.claimNext("telegram")
      if (Option.isNone(lease)) return undefined
      yield* store.markFinalizing(submitted.job.id, lease.value.generation, "sensitive response")
      yield* store.fail(submitted.job.id, lease.value.generation, "ambiguous", true)
      const wrongOwner = yield* resolveOwnedDurableReview(store, "session:other", submitted.job.id)
      const beforeOwnerResolution = yield* store.get(submitted.job.id)
      const owner = yield* resolveOwnedDurableReview(store, "session:owned", submitted.job.id)
      return { wrongOwner, beforeOwnerResolution, owner, after: yield* store.get(submitted.job.id) }
    }))
    expect(result?.wrongOwner).toBe(false)
    expect(result !== undefined && Option.isSome(result.beforeOwnerResolution) && result.beforeOwnerResolution.value.payload).not.toBe("{}")
    expect(result?.owner).toBe(true)
    expect(result !== undefined && Option.isSome(result.after) && result.after.value.payload).toBe("{}")
  })

  test("automatically scrubs review evidence after the retention window", async () => {
    const result = await runWithTestClock(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const submitted = yield* submit(store, "telegram:1:expiring-review")
      const lease = yield* store.claimNext("telegram")
      if (Option.isNone(lease)) return undefined
      yield* store.markFinalizing(submitted.job.id, lease.value.generation, "sensitive response")
      yield* store.fail(submitted.job.id, lease.value.generation, "ambiguous", true)
      yield* TestClock.adjust(NEEDS_REVIEW_RETENTION_MS + 1)
      const purged = yield* store.purgeExpiredReviews
      return { purged, job: yield* store.get(submitted.job.id) }
    }))
    expect(result?.purged).toBe(1)
    expect(result !== undefined && Option.isSome(result.job) && result.job.value.state).toBe("failed")
    expect(result !== undefined && Option.isSome(result.job) && result.job.value.payload).toBe("{}")
    expect(result !== undefined && Option.isSome(result.job) && result.job.value.terminalResult).toBeUndefined()
  })

  test("a forced claim fences the previous generation without deleting the job", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:14")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.markDispatching(first.value.job.id, first.value.generation)
      const forced = yield* store.forceClaim("telegram", "1")
      if (Option.isNone(forced)) return undefined
      return {
        sameJob: first.value.job.id === forced.value.job.id,
        generationsDiffer: first.value.generation !== forced.value.generation,
        firstRenews: yield* store.renew(first.value.job.id, first.value.generation),
        forcedRenews: yield* store.renew(forced.value.job.id, forced.value.generation),
      }
    }))

    expect(result).toEqual({
      sameJob: true,
      generationsDiffer: true,
      firstRenews: false,
      forcedRenews: true,
    })
  })

  test("a forced claim replaces the payload before returning the new lease", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:force-route")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.markDispatching(first.value.job.id, first.value.generation)
      yield* store.markProgressMessage(first.value.job.id, first.value.generation, 44)
      const forced = yield* store.forceClaim("telegram", "1", JSON.stringify({ chatId: 9, threadId: 4 }))
      return Option.isSome(forced) ? {
        payload: forced.value.job.payload,
        progressMessageID: forced.value.job.progressMessageID,
      } : undefined
    }))

    expect(result).toEqual({
      payload: JSON.stringify({ chatId: 9, threadId: 4 }),
      progressMessageID: undefined,
    })
  })

  test("a forced claim preserves the final delivery anchor", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const submitted = yield* submit(store, "telegram:1:force-final-route")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.markProgressMessage(submitted.job.id, first.value.generation, 44)
      yield* store.markFinalizing(submitted.job.id, first.value.generation, "final result")
      const forced = yield* store.forceClaim("telegram", "1", JSON.stringify({ chatId: 9 }))
      return Option.isSome(forced) ? forced.value.job.progressMessageID : undefined
    }))

    expect(result).toBe(44)
  })

  test("dispatch intent is persisted separately from claiming", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:dispatch")
      const claimed = yield* store.claimNext("telegram")
      if (Option.isNone(claimed)) return undefined
      const beforeDispatch = claimed.value.job.state
      yield* store.markDispatching(claimed.value.job.id, claimed.value.generation)
      yield* store.release(claimed.value.job.id, claimed.value.generation)
      const recovered = yield* store.claimNext("telegram")
      return { beforeDispatch, recovered }
    }))

    expect(result).toBeDefined()
    if (result === undefined || Option.isNone(result.recovered)) return
    expect(result.beforeDispatch).toBe("pending")
    expect(result.recovered.value.recoveredFrom).toBe("dispatching")
  })

  test("initial progress delivery is fenced before Telegram message creation", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:progress-delivery")
      const lease = yield* store.claimNext("telegram")
      if (Option.isNone(lease)) return undefined
      yield* store.beginProgressDelivery(lease.value.job.id, lease.value.generation)
      yield* store.release(lease.value.job.id, lease.value.generation)
      return yield* store.claimNext("telegram")
    }))

    expect(result !== undefined && Option.isSome(result) && result.value.job.progressMessageID)
      .toBe(PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID)
  })

  test("final delivery state survives lease release", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:15")
      const lease = yield* store.claimNext("telegram")
      if (Option.isNone(lease)) return undefined
      yield* store.markFinalizing(lease.value.job.id, lease.value.generation, "final answer")
      yield* store.markMediaDelivered(lease.value.job.id, lease.value.generation, 1)
      yield* store.release(lease.value.job.id, lease.value.generation)
      const recovered = yield* store.claimNext("telegram")
      return recovered
    }))

    expect(Option.isSome(result ?? Option.none())).toBe(true)
    if (result !== undefined && Option.isSome(result)) {
      expect(result.value.recoveredFrom).toBe("finalizing")
      expect(result.value.job.terminalResult).toBe("final answer")
      expect(result.value.job.deliveredMediaCount).toBe(1)
    }
  })

  test("a delayed first job prevents a later job for the same owner from overtaking it", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:16")
      yield* submit(store, "telegram:1:17")
      const first = yield* store.claimNext("telegram")
      if (Option.isNone(first)) return undefined
      yield* store.retry(first.value.job.id, first.value.generation, "temporary failure", 60_000)
      return yield* store.claimNext("telegram")
    }))

    expect(result).toBeDefined()
    if (result === undefined) return
    expect(result).toEqual(Option.none())
  })

  test("an in-flight media delivery remains visible after reclaim", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "telegram:1:18")
      const lease = yield* store.claimNext("telegram")
      if (Option.isNone(lease)) return undefined
      yield* store.markFinalizing(lease.value.job.id, lease.value.generation, "final answer")
      yield* store.beginMediaDelivery(lease.value.job.id, lease.value.generation, 0)
      yield* store.release(lease.value.job.id, lease.value.generation)
      return yield* store.claimNext("telegram")
    }))

    expect(result).toBeDefined()
    if (result === undefined || Option.isNone(result)) return
    expect(result.value.job.mediaDeliveryIndex).toBe(0)
    expect(result.value.job.deliveredMediaCount).toBe(0)
  })
})

describe("withChangesSummaryUsing", () => {
  const summary: ChangesSummaryResult = {
    kind: "summary",
    summary: {
      branch: Option.some("main"),
      commit: Option.some("abc1234"),
      files: [{ path: "src/a.ts", status: "M " }],
      insertions: Option.some(1),
      deletions: Option.some(0),
      binaryFiles: 0,
    },
  }

  test("appends the changes summary to the finalization", async () => {
    const gitChanges: GitChangesService = { summarize: () => Effect.succeed(summary) }
    const result = await Effect.runPromise(
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [] }, "/tmp/project"),
    )
    expect(result.text).toContain("Current changes")
    expect(result.text).toContain("M  src/a.ts")
    expect(result.media).toEqual([])
  })

  test("keeps the text unchanged outside a git repository", async () => {
    const gitChanges: GitChangesService = { summarize: () => Effect.succeed({ kind: "none" }) }
    const result = await Effect.runPromise(
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [] }, "/tmp/project"),
    )
    expect(result.text).toBe("Done.")
  })

  test("marks the summary unavailable instead of failing the run", async () => {
    const gitChanges: GitChangesService = {
      summarize: () => Effect.fail(
        new GitChangesError({ operation: "status", directory: "/tmp/project", cause: new Error("boom") }),
      ),
    }
    const result = await Effect.runPromise(
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [] }, "/tmp/project"),
    )
    expect(result.text).toContain("Changes: unavailable.")
  })
})

describe("runQueueItems", () => {
  const payload = (text: string): string => JSON.stringify({
    chatId: 1,
    threadId: 42,
    message: { message_id: 1, chat: { id: 1 } },
    text,
    sessionID: "ses_1",
    directory: "/tmp/project",
  })

  const job = (overrides: Partial<DurableJob> & { readonly id: string; readonly state: DurableJob["state"]; readonly payload: string }): DurableJob => ({
    sourceKey: "telegram:1:1",
    channel: "telegram",
    owner: "session:ses_1",
    attempt: 1,
    availableAt: 0,
    deliveredMediaCount: 0,
    createdAt: 0,
    updatedAt: 0,
    queueOrder: 0,
    ...overrides,
  })

  test("keeps only pipeline states in creation order", async () => {
    const items = await Effect.runPromise(runQueueItems([
      job({ id: "j-completed", state: "completed", payload: payload("old") }),
      job({ id: "j-running", state: "running", payload: payload("Current run") }),
      job({ id: "j-pending", state: "pending", payload: payload("Next") }),
      job({ id: "j-review", state: "needs_review", payload: payload("review me") }),
      job({ id: "j-finalizing", state: "finalizing", payload: payload("Finishing") }),
    ]))
    expect(items.map((item) => item.id)).toEqual(["j-running", "j-pending", "j-finalizing"])
  })

  test("decodes the prompt text from the job payload", async () => {
    const items = await Effect.runPromise(runQueueItems([
      job({ id: "j1", state: "pending", payload: payload("Add a /diff command") }),
    ]))
    expect(items[0]?.text).toBe("Add a /diff command")
  })

  test("shows an empty prompt when the payload cannot be decoded", async () => {
    const items = await Effect.runPromise(runQueueItems([
      job({ id: "j1", state: "pending", payload: "not a telegram payload" }),
    ]))
    expect(items[0]?.text).toBe("")
  })
})

describe("agent switch retries", () => {
  const failure = Cause.fail(new AgentSwitchError({
    agent: "removed-agent",
    cause: Cause.fail(new Error("not found")),
  }))

  test("allows bounded retries before failing the queued job", () => {
    expect(agentSwitchRetriesExhausted(failure, 2)).toBe(false)
    expect(agentSwitchRetriesExhausted(failure, 3)).toBe(true)
  })

  test("does not classify unrelated pending failures as agent exhaustion", () => {
    expect(agentSwitchRetriesExhausted(Cause.fail(new Error("network")), 3)).toBe(false)
  })
})
