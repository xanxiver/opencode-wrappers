import { Cause, Clock, Context, Effect, FiberMap, FileSystem, Layer, Option, Path, Random, Ref, Schedule, Schema, Semaphore } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { Buffer } from "node:buffer"
import {
  AppConfigTag,
  TELEGRAM_CONTROLLER_BOT_KEY,
  type AppConfig,
} from "../config.js"
import type { Attachment } from "../core/attachments.js"
import {
  DurableExecutorStore,
  DurableExecutorError,
  DurableLeaseLost,
  PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID,
  type DurableJob,
  type DurableJobLease,
  type DurableJobState,
  type DurableExecutorRepository,
} from "../core/durable-executor.js"
import { logBoundary } from "../core/logging.js"
import { GitChanges, type GitChangesService } from "../core/git-changes.js"
import { OpenCode, type OpenCodeError, type OpenCodeService } from "../core/opencode.js"
import { Sessions, type SessionsError, type SessionsService } from "../core/sessions.js"
import { Store, type StoredModel, type StoreError, type StoreService } from "../core/store.js"
import { DEFAULT_STREAM_VERBOSITY, StreamVerbositySchema, type StreamVerbosity } from "../core/stream-verbosity.js"
import { AttachmentDownloadError, collectAttachments, FileValidationError } from "./files.js"
import { sendText } from "./handlers/shared.js"
import {
  controllerRoute,
  conversationId,
  deliveryRoute,
  TelegramDeliveryRouteSchema,
  type TelegramDeliveryRoute,
} from "./conversation.js"
import {
  AgentSwitchError,
  limitMedia,
  ModelSwitchError,
  recoveredResponseFromHistory,
  runPrompt,
  type RunFinalization,
} from "./run.js"
import { MessageSchema, TelegramApi, type ApiError, type Message, type TelegramDeliveryClient } from "./api.js"
import { PermissionRegistry } from "./permissions.js"
import { QuestionRegistry } from "./questions.js"
import { reconcilePendingSession } from "./resurface.js"
import type { InteractionStoreError } from "./interaction-store.js"
import { InteractionStore } from "./interaction-store.js"
import { renderFinal, truncate, appendChangesSummary, renderRunQueue, type RunQueueItem } from "./render.js"
import { renderTelegramMermaid } from "./mermaid.js"
import { resolveEffectiveModel } from "./models.js"
import { SessionSelection } from "./session-selection.js"
import {
  TelegramDeliveryAssignments,
  type DeliveryAssignmentError,
} from "./delivery-assignments.js"
import { DeliveryBotUnavailable, TelegramBotPool } from "./bot-pool.js"

const TelegramJobPayloadSchema = Schema.Struct({
  chatId: Schema.Number,
  threadId: Schema.optional(Schema.Number),
  conversationId: Schema.optional(Schema.String),
  controllerRoute: Schema.optional(TelegramDeliveryRouteSchema),
  runDeliveryRoute: Schema.optional(TelegramDeliveryRouteSchema),
  assignmentGeneration: Schema.optional(Schema.Number),
  message: MessageSchema,
  text: Schema.String,
  sessionID: Schema.String,
  directory: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String,
    mime: Schema.String,
    base64: Schema.String,
  }))),
  reconnect: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.Struct({
    id: Schema.String,
    providerID: Schema.String,
    variant: Schema.optional(Schema.String),
  })),
  agent: Schema.optional(Schema.String),
  // Optional so jobs accepted before stream verbosity existed still decode.
  verbosity: Schema.optional(StreamVerbositySchema),
})
type TelegramJobPayloadEncoded = Schema.Schema.Type<typeof TelegramJobPayloadSchema>
type TelegramJobPayload = TelegramJobPayloadEncoded & {
  readonly conversationId: string
  readonly controllerRoute: TelegramDeliveryRoute
  readonly runDeliveryRoute: TelegramDeliveryRoute
  readonly assignmentGeneration: number
}

/** Force reconnect reroutes controller interactions without moving run output. */
export const forceReconnectPayload = (
  payload: TelegramJobPayload,
  route: { readonly chatId: number; readonly threadId?: number },
): TelegramJobPayload => ({
  ...payload,
  controllerRoute: controllerRoute(route),
})

/** Normalize legacy jobs to explicit controller ownership before any delivery. */
export const normalizeTelegramJobPayload = (payload: TelegramJobPayloadEncoded): TelegramJobPayload => {
  const destination = { chatId: payload.chatId, threadId: payload.threadId }
  return {
    ...payload,
    conversationId: payload.conversationId ?? conversationId(destination),
    controllerRoute: payload.controllerRoute ?? controllerRoute(destination),
    runDeliveryRoute: payload.runDeliveryRoute ?? deliveryRoute(TELEGRAM_CONTROLLER_BOT_KEY, destination),
    assignmentGeneration: payload.assignmentGeneration ?? 0,
  }
}

export const encodeAttachmentSnapshots = (attachments: readonly Attachment[]) => attachments.map((attachment) => ({
  name: attachment.name,
  mime: attachment.mime,
  base64: Buffer.from(attachment.bytes).toString("base64"),
}))

export const decodeAttachmentSnapshots = (attachments: NonNullable<TelegramJobPayload["attachments"]>): readonly Attachment[] =>
  attachments.map((attachment) => ({
    name: attachment.name,
    mime: attachment.mime,
    bytes: new Uint8Array(Buffer.from(attachment.base64, "base64")),
  }))

const PersistedFinalization = Schema.Struct({
  text: Schema.String,
  // Older persisted results predate the outcome field; the notification word
  // then falls back to reading renderFinal's trailing marker.
  outcome: Schema.optional(Schema.String),
  media: Schema.Array(Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    mime: Schema.String,
    base64: Schema.String,
    delivery: Schema.optional(Schema.Literal("document")),
  })),
})
type PersistedFinalization = Schema.Schema.Type<typeof PersistedFinalization>

const encodeFinalization = (result: RunFinalization): string => JSON.stringify({
  text: result.text,
  outcome: result.outcome,
  media: result.media.map((media) => ({
    key: media.key,
    name: media.name,
    mime: media.mime,
    base64: Buffer.from(media.bytes).toString("base64"),
    delivery: media.delivery,
  })),
} satisfies PersistedFinalization)

const decodeFinalization = (value: string): Effect.Effect<PersistedFinalization, unknown> =>
  Effect.try({ try: () => JSON.parse(value), catch: (cause) => cause }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PersistedFinalization)),
  )

export interface TelegramDurableExecutorService {
  readonly submit: (chatId: number, message: Message, text: string, agent?: string) => Effect.Effect<
    void,
    DurableExecutorError | SessionsError | StoreError | AttachmentDownloadError | OpenCodeError | DeliveryAssignmentError
  >
  /** Reset only when the conversation's current durable run pipeline is empty. */
  readonly resetConversation: (chatId: number, threadId?: number) =>
    Effect.Effect<"reset" | "blocked", DurableExecutorError | SessionsError>
  readonly reconnect: (chatId: number, message: Message, force: boolean) => Effect.Effect<void, DurableExecutorError | InteractionStoreError | OpenCodeError | SessionsError | StoreError | DeliveryAssignmentError>
  readonly listReviews: (chatId: number, threadId?: number) => Effect.Effect<void, DurableExecutorError | SessionsError | InteractionStoreError>
  readonly resolveReview: (chatId: number, reviewID: string, threadId?: number) => Effect.Effect<void, DurableExecutorError | SessionsError | InteractionStoreError>
  readonly listQueue: (chatId: number, threadId?: number) => Effect.Effect<void, DurableExecutorError>
  readonly moveQueue: (chatId: number, from: number, to: number, threadId?: number) => Effect.Effect<void, DurableExecutorError>
  readonly clearQueue: (chatId: number, threadId?: number) => Effect.Effect<void, DurableExecutorError>
  readonly deleteQueue: (chatId: number, position: number, threadId?: number) => Effect.Effect<void, DurableExecutorError>
}

export class TelegramDurableExecutor extends Context.Service<TelegramDurableExecutor, TelegramDurableExecutorService>()(
  "opencode2-uis/TelegramDurableExecutor",
) {}

const decodePayload = (job: DurableJob): Effect.Effect<TelegramJobPayload, unknown> =>
  Effect.try({ try: () => JSON.parse(job.payload), catch: (cause) => cause }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TelegramJobPayloadSchema)),
    Effect.map(normalizeTelegramJobPayload),
  )

const ownerFor = (sessionID: string): string => `session:${sessionID}`

/** Job states that occupy the run pipeline and are not yet terminal. */
export const RUN_PIPELINE_STATES: readonly DurableJobState[] = ["pending", "dispatching", "running", "finalizing"]

export const hasRunPipeline = (jobs: readonly Pick<DurableJob, "state">[]): boolean =>
  jobs.some((job) => RUN_PIPELINE_STATES.includes(job.state))

type DurableSubmission = Parameters<DurableExecutorRepository["submit"]>[0]

/** Atomically reject a reset while the current session still owns executable work. */
export const resetConversationUsing = (
  lock: Semaphore.Semaphore,
  store: Pick<StoreService, "getSessionIDForConversation">,
  sessions: Pick<SessionsService, "reset">,
  jobs: Pick<DurableExecutorRepository, "listOwner">,
  conversation: string,
): Effect.Effect<"reset" | "blocked", DurableExecutorError | SessionsError> =>
  lock.withPermit(Effect.gen(function* () {
    const sessionID = yield* store.getSessionIDForConversation(conversation)
    if (Option.isSome(sessionID)) {
      const ownerJobs = yield* jobs.listOwner("telegram", ownerFor(sessionID.value))
      if (hasRunPipeline(ownerJobs)) return "blocked"
    }
    yield* sessions.reset(conversation)
    return "reset"
  }))

/** Atomically submit only while the conversation still owns the expected session. */
export const submitForCurrentConversationUsing = (
  lock: Semaphore.Semaphore,
  store: Pick<StoreService, "getSessionIDForConversation">,
  jobs: Pick<DurableExecutorRepository, "submit">,
  conversation: string,
  sessionID: string,
  submission: DurableSubmission,
): Effect.Effect<boolean, DurableExecutorError> =>
  lock.withPermit(store.getSessionIDForConversation(conversation).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(false),
      onSome: (current) => current !== sessionID
        ? Effect.succeed(false)
        : jobs.submit(submission).pipe(Effect.as(true)),
    })),
  ))

/** Run a new submission effect only when this owner has no matching source. */
export const whenSubmissionSourceMissingUsing = <A, E, R>(
  jobs: Pick<DurableExecutorRepository, "listOwner">,
  channel: string,
  owner: string,
  sourceKey: string,
  onMissing: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, DurableExecutorError | E, R> =>
  jobs.listOwner(channel, owner).pipe(
    Effect.flatMap((existing) => existing.some((job) => job.sourceKey === sourceKey)
      ? Effect.succeed(Option.none<A>())
      : onMissing.pipe(Effect.map(Option.some))),
  )

export const agentSwitchRetriesExhausted = (cause: Cause.Cause<unknown>, attempt: number): boolean =>
  attempt >= 3 && Cause.findErrorOption(cause).pipe(
    Option.exists((error) => error instanceof AgentSwitchError),
  )

export const modelSwitchRetriesExhausted = (cause: Cause.Cause<unknown>, attempt: number): boolean =>
  attempt >= 3 && Cause.findErrorOption(cause).pipe(
    Option.exists((error) => error instanceof ModelSwitchError),
  )

export interface RunSelection {
  readonly agent?: string
  readonly model?: StoredModel
}

export interface RunSnapshot extends RunSelection {
  readonly verbosity: StreamVerbosity
}

/** Copy only defined run-snapshot fields into a new durable payload. */
export const runSelectionFields = (selection: RunSelection): RunSelection => {
  if (selection.agent !== undefined && selection.model !== undefined) {
    return { agent: selection.agent, model: selection.model }
  }
  if (selection.agent !== undefined) return { agent: selection.agent }
  if (selection.model !== undefined) return { model: selection.model }
  return {}
}

/** Copy immutable run settings, defaulting old payloads to normal streaming. */
export const runSnapshotFields = (
  selection: RunSelection,
  verbosity: StreamVerbosity | undefined,
): RunSnapshot => ({
  ...runSelectionFields(selection),
  verbosity: verbosity ?? DEFAULT_STREAM_VERBOSITY,
})

/** Snapshot the agent and model before a durable Telegram job is accepted. */
export const resolveRunSelectionUsing = (
  store: Pick<StoreService, "getDirectoryModelFallback" | "getSessionAgentModel">,
  opencode: Pick<OpenCodeService, "getSession" | "listAgents">,
  input: {
    readonly sessionID: string
    readonly directory: string
    readonly agent?: string
  },
): Effect.Effect<RunSelection, OpenCodeError> =>
  Effect.gen(function* () {
    const session = yield* opencode.getSession(input.sessionID)
    const agent = input.agent ?? session.agent
    const sessionAgentModel = agent === undefined
      ? Option.none<StoredModel>()
      : yield* store.getSessionAgentModel(input.sessionID, agent)
    const directoryFallback = yield* store.getDirectoryModelFallback(input.directory)
    const agentConfig = agent === undefined || Option.isSome(sessionAgentModel)
      ? undefined
      : (yield* opencode.listAgents(input.directory)).find((candidate) => candidate.id === agent)?.model
    const effectiveModel = resolveEffectiveModel({
      sessionAgent: Option.getOrUndefined(sessionAgentModel),
      agentConfig,
      session: session.model,
      directory: Option.getOrUndefined(directoryFallback),
    })
    const selection: RunSelection = {}
    if (agent !== undefined) Object.assign(selection, { agent })
    if (Option.isSome(effectiveModel)) Object.assign(selection, { model: effectiveModel.value.model })
    return selection
  })

/**
 * Build queue items from the run-pipeline jobs of a session, in execution
 * order. A job whose payload cannot be decoded still appears with
 * an empty prompt so the queue stays visible.
 */
export const runQueueItems = (jobs: readonly DurableJob[]): Effect.Effect<readonly RunQueueItem[], never> =>
  Effect.forEach(
    jobs.filter((job) => RUN_PIPELINE_STATES.includes(job.state)),
    (job) =>
      decodePayload(job).pipe(
        Effect.option,
        Effect.map((payload) => ({
          id: job.id,
          state: job.state,
          text: Option.isSome(payload) ? payload.value.text : "",
          movable: job.state === "pending" && job.leaseGeneration === undefined,
        })),
      ),
  )

/** Max consecutive auto-continue prompts before giving up. */
export const AUTO_CONTINUE_MAX = 5

/** Base for the auto-continue backoff; round N waits 2^(N-1) × base (jittered). */
export const AUTO_CONTINUE_BASE_DELAY_MS = 30_000

/** Hard ceiling for a single auto-continue delay. */
export const AUTO_CONTINUE_MAX_DELAY_MS = 10 * 60 * 1000

/**
 * Full-jitter exponential backoff for auto-continue round N (1-based):
 * a random value in [base·2^(N-1)/2, base·2^(N-1)], capped at the ceiling.
 * `rand` is a number in [0, 1).
 */
export const autoContinueDelayMs = (round: number, rand: number): number => {
  const step = Math.max(0, Math.min(round - 1, 4))
  const half = (AUTO_CONTINUE_BASE_DELAY_MS * 2 ** step) / 2
  return Math.min(AUTO_CONTINUE_MAX_DELAY_MS, Math.floor(half + rand * half))
}

/** Outcomes that qualify for an automatic continue prompt. */
const AUTO_CONTINUE_OUTCOMES: readonly string[] = ["failed", "error", "timeout"]

export type AutoContinueDecision =
  | { readonly action: "none" }
  | { readonly action: "reset" }
  | { readonly action: "giveup" }
  | { readonly action: "continue"; readonly round: number }

type PreparedAutoContinue = AutoContinueDecision | { readonly action: "rejected" }

/**
 * Decide what to do after a finished run. Success resets the consecutive
 * counter; qualifying failures increment it and continue while under the
 * cap. A failure at the cap gives up: it clears the counter so a later,
 * independent failure starts a fresh cycle, and never continues a fourth
 * time inside one chain.
 */
export const decideAutoContinue = (
  enabled: boolean,
  currentCount: number,
  outcome: string | undefined,
): AutoContinueDecision => {
  if (outcome === "done") return currentCount > 0 ? { action: "reset" } : { action: "none" }
  if (!AUTO_CONTINUE_OUTCOMES.includes(outcome ?? "")) return { action: "none" }
  if (!enabled) return currentCount > 0 ? { action: "reset" } : { action: "none" }
  if (currentCount >= AUTO_CONTINUE_MAX) return { action: "giveup" }
  return { action: "continue", round: currentCount + 1 }
}

export const finalEditDisposition = (error: Pick<ApiError, "description" | "transient">): "accepted" | "retry" | "fail" => {
  if (error.description?.toLowerCase().includes("message is not modified") === true) return "accepted"
  return error.transient ? "retry" : "fail"
}

/** Short reply word sent under a finished run so Telegram notifies. */
export type FinishWord = "done" | "fail" | "interrupted" | "timeout"

/**
 * Map a persisted outcome to its notification word. Legacy results without
 * an outcome fall back to renderFinal's trailing marker; when truncation
 * removed that marker too, a finished-looking result is reported as done.
 */
export const finishNotificationWord = (outcome: string | undefined, finalText: string): FinishWord => {
  if (outcome === "done") return "done"
  if (outcome === "interrupted") return "interrupted"
  if (outcome === "timeout") return "timeout"
  if (outcome !== undefined) return "fail"
  if (finalText.endsWith("Interrupted.")) return "interrupted"
  if (finalText.endsWith("Timed out.")) return "timeout"
  if (finalText.endsWith("Failed.") || finalText.endsWith("Error.")) return "fail"
  return "done"
}

/** Apply the durable terminal transition for a failed final Telegram edit. */
export const settleFinalEditError = (
  jobs: DurableExecutorRepository,
  lease: Pick<DurableJobLease, "generation"> & { readonly job: Pick<DurableJob, "id"> },
  error: ApiError,
): Effect.Effect<boolean, ApiError | DurableExecutorError | DurableLeaseLost> => {
  const disposition = finalEditDisposition(error)
  if (disposition === "accepted") return Effect.succeed(true)
  if (disposition === "retry") return Effect.fail(error)
  return jobs.fail(
    lease.job.id,
    lease.generation,
    `final Telegram edit was rejected: ${error.description ?? error.operation}`,
  ).pipe(Effect.as(false))
}

const compactPreview = (value: string): string => truncate(value.replace(/\s+/g, " ").trim(), 300)

/** Render retained review evidence without exposing attachment contents. */
export const redactedReviewEvidence = (job: DurableJob): Effect.Effect<string> => Effect.gen(function* () {
  const payload = yield* decodePayload(job).pipe(Effect.option)
  const finalization = job.terminalResult === undefined
    ? Option.none<PersistedFinalization>()
    : yield* decodeFinalization(job.terminalResult).pipe(Effect.option)
  const payloadLines = Option.match(payload, {
    onNone: () => ["Prompt: unavailable", "Attachments: unavailable"],
    onSome: (value) => [
      `Prompt: ${compactPreview(value.text) || "(empty)"}`,
      `Attachments: ${value.attachments?.map((attachment) => `${attachment.name} (${attachment.mime}, about ${Math.floor(attachment.base64.length * 3 / 4)} bytes)`).join(", ") || "none"}`,
    ],
  })
  const resultLine = Option.match(finalization, {
    onNone: () => "Terminal result: not retained",
    onSome: (value) => `Terminal result: ${compactPreview(value.text) || "(empty)"}; ${value.media.length} media item(s)`,
  })
  return [...payloadLines, resultLine].join("\n")
})

/** Resolve only a review that belongs to the caller's current durable owner. */
export const resolveOwnedDurableReview = (
  jobs: DurableExecutorRepository,
  owner: string,
  reviewID: string,
): Effect.Effect<boolean, DurableExecutorError> => Effect.gen(function* () {
  const reviews = yield* jobs.listOwner("telegram", owner)
  if (!reviews.some((job) => job.id === reviewID && job.state === "needs_review")) return false
  return yield* jobs.resolveReview(reviewID)
})

/**
 * Append a bounded working-tree changes summary to a finalization. The
 * enriched text is persisted with the job, so a later Telegram retry replays
 * the same summary instead of resampling a repository that may have changed.
 * Git failures never fail the run: the cause is logged and the block is
 * marked unavailable.
 */
export const withChangesSummaryUsing = (
  gitChanges: GitChangesService,
  result: RunFinalization,
  directory: string,
): Effect.Effect<RunFinalization, never> =>
  gitChanges.summarize(directory).pipe(
    Effect.map((changes) => ({ ...result, text: appendChangesSummary(result.text, changes) })),
    Effect.catchCause((cause) =>
      logBoundary("telegram/executor", "git-changes", "changes summary collection failed")(cause).pipe(
        Effect.map(() => ({
          ...result,
          text: appendChangesSummary(result.text, { kind: "unavailable" } as const),
        })),
      ),
    ),
  )

export const TelegramDurableExecutorLive: Layer.Layer<
  TelegramDurableExecutor,
  never,
  DurableExecutorStore | Sessions | Store | OpenCode | TelegramApi | TelegramBotPool | TelegramDeliveryAssignments | AppConfig | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | PermissionRegistry | QuestionRegistry | GitChanges | InteractionStore | SessionSelection
> = Layer.effect(
  TelegramDurableExecutor,
  Effect.gen(function* () {
    const jobs = yield* DurableExecutorStore
    const sessions = yield* Sessions
    const store = yield* Store
    const opencode = yield* OpenCode
    yield* TelegramApi
    const botPool = yield* TelegramBotPool
    const deliveryAssignments = yield* TelegramDeliveryAssignments
    yield* AppConfigTag
    yield* FileSystem.FileSystem
    yield* Path.Path
    const permissionRegistry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    const gitChanges = yield* GitChanges
    const interaction = yield* InteractionStore
    const selections = yield* SessionSelection
    const context = yield* Effect.context<DurableExecutorStore | Sessions | Store | OpenCode | TelegramApi | TelegramBotPool | TelegramDeliveryAssignments | AppConfig | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | PermissionRegistry | QuestionRegistry | GitChanges | InteractionStore | SessionSelection>()
    const fibers = yield* FiberMap.make<string, void, never>()
    const conversationLocks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
    const conversationLockFor = (conversation: string): Effect.Effect<Semaphore.Semaphore> =>
      Ref.modify(conversationLocks, (locks) => {
        const existing = locks.get(conversation)
        if (existing !== undefined) return [existing, locks]
        const lock = Semaphore.makeUnsafe(1)
        return [lock, new Map(locks).set(conversation, lock)]
      })
    const submitForCurrentConversation = (
      conversation: string,
      sessionID: string,
      submission: DurableSubmission,
    ): Effect.Effect<boolean, DurableExecutorError> => conversationLockFor(conversation).pipe(
      Effect.flatMap((lock) => submitForCurrentConversationUsing(
        lock,
        store,
        jobs,
        conversation,
        sessionID,
        submission,
      )),
    )
    const resolveDeliveryOwnership = (
      conversation: string,
      sessionID: string,
      chatId: number,
      threadId?: number,
    ): Effect.Effect<{
      readonly route: TelegramDeliveryRoute
      readonly generation: number
    }, DeliveryAssignmentError> => chatId >= 0
      ? Effect.succeed({
          route: controllerRoute({ chatId, threadId }),
          generation: 0,
        })
      : deliveryAssignments.resolve(conversation, sessionID, chatId).pipe(
          Effect.map((assignment) => ({
            route: deliveryRoute(assignment.deliveryBotKey, { chatId, threadId }),
            generation: assignment.generation,
          })),
        )
    yield* Effect.addFinalizer(() => FiberMap.clear(fibers).pipe(
      Effect.andThen(jobs.releaseWorkerLeases),
      Effect.catchCause((cause) => logBoundary("telegram/executor", "durable-store", "release worker leases failed")(cause)),
    ))

    const deliverPersistedFinal = (lease: DurableJobLease, payload: TelegramJobPayload) =>
      Effect.gen(function* () {
        const deliveryApi = yield* botPool.getClient(payload.runDeliveryRoute.botKey)
        const encoded = lease.job.terminalResult
        if (encoded === undefined) {
          yield* jobs.fail(lease.job.id, lease.generation, "finalizing job has no terminal result", true)
          return
        }
        const result = yield* decodeFinalization(encoded)
        let progressMessageID = lease.job.progressMessageID
        if (progressMessageID === undefined) {
          yield* jobs.fail(lease.job.id, lease.generation, "finalizing job has no durable Telegram anchor", true)
          yield* sendText(
            payload.controllerRoute.chatId,
            "The run finished, but its Telegram delivery anchor is missing. The result was not sent again.",
            payload.controllerRoute.threadId,
          )
          return
        }
        if (lease.job.mediaDeliveryIndex !== undefined) {
          yield* jobs.fail(
            lease.job.id,
            lease.generation,
            `media delivery ${lease.job.mediaDeliveryIndex} has an uncertain outcome`,
            true,
          )
          yield* sendText(
            payload.controllerRoute.chatId,
            "A media upload may have completed before tracking stopped. It was not uploaded again.",
            payload.controllerRoute.threadId,
          )
          return
        }
        const finalEditSucceeded = yield* deliveryApi.editMessageText({
          chatId: payload.runDeliveryRoute.chatId,
          messageId: progressMessageID,
          text: result.text,
          priority: "final",
        }).pipe(
          Effect.as(true),
          Effect.catchTag("ApiError", (error) => settleFinalEditError(jobs, lease, error)),
        )
        if (!finalEditSucceeded) return
        // A new reply (unlike an edit) makes Telegram notify the user that
        // this run finished, with the outcome as the whole message.
        const word = finishNotificationWord(result.outcome, result.text)
        yield* deliveryApi.sendMessage({
          chatId: payload.runDeliveryRoute.chatId,
          text: word,
          messageThreadId: payload.runDeliveryRoute.threadId,
          replyToMessageId: progressMessageID,
        }).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/executor", "telegram-notification", "finish notification failed")(cause),
          ),
        )
        for (let index = lease.job.deliveredMediaCount; index < result.media.length; index += 1) {
          const media = result.media[index]
          if (media === undefined) continue
          const mediaInput = {
            chatId: payload.runDeliveryRoute.chatId,
            bytes: Buffer.from(media.base64, "base64"),
            name: media.name,
            mime: media.mime,
            caption: truncate(media.name, 1024),
            messageThreadId: payload.runDeliveryRoute.threadId,
            replyToMessageId: progressMessageID,
            retryTransient: false,
          }
          let upload = deliveryApi.sendDocument(mediaInput)
          if (media.delivery !== "document" && media.mime.startsWith("image/")) upload = deliveryApi.sendPhoto(mediaInput)
          else if (media.mime.startsWith("video/")) upload = deliveryApi.sendVideo(mediaInput)
          yield* jobs.beginMediaDelivery(lease.job.id, lease.generation, index)
          yield* upload
          yield* jobs.markMediaDelivered(lease.job.id, lease.generation, index + 1)
        }
        const autoContinue = yield* prepareAutoContinue(lease, payload, result.outcome, progressMessageID).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/executor", "auto-continue", "auto continue preparation failed")(cause).pipe(
              Effect.as<PreparedAutoContinue>({ action: "none" }),
            ),
          ),
        )
        yield* jobs.complete(lease.job.id, lease.generation)
        yield* finishAutoContinue(autoContinue, payload, progressMessageID, deliveryApi).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/executor", "auto-continue", "auto continue handling failed")(cause),
          ),
        )
      })

    const autoContinueKey = (sessionID: string): string => `autocontinue:${sessionID}`

    const prepareAutoContinue = (
      lease: DurableJobLease,
      payload: TelegramJobPayload,
      outcome: string | undefined,
      progressMessageID: number,
    ): Effect.Effect<PreparedAutoContinue, DurableExecutorError | StoreError | InteractionStoreError> => Effect.gen(function* () {
      const conversation = payload.conversationId
      const enabled = yield* store.getAutoContinue(conversation)
      const storedCount = yield* interaction.get(autoContinueKey(payload.sessionID))
      const currentCount = Option.isSome(storedCount) ? Number(storedCount.value) || 0 : 0
      const decision = decideAutoContinue(enabled, currentCount, outcome)

      if (decision.action !== "continue") return decision

      // Queue a minimal "continue" prompt into the same session and topic.
      // Attachments are intentionally not re-downloaded; the model and agent
      // snapshots carry over so the retry runs with the same configuration.
      const syntheticMessage: Message = {
        message_id: progressMessageID > 0 ? progressMessageID : 0,
        chat: { id: payload.controllerRoute.chatId },
        text: "continue",
      }
      if (payload.controllerRoute.threadId !== undefined) {
        Object.assign(syntheticMessage, { message_thread_id: payload.controllerRoute.threadId })
      }
      const nextPayload: TelegramJobPayload = {
        chatId: payload.controllerRoute.chatId,
        message: syntheticMessage,
        text: "continue",
        sessionID: payload.sessionID,
        directory: payload.directory,
        conversationId: payload.conversationId,
        controllerRoute: payload.controllerRoute,
        runDeliveryRoute: payload.runDeliveryRoute,
        assignmentGeneration: payload.assignmentGeneration,
        ...runSnapshotFields(payload, payload.verbosity),
      }
      if (payload.controllerRoute.threadId !== undefined) {
        Object.assign(nextPayload, { threadId: payload.controllerRoute.threadId })
      }
      const now = yield* Clock.currentTimeMillis
      const rand = (yield* Random.nextIntBetween(0, 999)) / 1000
      const availableAt = now + autoContinueDelayMs(decision.round, rand)
      const submitted = yield* submitForCurrentConversation(conversation, payload.sessionID, {
        sourceKey: `telegram:${conversation}:continue:${lease.job.id}`,
        channel: "telegram",
        owner: ownerFor(payload.sessionID),
        sessionID: payload.sessionID,
        payload: JSON.stringify(nextPayload),
        availableAt,
        queuePosition: "front",
      })
      return submitted ? decision : { action: "rejected" }
    })

    const finishAutoContinue = (
      prepared: PreparedAutoContinue,
      payload: TelegramJobPayload,
      progressMessageID: number,
      deliveryApi: TelegramDeliveryClient,
    ) => Effect.gen(function* () {
      const notify = (text: string) => deliveryApi.sendMessage({
        chatId: payload.runDeliveryRoute.chatId,
        text,
        messageThreadId: payload.runDeliveryRoute.threadId,
        replyToMessageId: progressMessageID > 0 ? progressMessageID : undefined,
      }).pipe(
        Effect.catchCause((cause) =>
          logBoundary("telegram/executor", "telegram-notification", "auto continue notice failed")(cause),
        ),
      )

      if (prepared.action === "reset" || prepared.action === "rejected") {
        yield* interaction.set(autoContinueKey(payload.sessionID), 0).pipe(
          Effect.catchCause((cause) => logBoundary("telegram/executor", "auto-continue", "counter reset failed")(cause)),
        )
        return
      }
      if (prepared.action === "giveup") {
        yield* interaction.set(autoContinueKey(payload.sessionID), 0).pipe(
          Effect.catchCause((cause) => logBoundary("telegram/executor", "auto-continue", "counter reset failed")(cause)),
        )
        yield* notify(`Auto-continue stopped after ${AUTO_CONTINUE_MAX} attempts. Send /prompt to try again.`)
        return
      }
      if (prepared.action === "continue") {
        yield* interaction.set(autoContinueKey(payload.sessionID), prepared.round)
        yield* notify(`Auto-continue ${prepared.round}/${AUTO_CONTINUE_MAX}…`)
      }
    })

    const execute = (lease: DurableJobLease) =>
      Effect.gen(function* () {
        const payload = yield* decodePayload(lease.job)
        yield* Effect.annotateLogs({
          controllerBotKey: payload.controllerRoute.botKey,
          deliveryBotKey: payload.runDeliveryRoute.botKey,
          conversationId: payload.conversationId,
          chatId: payload.runDeliveryRoute.chatId,
          threadId: payload.runDeliveryRoute.threadId,
          sessionID: payload.sessionID,
          assignmentGeneration: payload.assignmentGeneration,
          legacyOwnership: payload.assignmentGeneration === 0,
        })(Effect.logDebug("executing Telegram durable delivery"))
        if (lease.job.progressMessageID === PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID) {
          yield* jobs.fail(
            lease.job.id,
            lease.generation,
            "initial Telegram progress-message delivery has an uncertain outcome",
            true,
          )
          yield* sendText(
            payload.controllerRoute.chatId,
            "The initial status message may have been created before tracking stopped. The run was not started again.",
            payload.controllerRoute.threadId,
          )
          return
        }
        if (lease.recoveredFrom === "finalizing") {
          yield* deliverPersistedFinal(lease, payload)
          return
        }

        if (lease.recoveredFrom === "dispatching") {
          yield* jobs.fail(
            lease.job.id,
            lease.generation,
            "the executor restarted while OpenCode prompt acceptance was uncertain",
            true,
          )
          yield* sendText(
            payload.controllerRoute.chatId,
            "The bot restarted while OpenCode prompt acceptance was uncertain. The prompt was not submitted again.",
            payload.controllerRoute.threadId,
          )
          return
        }

        const recoveringRun = lease.recoveredFrom === "running"
        const reconnect = payload.reconnect === true || recoveringRun
        if (recoveringRun) {
          const active = yield* opencode.activeSessions()
          if (!active.includes(payload.sessionID)) {
            if (lease.job.inputID !== undefined) {
              const response = yield* recoveredResponseFromHistory(payload.sessionID, lease.job.inputID)
              if (Option.isSome(response)) {
                const rendered = yield* renderTelegramMermaid(renderFinal(response.value.text, "done"))
                const finalization = yield* withChangesSummaryUsing(gitChanges, {
                  text: truncate(rendered.text),
                  media: limitMedia([...rendered.media, ...response.value.media]),
                  outcome: "done",
                }, payload.directory)
                yield* jobs.markFinalizing(lease.job.id, lease.generation, encodeFinalization(finalization))
                const current = yield* jobs.get(lease.job.id)
                if (Option.isSome(current)) {
                  yield* deliverPersistedFinal({ ...lease, job: current.value, recoveredFrom: "finalizing" }, payload)
                  return
                }
              }
            }
            yield* jobs.fail(
              lease.job.id,
              lease.generation,
              "the executor restarted after dispatch, but the OpenCode run is no longer active",
              true,
            )
            yield* sendText(
              payload.controllerRoute.chatId,
              "The previous run ended while the bot was unavailable. Its final response could not be recovered.",
              payload.controllerRoute.threadId,
            )
            return
          }
          yield* jobs.markRunning(lease.job.id, lease.generation, lease.job.inputID)
        } else if (payload.reconnect === true) {
          yield* jobs.markRunning(lease.job.id, lease.generation)
        }

        let filesOption: Option.Option<readonly Attachment[]>
        if (reconnect) {
          filesOption = Option.some([])
        } else if (payload.attachments !== undefined) {
          filesOption = Option.some(decodeAttachmentSnapshots(payload.attachments))
        } else {
          filesOption = yield* collectAttachments(payload.message).pipe(
                Effect.map(Option.some),
                Effect.catchTags({
                FileValidationError: (error: FileValidationError) =>
                  sendText(payload.controllerRoute.chatId, `Error: ${error.message}`, payload.controllerRoute.threadId).pipe(
                    Effect.andThen(jobs.fail(lease.job.id, lease.generation, error.message)),
                    Effect.as(Option.none()),
                  ),
                AttachmentDownloadError: (error: AttachmentDownloadError) => error.transient
                  ? Effect.fail(error)
                  : sendText(payload.controllerRoute.chatId, `Error: ${error.message}`, payload.controllerRoute.threadId).pipe(
                      Effect.andThen(jobs.fail(lease.job.id, lease.generation, error.message)),
                      Effect.as(Option.none()),
                    ),
                }),
              )
        }
        if (Option.isNone(filesOption)) return
        const files = filesOption.value
        const deliveryApi = yield* botPool.getClient(payload.runDeliveryRoute.botKey)
        yield* runPrompt({
          sessionID: payload.sessionID,
          text: payload.text,
          files,
          controllerRoute: payload.controllerRoute,
          runDeliveryRoute: payload.runDeliveryRoute,
          model: payload.model,
          agent: payload.agent,
          verbosity: payload.verbosity ?? DEFAULT_STREAM_VERBOSITY,
          reconnect,
          inputID: lease.job.inputID,
          progressMessageID: lease.job.progressMessageID,
          deliveryApi,
          onProgressDispatching: () => jobs.beginProgressDelivery(lease.job.id, lease.generation),
          onProgressRejected: () => jobs.fail(
            lease.job.id,
            lease.generation,
            "Telegram definitively rejected the initial progress message",
          ),
          onDispatching: () => jobs.markDispatching(lease.job.id, lease.generation),
          onProgressMessage: (messageID) => jobs.markProgressMessage(lease.job.id, lease.generation, messageID),
          onAccepted: (inputID) => jobs.markRunning(lease.job.id, lease.generation, inputID),
          onFinalizing: (result) => withChangesSummaryUsing(gitChanges, result, payload.directory).pipe(
            Effect.andThen((enriched) =>
              jobs.markFinalizing(lease.job.id, lease.generation, encodeFinalization(enriched))
            ),
          ),
        })
        const current = yield* jobs.get(lease.job.id)
        if (Option.isNone(current)) return
        yield* deliverPersistedFinal({ ...lease, job: current.value, recoveredFrom: "finalizing" }, payload)
      })

    const runLease = (lease: DurableJobLease) => {
      const heartbeat = jobs.renew(lease.job.id, lease.generation).pipe(
        Effect.flatMap((active) => active ? Effect.void : Effect.fail(new DurableLeaseLost({ jobID: lease.job.id }))),
        Effect.repeat(Schedule.spaced("30 seconds")),
        Effect.andThen(Effect.never),
      )
      return Effect.raceFirst(execute(lease), heartbeat).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return jobs.release(lease.job.id, lease.generation).pipe(Effect.catchCause(() => Effect.void))
          const leaseLost = Cause.findErrorOption(cause).pipe(Option.exists((error) => error instanceof DurableLeaseLost))
          const deliveryUnavailable = Cause.findErrorOption(cause).pipe(
            Option.exists((error) => error instanceof DeliveryBotUnavailable),
          )
          return logBoundary("telegram/executor", "durable-job", leaseLost ? "durable job lease lost" : "durable job failed")(cause).pipe(
            Effect.andThen(leaseLost
              ? Effect.void
              : jobs.get(lease.job.id).pipe(
                  Effect.flatMap(Option.match({
                    onNone: () => Effect.void,
                    onSome: (current) => {
                      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(current.attempt, 6))
                      if (deliveryUnavailable && RUN_PIPELINE_STATES.includes(current.state)) {
                        return jobs.defer(
                          lease.job.id,
                          lease.generation,
                          "assigned Telegram delivery bot is unavailable",
                          delay,
                        )
                      }
                      if (current.state === "finalizing") {
                        return jobs.defer(lease.job.id, lease.generation, Cause.pretty(cause), delay)
                      }
                      if (current.state === "pending") {
                        if (current.progressMessageID === PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID) {
                          return jobs.fail(
                            lease.job.id,
                            lease.generation,
                            "initial Telegram progress-message delivery has an uncertain outcome",
                            true,
                          )
                        }
                        const agentUnavailable = agentSwitchRetriesExhausted(cause, current.attempt)
                        const modelUnavailable = modelSwitchRetriesExhausted(cause, current.attempt)
                        if (agentUnavailable || modelUnavailable) {
                          return jobs.fail(
                            lease.job.id,
                            lease.generation,
                            Cause.pretty(cause),
                          ).pipe(Effect.andThen(
                            decodePayload(lease.job).pipe(
                              Effect.flatMap((payload) => sendText(
                                payload.controllerRoute.chatId,
                                agentUnavailable
                                  ? "The selected agent is unavailable. The prompt was not run."
                                  : "The selected model is unavailable. The prompt was not run.",
                                payload.controllerRoute.threadId,
                              )),
                              Effect.catchCause((notificationCause) =>
                                logBoundary("telegram/executor", "telegram-notification", "agent failure notification failed")(notificationCause)
                              ),
                            ),
                          ))
                        }
                        return jobs.retry(lease.job.id, lease.generation, Cause.pretty(cause), delay)
                      }
                      if (current.state !== "dispatching" && current.state !== "running") return Effect.void
                      const failed = jobs.fail(lease.job.id, lease.generation, Cause.pretty(cause), true)
                      return failed.pipe(Effect.andThen(
                        decodePayload(lease.job).pipe(
                          Effect.flatMap((payload) => sendText(
                            payload.controllerRoute.chatId,
                            "Run tracking stopped after an uncertain external operation. The prompt was not submitted again.",
                            payload.controllerRoute.threadId,
                          )),
                          Effect.catchCause((notificationCause) => logBoundary("telegram/executor", "telegram-notification", "uncertain run notification failed")(notificationCause)),
                        ),
                      ))
                    },
                  })),
                  Effect.catchCause((storeCause) => logBoundary("telegram/executor", "durable-store", "record job failure failed")(storeCause)),
                )),
          )
        }),
      )
    }

    const startLease = (lease: DurableJobLease): Effect.Effect<void> =>
      FiberMap.run(fibers, lease.job.id, Effect.provide(runLease(lease), context)).pipe(Effect.asVoid)

    const dispatch = Effect.gen(function* () {
      while ((yield* FiberMap.size(fibers)) < 8) {
        const claimed = yield* jobs.claimNext("telegram")
        if (Option.isNone(claimed)) return
        yield* startLease(claimed.value)
      }
    }).pipe(
      Effect.catchCause((cause) => logBoundary("telegram/executor", "durable-store", "dispatcher scan failed")(cause)),
      Effect.repeat(Schedule.fixed("250 millis")),
    )
    yield* Effect.forkScoped(dispatch)
    yield* Effect.forkScoped(jobs.purgeExpiredReviews.pipe(
      Effect.catchCause((cause) => logBoundary("telegram/executor", "durable-store", "review retention cleanup failed")(cause)),
      Effect.repeat(Schedule.spaced("1 hour")),
    ))

    return {
      resetConversation: (chatId, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const lock = yield* conversationLockFor(conversation)
        const result = yield* resetConversationUsing(lock, store, sessions, jobs, conversation)
        if (result === "reset") {
          yield* deliveryAssignments.clear(conversation).pipe(
            Effect.catchCause((cause) => logBoundary(
              "telegram/executor",
              "delivery-assignment",
              "clear assignment after session reset failed",
            )(cause)),
          )
        }
        return result
      }),
      submit: (chatId: number, message: Message, text: string, agent?: string) => Effect.gen(function* () {
        const attachments = yield* collectAttachments(message).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            FileValidationError: (error: FileValidationError) => sendText(chatId, `Error: ${error.message}`, message.message_thread_id).pipe(
              Effect.as(Option.none<readonly Attachment[]>()),
            ),
            AttachmentDownloadError: (error: AttachmentDownloadError) => error.transient
              ? Effect.fail(error)
              : sendText(chatId, `Error: ${error.message}`, message.message_thread_id).pipe(
                  Effect.as(Option.none<readonly Attachment[]>()),
                ),
          }),
        )
        if (Option.isNone(attachments)) return
        const conversation = conversationId({ chatId, threadId: message.message_thread_id })
        const lock = yield* conversationLockFor(conversation)
        yield* lock.withPermit(Effect.gen(function* () {
          const sessionID = yield* sessions.getOrCreate(conversation)
          const owner = ownerFor(sessionID)
          const sourceKey = `telegram:${conversation}:${message.message_id}`
          const submitted = yield* whenSubmissionSourceMissingUsing(
            jobs,
            "telegram",
            owner,
            sourceKey,
            Effect.gen(function* () {
              const directory = yield* sessions.directoryFor(conversation)
              const ownership = yield* resolveDeliveryOwnership(
                conversation,
                sessionID,
                chatId,
                message.message_thread_id,
              )
              return yield* selections.withSession(sessionID, Effect.gen(function* () {
                const selection = yield* resolveRunSelectionUsing(store, opencode, {
                  sessionID,
                  directory,
                  agent,
                })
                const verbosity = yield* store.getStreamVerbosity(conversation)
                const payload: TelegramJobPayload = {
                  chatId,
                  message,
                  text,
                  sessionID,
                  directory,
                  conversationId: conversation,
                  controllerRoute: controllerRoute({ chatId, threadId: message.message_thread_id }),
                  runDeliveryRoute: ownership.route,
                  assignmentGeneration: ownership.generation,
                  attachments: encodeAttachmentSnapshots(attachments.value),
                  ...runSnapshotFields(selection, verbosity),
                }
                if (message.message_thread_id !== undefined) {
                  Object.assign(payload, { threadId: message.message_thread_id })
                }
                return yield* jobs.submit({
                  sourceKey,
                  channel: "telegram",
                  owner,
                  payload: JSON.stringify(payload),
                  sessionID,
                })
              }))
            }),
          )
          if (Option.isNone(submitted) || !submitted.value.created) return
          const ownerJobs = yield* jobs.listOwner("telegram", owner)
          const waitingBehindAnother = ownerJobs.some((job) =>
            job.id !== submitted.value.job.id && RUN_PIPELINE_STATES.includes(job.state))
          if (waitingBehindAnother) {
            yield* sendText(chatId, "Queued. It runs when the current task finishes.", message.message_thread_id)
          }
        }))
      }).pipe(Effect.provide(context)),
      reconnect: (chatId: number, message: Message, force: boolean) => Effect.gen(function* () {
         const threadId = message.message_thread_id
          const conversation = conversationId({ chatId, threadId })
          const directory = yield* sessions.directoryFor(conversation)
          const sessionID = yield* store.getSessionIDForConversation(conversation)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const owner = ownerFor(sessionID.value)
        const active = (yield* jobs.listOwner("telegram", owner)).filter((job) =>
          job.state === "dispatching" || job.state === "running" || job.state === "finalizing"
        )
        if (active.length === 0) {
          const activeSessions = yield* opencode.activeSessions()
          if (!activeSessions.includes(sessionID.value)) {
            yield* sendText(chatId, "The current session has no active run.", threadId)
            return
          }
           const route = { chatId, threadId }
           const verbosity = yield* store.getStreamVerbosity(conversation)
           const ownership = yield* resolveDeliveryOwnership(conversation, sessionID.value, chatId, threadId)
           const payload: TelegramJobPayload = {
            chatId,
            threadId,
            message,
            text: "",
            sessionID: sessionID.value,
              directory,
              conversationId: conversation,
              controllerRoute: controllerRoute(route),
              runDeliveryRoute: ownership.route,
              assignmentGeneration: ownership.generation,
              reconnect: true,
             verbosity,
           }
           const submitted = yield* submitForCurrentConversation(conversation, sessionID.value, {
             sourceKey: `telegram:${conversation}:${message.message_id}`,
             channel: "telegram",
            owner,
            payload: JSON.stringify(payload),
             sessionID: sessionID.value,
           })
           if (!submitted) {
             yield* sendText(chatId, "The session changed before reconnect started.", threadId)
             return
           }
           yield* permissionRegistry.rerouteSession(sessionID.value, route)
           // Reroute each registry independently. A previous partial transfer
           // can leave the permission route current while questions still use
           // the old destination.
           yield* questionRegistry.rerouteSession(sessionID.value, route)
           yield* reconcilePendingSession(directory, sessionID.value, route).pipe(
             Effect.catchCause((cause) =>
               logBoundary("telegram/executor", "pending-interactions", "reconnect interaction reconciliation failed")(cause),
             ),
           )
           return
        }
        if (!force) {
          const existingRoute = yield* permissionRegistry.getSessionRoute(sessionID.value)
          if (Option.isSome(existingRoute)) {
            yield* reconcilePendingSession(directory, sessionID.value, existingRoute.value).pipe(
              Effect.catchCause((cause) =>
                logBoundary("telegram/executor", "pending-interactions", "reconnect interaction reconciliation failed")(cause),
              ),
            )
          }
          yield* sendText(chatId, "The durable executor will recover this run automatically. Use /forceReconnect only if its worker stopped.", threadId)
          return
        }
        const route = { chatId, threadId }
        const activeJob = active[0]
        if (activeJob === undefined) return
        if (activeJob.state === "finalizing") {
          const finalLease = yield* jobs.forceClaim("telegram", owner)
          yield* Option.match(finalLease, {
            onNone: () => sendText(chatId, "The final delivery could not be forcefully claimed.", threadId),
            onSome: (claimed) => startLease(claimed).pipe(
              Effect.andThen(sendText(
                chatId,
                "Final delivery recovery started. The result will remain in its original chat or topic.",
                threadId,
              )),
            ),
          })
          return
        }
        const replacement = yield* decodePayload(activeJob).pipe(
          Effect.mapError((cause) => new DurableExecutorError({ operation: "decode force reconnect payload", cause })),
          Effect.map((payload) => JSON.stringify(forceReconnectPayload(payload, route))),
        )
        const lease = yield* jobs.forceClaim("telegram", owner, replacement)
        yield* Option.match(lease, {
          onNone: () => sendText(chatId, "The active run could not be forcefully claimed.", threadId),
          onSome: (claimed) => Effect.gen(function* () {
            yield* permissionRegistry.rerouteSession(sessionID.value, route)
            yield* questionRegistry.rerouteSession(sessionID.value, route)
            yield* reconcilePendingSession(directory, sessionID.value, route).pipe(
              Effect.catchCause((cause) =>
                logBoundary("telegram/executor", "pending-interactions", "force reconnect interaction reconciliation failed")(cause),
              ),
            )
            yield* startLease(claimed)
          }),
        })
      }).pipe(Effect.provide(context)),
      listReviews: (chatId, threadId) => Effect.gen(function* () {
        yield* jobs.purgeExpiredReviews
         const conversation = conversationId({ chatId, threadId })
         const sessionID = yield* store.getSessionIDForConversation(conversation)
        const permissionReviews = Option.isNone(sessionID)
          ? []
          : yield* permissionRegistry.listUncertainDeliveries(chatId, sessionID.value)
        const questionReviews = Option.isNone(sessionID)
          ? []
          : yield* questionRegistry.listUncertainDeliveries(chatId, sessionID.value)
        const reviews = Option.isNone(sessionID)
          ? []
          : (yield* jobs.listOwner("telegram", ownerFor(sessionID.value))).filter((job) => job.state === "needs_review")
        const durableEvidence = yield* Effect.forEach(reviews, (job) => redactedReviewEvidence(job).pipe(Effect.map((evidence) => [
          `Job: ${job.id}`,
          `Input: ${job.inputID ?? "not recorded"}`,
          `Reason: ${truncate(job.lastError ?? "unknown", 500)}`,
          evidence,
          `Resolve: /resolve_review ${job.id}`,
        ].join("\n"))))
        const deliveryEvidence = [
          ...permissionReviews.map(({ token, entry, failure }) => [
            `Prompt delivery: permission:${token}`,
            `Request: ${entry.requestID}`,
            failure === "uncertain"
              ? "Telegram delivery is uncertain. Retry only after checking the chat."
              : "Telegram rejected this prompt. Retry only after correcting the destination or request.",
            `Retry: /resolve_review permission:${token}`,
          ].join("\n")),
          ...questionReviews.map(({ token, questionIndex, entry, failure }) => [
            `Prompt delivery: question:${token}:${questionIndex}`,
            `Question: ${compactPreview(entry.questions[questionIndex] ?? "unknown")}`,
            failure === "uncertain"
              ? "Telegram delivery is uncertain. Retry only after checking the chat."
              : "Telegram rejected this prompt. Retry only after correcting the destination or request.",
            `Retry: /resolve_review question:${token}:${questionIndex}`,
          ].join("\n")),
        ]
        const evidence = [...durableEvidence, ...deliveryEvidence]
        if (evidence.length === 0) {
          yield* sendText(chatId, "No durable jobs need review for this session.", threadId)
          return
        }
        yield* sendText(chatId, truncate(evidence.join("\n\n")), threadId)
      }).pipe(Effect.provide(context)),
      listQueue: (chatId, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const sessionID = yield* store.getSessionIDForConversation(conversation)
        const ownedJobs = Option.isNone(sessionID)
          ? []
          : (yield* jobs.listOwner("telegram", ownerFor(sessionID.value)))
        const items = yield* runQueueItems(ownedJobs)
        yield* sendText(chatId, truncate(renderRunQueue(items)), threadId)
      }).pipe(Effect.provide(context)),
      moveQueue: (chatId, from, to, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const sessionID = yield* store.getSessionIDForConversation(conversation)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const owner = ownerFor(sessionID.value)
        const moved = yield* jobs.movePending("telegram", owner, from, to)
        if (!moved.moved) {
          yield* moved.count === 0
            ? sendText(chatId, "No queued tasks.", threadId)
            : sendText(chatId, `Choose positions from 1 to ${moved.count}.`, threadId)
          return
        }
        const items = yield* runQueueItems(yield* jobs.listOwner("telegram", owner))
        yield* sendText(chatId, truncate(`Moved task ${from} to position ${to}.\n\n${renderRunQueue(items)}`), threadId)
      }).pipe(Effect.provide(context)),
      clearQueue: (chatId, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const sessionID = yield* store.getSessionIDForConversation(conversation)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const owner = ownerFor(sessionID.value)
        const removed = yield* jobs.clearPending("telegram", owner)
        if (removed === 0) {
          yield* sendText(chatId, "No queued tasks to clear.", threadId)
          return
        }
        const items = yield* runQueueItems(yield* jobs.listOwner("telegram", owner))
        yield* sendText(
          chatId,
          truncate(`Cleared ${removed} queued ${removed === 1 ? "task" : "tasks"}.\n\n${renderRunQueue(items)}`),
          threadId,
        )
      }).pipe(Effect.provide(context)),
      deleteQueue: (chatId, position, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const sessionID = yield* store.getSessionIDForConversation(conversation)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const owner = ownerFor(sessionID.value)
        const result = yield* jobs.deletePending("telegram", owner, position)
        if (!result.deleted) {
          yield* result.count === 0
            ? sendText(chatId, "No queued tasks.", threadId)
            : sendText(chatId, `Choose a position from 1 to ${result.count}.`, threadId)
          return
        }
        const items = yield* runQueueItems(yield* jobs.listOwner("telegram", owner))
        yield* sendText(chatId, truncate(`Deleted task ${position}.\n\n${renderRunQueue(items)}`), threadId)
      }).pipe(Effect.provide(context)),
      resolveReview: (chatId, reviewID, threadId) => Effect.gen(function* () {
        const conversation = conversationId({ chatId, threadId })
        const sessionID = yield* store.getSessionIDForConversation(conversation)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const permissionMatch = /^permission:(\d+)$/.exec(reviewID)
        if (permissionMatch !== null) {
          const token = Number(permissionMatch[1])
          const retried = Number.isSafeInteger(token) && (yield* permissionRegistry.retryUncertainDelivery(token, chatId, sessionID.value))
          yield* sendText(chatId, retried ? "Permission prompt scheduled for retry." : "That permission delivery review was not found.", threadId)
          return
        }
        const questionMatch = /^question:(\d+):(\d+)$/.exec(reviewID)
        if (questionMatch !== null) {
          const token = Number(questionMatch[1])
          const questionIndex = Number(questionMatch[2])
          const retried = Number.isSafeInteger(token) && Number.isSafeInteger(questionIndex) &&
            (yield* questionRegistry.retryUncertainDelivery(token, questionIndex, chatId, sessionID.value))
          yield* sendText(chatId, retried ? "Question prompt scheduled for retry." : "That question delivery review was not found.", threadId)
          return
        }
        const resolved = yield* resolveOwnedDurableReview(jobs, ownerFor(sessionID.value), reviewID)
        yield* sendText(chatId, resolved ? "Review resolved and retained job data removed." : "That review job was not found in the current session.", threadId)
      }).pipe(Effect.provide(context)),
    }
  }),
)
