import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option, Ref, Schema, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import { BunCrypto, BunFileSystem, BunPath } from "@effect/platform-bun"
import { Session } from "@opencode-ai/client/effect"
import * as Agent from "@opencode-ai/schema/agent"
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
import type { SessionsError } from "../src/core/sessions.js"
import { AUTO_CONTINUE_BASE_DELAY_MS, AUTO_CONTINUE_MAX_DELAY_MS, agentSwitchRetriesExhausted, decideAutoContinue, decodeAttachmentSnapshots, encodeAttachmentSnapshots, autoContinueDelayMs, finalEditDisposition, finishNotificationWord, forceReconnectPayload, hasRunPipeline, modelSwitchRetriesExhausted, normalizeTelegramJobPayload, redactedReviewEvidence, resetConversationUsing, resolveOwnedDurableReview, resolveRunSelectionUsing, runQueueItems, runSelectionFields, runSnapshotFields, settleFinalEditError, submitForCurrentConversationUsing, whenSubmissionSourceMissingUsing, withChangesSummaryUsing } from "../src/telegram/durable-executor.js"
import { ApiError } from "../src/telegram/api.js"
import { AgentSwitchError, ModelSwitchError } from "../src/telegram/run.js"

const config = () => new AppConfig({
  telegramBotToken: "test-token",
  projectDirectory: tmpdir(),
  stateFile: join(tmpdir(), `${crypto.randomUUID()}.json`),
  webDatabaseFile: join(tmpdir(), `${crypto.randomUUID()}.sqlite`),
  telegramRunTimeout: "10 minutes",
  webPort: 3001,
})

const run = <A>(effect: Effect.Effect<A, ApiError | DurableExecutorError | DurableLeaseLost | SessionsError, DurableExecutorStore>) =>
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
  test("normalizes legacy Telegram payloads to controller-owned routes", () => {
    const payload = normalizeTelegramJobPayload({
      chatId: -100,
      threadId: 42,
      message: { message_id: 7, chat: { id: -100 }, message_thread_id: 42 },
      text: "legacy task",
      sessionID: "ses_legacy",
      directory: "/tmp/project",
    })

    expect(payload.conversationId).toBe("tg:-100:thread:42")
    expect(payload.controllerRoute).toEqual({ botKey: "controller", chatId: -100, threadId: 42 })
    expect(payload.runDeliveryRoute).toEqual({ botKey: "controller", chatId: -100, threadId: 42 })
    expect(payload.assignmentGeneration).toBe(0)
  })

  test("preserves explicit worker ownership in new Telegram payloads", () => {
    const payload = normalizeTelegramJobPayload({
      chatId: -100,
      threadId: 42,
      conversationId: "tg:-100:thread:42",
      controllerRoute: { botKey: "controller", chatId: -100, threadId: 42 },
      runDeliveryRoute: { botKey: "delivery-4", chatId: -100, threadId: 42 },
      assignmentGeneration: 7,
      message: { message_id: 8, chat: { id: -100 }, message_thread_id: 42 },
      text: "new task",
      sessionID: "ses_new",
      directory: "/tmp/project",
    })

    expect(payload.runDeliveryRoute.botKey).toBe("delivery-4")
    expect(payload.assignmentGeneration).toBe(7)
  })

  test("force reconnect reroutes controller interactions but preserves the run anchor route", () => {
    const original = normalizeTelegramJobPayload({
      chatId: -100,
      threadId: 42,
      conversationId: "tg:-100:thread:42",
      controllerRoute: { botKey: "controller", chatId: -100, threadId: 42 },
      runDeliveryRoute: { botKey: "delivery-4", chatId: -100, threadId: 42 },
      assignmentGeneration: 7,
      message: { message_id: 8, chat: { id: -100 }, message_thread_id: 42 },
      text: "task",
      sessionID: "ses_shared",
      directory: "/tmp/project",
    })

    const reconnected = forceReconnectPayload(original, { chatId: -200, threadId: 99 })

    expect(reconnected.controllerRoute).toEqual({ botKey: "controller", chatId: -200, threadId: 99 })
    expect(reconnected.runDeliveryRoute).toEqual(original.runDeliveryRoute)
    expect(reconnected.conversationId).toBe("tg:-100:thread:42")
    expect(reconnected.chatId).toBe(-100)
    expect(reconnected.threadId).toBe(42)
    expect(reconnected.message).toEqual(original.message)
  })

  test("detects every executable run-pipeline state", () => {
    expect(hasRunPipeline([{ state: "pending" }])).toBe(true)
    expect(hasRunPipeline([{ state: "dispatching" }])).toBe(true)
    expect(hasRunPipeline([{ state: "running" }])).toBe(true)
    expect(hasRunPipeline([{ state: "finalizing" }])).toBe(true)
    expect(hasRunPipeline([{ state: "completed" }, { state: "failed" }, { state: "cancelled" }, { state: "needs_review" }])).toBe(false)
  })

  test("does not submit an old-session reconnect after /new wins the conversation lock", async () => {
    const result = await run(Effect.gen(function* () {
      const jobs = yield* DurableExecutorStore
      const lock = yield* Semaphore.make(1)
      const current = yield* Ref.make(Option.some("ses_old"))
      const store = { getSessionIDForConversation: () => Ref.get(current) }
      const sessions = { reset: () => Ref.set(current, Option.none()) }
      const reset = yield* resetConversationUsing(lock, store, sessions, jobs, "tg:7:thread:42")
      // A new prompt can create another session before the delayed reconnect
      // reaches its submission boundary.
      yield* Ref.set(current, Option.some("ses_new"))
      const submitted = yield* submitForCurrentConversationUsing(
        lock,
        store,
        jobs,
        "tg:7:thread:42",
        "ses_old",
        {
          sourceKey: "reconnect-after-reset",
          channel: "telegram",
          owner: "session:ses_old",
          payload: "{}",
          sessionID: "ses_old",
        },
      )
      return {
        reset,
        submitted,
        oldJobs: yield* jobs.listOwner("telegram", "session:ses_old"),
      }
    }))

    expect(result.reset).toBe("reset")
    expect(result.submitted).toBe(false)
    expect(result.oldJobs).toEqual([])
  })

  test("blocks /new when auto-continue wins the conversation lock", async () => {
    const result = await run(Effect.gen(function* () {
      const jobs = yield* DurableExecutorStore
      const lock = yield* Semaphore.make(1)
      const current = yield* Ref.make(Option.some("ses_old"))
      const store = { getSessionIDForConversation: () => Ref.get(current) }
      const sessions = { reset: () => Ref.set(current, Option.none()) }
      const submitted = yield* submitForCurrentConversationUsing(
        lock,
        store,
        jobs,
        "tg:7:thread:42",
        "ses_old",
        {
          sourceKey: "continue-before-reset",
          channel: "telegram",
          owner: "session:ses_old",
          payload: "{}",
          sessionID: "ses_old",
        },
      )
      const reset = yield* resetConversationUsing(lock, store, sessions, jobs, "tg:7:thread:42")
      return {
        submitted,
        reset,
        current: yield* Ref.get(current),
        oldJobs: yield* jobs.listOwner("telegram", "session:ses_old"),
      }
    }))

    expect(result.submitted).toBe(true)
    expect(result.reset).toBe("blocked")
    expect(result.current).toEqual(Option.some("ses_old"))
    expect(result.oldJobs.map((job) => job.state)).toEqual(["pending"])
  })

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

  test("lists only non-terminal jobs for one channel", async () => {
    const states = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      yield* submit(store, "terminal", "terminal-owner")
      yield* submit(store, "active", "active-owner")
      const terminal = yield* store.claimNext("telegram")
      if (Option.isSome(terminal)) yield* store.complete(terminal.value.job.id, terminal.value.generation)
      return (yield* store.listNonTerminal("telegram")).map((job) => ({ sourceKey: job.sourceKey, state: job.state }))
    }))

    expect(states).toEqual([{ sourceKey: "active", state: "pending" }])
  })

  test("a duplicate replay skips snapshot resolution before idempotent submit", async () => {
    const result = await run(Effect.gen(function* () {
      const store = yield* DurableExecutorStore
      const sourceKey = "telegram:tg:7:thread:42:10"
      const owner = "session:ses_1"
      yield* submit(store, sourceKey, owner)
      const resolutions = yield* Ref.make(0)
      const replay = yield* whenSubmissionSourceMissingUsing(
        store,
        "telegram",
        owner,
        sourceKey,
        Ref.update(resolutions, (count) => count + 1).pipe(Effect.as("resolved")),
      )
      return { replay, resolutions: yield* Ref.get(resolutions) }
    }))

    expect(result.replay).toEqual(Option.none())
    expect(result.resolutions).toBe(0)
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
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [], outcome: "done" }, "/tmp/project"),
    )
    expect(result.text).toContain("Current changes")
    expect(result.text).toContain("M  src/a.ts")
    expect(result.media).toEqual([])
  })

  test("keeps the text unchanged outside a git repository", async () => {
    const gitChanges: GitChangesService = { summarize: () => Effect.succeed({ kind: "none" }) }
    const result = await Effect.runPromise(
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [], outcome: "done" }, "/tmp/project"),
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
      withChangesSummaryUsing(gitChanges, { text: "Done.", media: [], outcome: "done" }, "/tmp/project"),
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

  test("decodes an old payload without agent or model snapshots", async () => {
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

describe("resolveRunSelectionUsing", () => {
  const session = (input: {
    readonly id: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }) => {
    const base = {
      id: input.id,
      projectID: "project",
      location: { directory: "/tmp/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }
    const withAgent = input.agent === undefined ? base : { ...base, agent: input.agent }
    const withModel = input.model === undefined ? withAgent : { ...withAgent, model: input.model }
    return Schema.decodeUnknownSync(Session.Info)(withModel)
  }

  const configuredAgent = Schema.decodeUnknownSync(Agent.Info)({
    ...Agent.Info.default(Agent.ID.make("build")),
    name: "Build",
    model: { id: "configured", providerID: "provider" },
  })

  test("snapshots the active session agent and its pair model", async () => {
    const selection = await Effect.runPromise(resolveRunSelectionUsing(
      {
        getSessionAgentModel: (_sessionID, agentID) => Effect.succeed(
          agentID === "build"
            ? Option.some({ id: "pair", providerID: "provider", variant: "high" })
            : Option.none(),
        ),
        getDirectoryModelFallback: () => Effect.succeed(
          Option.some({ id: "directory", providerID: "provider" }),
        ),
      },
      {
        getSession: () => Effect.succeed(session({
          id: "ses_1",
          agent: "build",
          model: { id: "session", providerID: "provider" },
        })),
        listAgents: () => Effect.succeed([configuredAgent]),
      },
      { sessionID: "ses_1", directory: "/tmp/project" },
    ))

    expect(selection).toEqual({
      agent: "build",
      model: { id: "pair", providerID: "provider", variant: "high" },
    })
  })

  test("uses an explicit prompt agent instead of the active session agent", async () => {
    const selection = await Effect.runPromise(resolveRunSelectionUsing(
      {
        getSessionAgentModel: (_sessionID, agentID) => Effect.succeed(
          agentID === "plan"
            ? Option.some({ id: "plan-model", providerID: "provider" })
            : Option.some({ id: "build-model", providerID: "provider" }),
        ),
        getDirectoryModelFallback: () => Effect.succeed(Option.none()),
      },
      {
        getSession: () => Effect.succeed(session({ id: "ses_1", agent: "build" })),
        listAgents: () => Effect.succeed([]),
      },
      { sessionID: "ses_1", directory: "/tmp/project", agent: "plan" },
    ))

    expect(selection).toEqual({
      agent: "plan",
      model: { id: "plan-model", providerID: "provider" },
    })
  })

  test("uses the configured agent model before session and directory fallbacks", async () => {
    const selection = await Effect.runPromise(resolveRunSelectionUsing(
      {
        getSessionAgentModel: () => Effect.succeed(Option.none()),
        getDirectoryModelFallback: () => Effect.succeed(
          Option.some({ id: "directory", providerID: "provider" }),
        ),
      },
      {
        getSession: () => Effect.succeed(session({
          id: "ses_1",
          agent: "build",
          model: { id: "session", providerID: "provider" },
        })),
        listAgents: () => Effect.succeed([configuredAgent]),
      },
      { sessionID: "ses_1", directory: "/tmp/project" },
    ))

    expect(selection).toEqual({
      agent: "build",
      model: { id: "configured", providerID: "provider" },
    })
  })

  test("uses the session model without inventing an agent", async () => {
    const selection = await Effect.runPromise(resolveRunSelectionUsing(
      {
        getSessionAgentModel: () => Effect.succeed(Option.none()),
        getDirectoryModelFallback: () => Effect.succeed(
          Option.some({ id: "directory", providerID: "provider" }),
        ),
      },
      {
        getSession: () => Effect.succeed(session({
          id: "ses_1",
          model: { id: "session", providerID: "provider" },
        })),
        listAgents: () => Effect.die("listAgents must not run without an agent"),
      },
      { sessionID: "ses_1", directory: "/tmp/project" },
    ))

    expect(selection).toEqual({
      model: { id: "session", providerID: "provider" },
    })
  })

  test("keeps an accepted queued snapshot after the stored preference changes", async () => {
    const preference = await Effect.runPromise(Ref.make({ id: "first", providerID: "provider" }))
    const store = {
      getSessionAgentModel: () => Ref.get(preference).pipe(Effect.map(Option.some)),
      getDirectoryModelFallback: () => Effect.succeed(Option.none()),
    }
    const opencode = {
      getSession: () => Effect.succeed(session({ id: "ses_1", agent: "build" })),
      listAgents: () => Effect.succeed([]),
    }
    const first = await Effect.runPromise(resolveRunSelectionUsing(
      store,
      opencode,
      { sessionID: "ses_1", directory: "/tmp/project" },
    ))
    const acceptedPayload = JSON.stringify({ selection: first })
    await Effect.runPromise(Ref.set(preference, { id: "second", providerID: "provider" }))
    const second = await Effect.runPromise(resolveRunSelectionUsing(
      store,
      opencode,
      { sessionID: "ses_1", directory: "/tmp/project" },
    ))

    expect(JSON.parse(acceptedPayload)).toEqual({
      selection: {
        agent: "build",
        model: { id: "first", providerID: "provider" },
      },
    })
    expect(second.model?.id).toBe("second")
  })
})

describe("runSelectionFields", () => {
  test("copies the original agent and model into an auto-continue payload", () => {
    const selection = runSelectionFields({
      agent: "build",
      model: { id: "accepted-model", providerID: "provider", variant: "high" },
    })
    const nextPayload = { text: "continue", ...selection }

    expect(nextPayload).toEqual({
      text: "continue",
      agent: "build",
      model: { id: "accepted-model", providerID: "provider", variant: "high" },
    })
  })

  test("keeps old payload snapshots optional", () => {
    expect(runSelectionFields({})).toEqual({})
  })
})

describe("runSnapshotFields", () => {
  test("keeps stream verbosity with the agent and model in follow-up jobs", () => {
    const snapshot = runSnapshotFields({
      agent: "build",
      model: { id: "accepted-model", providerID: "provider" },
    }, "detailed")

    expect(snapshot).toEqual({
      agent: "build",
      model: { id: "accepted-model", providerID: "provider" },
      verbosity: "detailed",
    })
  })

  test("defaults jobs accepted before verbosity snapshots to normal", () => {
    expect(runSnapshotFields({}, undefined)).toEqual({ verbosity: "normal" })
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

describe("model switch retries", () => {
  const failure = Cause.fail(new ModelSwitchError({
    model: { id: "removed-model", providerID: "provider" },
    cause: Cause.fail(new Error("not found")),
  }))

  test("allows bounded retries before failing the queued job", () => {
    expect(modelSwitchRetriesExhausted(failure, 2)).toBe(false)
    expect(modelSwitchRetriesExhausted(failure, 3)).toBe(true)
  })

  test("does not classify unrelated pending failures as model exhaustion", () => {
    expect(modelSwitchRetriesExhausted(Cause.fail(new Error("network")), 3)).toBe(false)
  })
})

describe("decideAutoContinue", () => {
  test("resets the counter on success", () => {
    expect(decideAutoContinue(true, 2, "done")).toEqual({ action: "reset" })
    expect(decideAutoContinue(false, 2, "done")).toEqual({ action: "reset" })
    expect(decideAutoContinue(true, 0, "done")).toEqual({ action: "none" })
  })

  test("continues on qualifying failures while under the cap", () => {
    for (const outcome of ["failed", "error", "timeout"]) {
      expect(decideAutoContinue(true, 0, outcome)).toEqual({ action: "continue", round: 1 })
      expect(decideAutoContinue(true, 4, outcome)).toEqual({ action: "continue", round: 5 })
    }
  })

  test("gives up at the cap, clearing the counter without continuing", () => {
    expect(decideAutoContinue(true, 5, "failed")).toEqual({ action: "giveup" })
    expect(decideAutoContinue(true, 7, "timeout")).toEqual({ action: "giveup" })
  })

  test("ignores disabled mode but cleans a stale counter", () => {
    expect(decideAutoContinue(false, 1, "failed")).toEqual({ action: "reset" })
    expect(decideAutoContinue(false, 0, "failed")).toEqual({ action: "none" })
  })

  test("ignores outcomes that are not failures", () => {
    expect(decideAutoContinue(true, 0, "interrupted")).toEqual({ action: "none" })
    expect(decideAutoContinue(true, 0, undefined)).toEqual({ action: "none" })
  })

  test("a failing chain continues five times then gives up with a cleared counter", () => {
    let count = 0
    const actions = ["failed", "failed", "failed", "failed", "failed", "failed"].map((outcome) => {
      const decision = decideAutoContinue(true, count, outcome)
      if (decision.action === "continue") count = decision.round
      if (decision.action === "giveup") count = 0
      return decision.action
    })
    expect(actions).toEqual(["continue", "continue", "continue", "continue", "continue", "giveup"])
    expect(count).toBe(0)
  })
})

describe("autoContinueDelayMs", () => {
  test("scales exponentially per round within the jitter band", () => {
    // Full jitter: rand=0 -> half the window; rand≈1 -> the full window.
    expect(autoContinueDelayMs(1, 0)).toBe(15_000)
    expect(autoContinueDelayMs(1, 0.999)).toBeLessThan(30_000)
    expect(autoContinueDelayMs(2, 0)).toBe(30_000)
    expect(autoContinueDelayMs(3, 0)).toBe(60_000)
    expect(autoContinueDelayMs(5, 0)).toBe(240_000)
  })

  test("stays inside the jitter band for any draw", () => {
    for (let round = 1; round <= 5; round += 1) {
      const low = (AUTO_CONTINUE_BASE_DELAY_MS * 2 ** Math.min(round - 1, 4)) / 2
      const high = Math.min(AUTO_CONTINUE_MAX_DELAY_MS, low * 2)
      const sample = autoContinueDelayMs(round, 0.42)
      expect(sample).toBeGreaterThanOrEqual(low)
      expect(sample).toBeLessThanOrEqual(high)
    }
    expect(autoContinueDelayMs(9, 0.999)).toBeLessThanOrEqual(AUTO_CONTINUE_MAX_DELAY_MS)
  })
})

describe("finishNotificationWord", () => {  test("maps persisted outcomes to their notification word", () => {
    expect(finishNotificationWord("done", "anything")).toBe("done")
    expect(finishNotificationWord("failed", "anything")).toBe("fail")
    expect(finishNotificationWord("error", "anything")).toBe("fail")
    expect(finishNotificationWord("interrupted", "anything")).toBe("interrupted")
    expect(finishNotificationWord("timeout", "anything")).toBe("timeout")
  })

  test("falls back to renderFinal trailing markers for legacy results", () => {
    expect(finishNotificationWord(undefined, "answer\n\nDone.")).toBe("done")
    expect(finishNotificationWord(undefined, "answer\n\nFailed.")).toBe("fail")
    expect(finishNotificationWord(undefined, "answer\n\nError.")).toBe("fail")
    expect(finishNotificationWord(undefined, "answer\n\nInterrupted.")).toBe("interrupted")
    expect(finishNotificationWord(undefined, "answer\n\nTimed out.")).toBe("timeout")
    // A truncated tail hides the marker; a finished-looking result stays done.
    expect(finishNotificationWord(undefined, "partial text without marker")).toBe("done")
  })
})
