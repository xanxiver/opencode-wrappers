import { Cause, Context, Effect, FiberMap, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { Buffer } from "node:buffer"
import { AppConfigTag, type AppConfig } from "../config.js"
import type { Attachment } from "../core/attachments.js"
import {
  DurableExecutorStore,
  DurableExecutorError,
  DurableLeaseLost,
  PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID,
  type DurableJob,
  type DurableJobLease,
  type DurableExecutorRepository,
} from "../core/durable-executor.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode, type OpenCodeError } from "../core/opencode.js"
import { Sessions, type SessionsError } from "../core/sessions.js"
import { Store, type StoreError } from "../core/store.js"
import { AttachmentDownloadError, collectAttachments, FileValidationError } from "./files.js"
import { clientId, sendText } from "./handlers/shared.js"
import { recoveredResponseFromHistory, runPrompt, type RunFinalization } from "./run.js"
import { MessageSchema, TelegramApi, type ApiError, type Message } from "./api.js"
import { PermissionRegistry } from "./permissions.js"
import { QuestionRegistry } from "./questions.js"
import { reconcilePendingSession } from "./resurface.js"
import type { InteractionStoreError } from "./interaction-store.js"
import { renderFinal, truncate } from "./render.js"

const TelegramJobPayload = Schema.Struct({
  chatId: Schema.Number,
  threadId: Schema.optional(Schema.Number),
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
})
type TelegramJobPayload = Schema.Schema.Type<typeof TelegramJobPayload>

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
  media: Schema.Array(Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    mime: Schema.String,
    base64: Schema.String,
  })),
})
type PersistedFinalization = Schema.Schema.Type<typeof PersistedFinalization>

const encodeFinalization = (result: RunFinalization): string => JSON.stringify({
  text: result.text,
  media: result.media.map((media) => ({
    key: media.key,
    name: media.name,
    mime: media.mime,
    base64: Buffer.from(media.bytes).toString("base64"),
  })),
} satisfies PersistedFinalization)

const decodeFinalization = (value: string): Effect.Effect<PersistedFinalization, unknown> =>
  Effect.try({ try: () => JSON.parse(value), catch: (cause) => cause }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PersistedFinalization)),
  )

export interface TelegramDurableExecutorService {
  readonly submit: (chatId: number, message: Message, text: string) => Effect.Effect<void, DurableExecutorError | SessionsError | StoreError | AttachmentDownloadError>
  readonly reconnect: (chatId: number, message: Message, force: boolean) => Effect.Effect<void, DurableExecutorError | InteractionStoreError | OpenCodeError | SessionsError | StoreError>
  readonly listReviews: (chatId: number, threadId?: number) => Effect.Effect<void, DurableExecutorError | SessionsError | InteractionStoreError>
  readonly resolveReview: (chatId: number, reviewID: string, threadId?: number) => Effect.Effect<void, DurableExecutorError | SessionsError | InteractionStoreError>
}

export class TelegramDurableExecutor extends Context.Service<TelegramDurableExecutor, TelegramDurableExecutorService>()(
  "opencode2-uis/TelegramDurableExecutor",
) {}

const decodePayload = (job: DurableJob): Effect.Effect<TelegramJobPayload, unknown> =>
  Effect.try({ try: () => JSON.parse(job.payload), catch: (cause) => cause }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TelegramJobPayload)),
  )

const ownerFor = (sessionID: string): string => `session:${sessionID}`

export const finalEditDisposition = (error: Pick<ApiError, "description" | "transient">): "accepted" | "retry" | "fail" => {
  if (error.description?.toLowerCase().includes("message is not modified") === true) return "accepted"
  return error.transient ? "retry" : "fail"
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

export const TelegramDurableExecutorLive: Layer.Layer<
  TelegramDurableExecutor,
  never,
  DurableExecutorStore | Sessions | Store | OpenCode | TelegramApi | AppConfig | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | PermissionRegistry | QuestionRegistry
> = Layer.effect(
  TelegramDurableExecutor,
  Effect.gen(function* () {
    const jobs = yield* DurableExecutorStore
    const sessions = yield* Sessions
    const store = yield* Store
    const opencode = yield* OpenCode
    const api = yield* TelegramApi
    yield* AppConfigTag
    yield* FileSystem.FileSystem
    yield* Path.Path
    const permissionRegistry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    const context = yield* Effect.context<DurableExecutorStore | Sessions | Store | OpenCode | TelegramApi | AppConfig | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | PermissionRegistry | QuestionRegistry>()
    const fibers = yield* FiberMap.make<string, void, never>()
    yield* Effect.addFinalizer(() => FiberMap.clear(fibers).pipe(
      Effect.andThen(jobs.releaseWorkerLeases),
      Effect.catchCause((cause) => logBoundary("telegram/executor", "durable-store", "release worker leases failed")(cause)),
    ))

    const deliverPersistedFinal = (lease: DurableJobLease, payload: TelegramJobPayload) =>
      Effect.gen(function* () {
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
            payload.chatId,
            "The run finished, but its Telegram delivery anchor is missing. The result was not sent again.",
            payload.threadId,
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
            payload.chatId,
            "A media upload may have completed before tracking stopped. It was not uploaded again.",
            payload.threadId,
          )
          return
        }
        const finalEditSucceeded = yield* api.editMessageText({
          chatId: payload.chatId,
          messageId: progressMessageID,
          text: result.text,
        }).pipe(
          Effect.as(true),
          Effect.catchTag("ApiError", (error) => settleFinalEditError(jobs, lease, error)),
        )
        if (!finalEditSucceeded) return
        for (let index = lease.job.deliveredMediaCount; index < result.media.length; index += 1) {
          const media = result.media[index]
          if (media === undefined) continue
          const mediaInput = {
            chatId: payload.chatId,
            bytes: Buffer.from(media.base64, "base64"),
            name: media.name,
            mime: media.mime,
            caption: truncate(media.name, 1024),
            messageThreadId: payload.threadId,
            replyToMessageId: progressMessageID,
            retryTransient: false,
          }
          let upload = api.sendDocument(mediaInput)
          if (media.mime.startsWith("image/")) upload = api.sendPhoto(mediaInput)
          else if (media.mime.startsWith("video/")) upload = api.sendVideo(mediaInput)
          yield* jobs.beginMediaDelivery(lease.job.id, lease.generation, index)
          yield* upload
          yield* jobs.markMediaDelivered(lease.job.id, lease.generation, index + 1)
        }
        yield* jobs.complete(lease.job.id, lease.generation)
      })

    const execute = (lease: DurableJobLease) =>
      Effect.gen(function* () {
        const payload = yield* decodePayload(lease.job)
        if (lease.job.progressMessageID === PROGRESS_DELIVERY_IN_FLIGHT_MESSAGE_ID) {
          yield* jobs.fail(
            lease.job.id,
            lease.generation,
            "initial Telegram progress-message delivery has an uncertain outcome",
            true,
          )
          yield* sendText(
            payload.chatId,
            "The initial status message may have been created before tracking stopped. The run was not started again.",
            payload.threadId,
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
            payload.chatId,
            "The bot restarted while OpenCode prompt acceptance was uncertain. The prompt was not submitted again.",
            payload.threadId,
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
                const finalText = truncate(renderFinal(response.value.text, "done"))
                yield* jobs.markFinalizing(lease.job.id, lease.generation, encodeFinalization({ text: finalText, media: response.value.media }))
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
              payload.chatId,
              "The previous run ended while the bot was unavailable. Its final response could not be recovered.",
              payload.threadId,
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
                  sendText(payload.chatId, `Error: ${error.message}`, payload.threadId).pipe(
                    Effect.andThen(jobs.fail(lease.job.id, lease.generation, error.message)),
                    Effect.as(Option.none()),
                  ),
                AttachmentDownloadError: (error: AttachmentDownloadError) => error.transient
                  ? Effect.fail(error)
                  : sendText(payload.chatId, `Error: ${error.message}`, payload.threadId).pipe(
                      Effect.andThen(jobs.fail(lease.job.id, lease.generation, error.message)),
                      Effect.as(Option.none()),
                    ),
                }),
              )
        }
        if (Option.isNone(filesOption)) return
        const files = filesOption.value
        yield* runPrompt({
          chatId: payload.chatId,
          sessionID: payload.sessionID,
          text: payload.text,
          files,
          threadId: payload.threadId,
          model: payload.model,
          reconnect,
          inputID: lease.job.inputID,
          progressMessageID: lease.job.progressMessageID,
          onProgressDispatching: () => jobs.beginProgressDelivery(lease.job.id, lease.generation),
          onProgressRejected: () => jobs.fail(
            lease.job.id,
            lease.generation,
            "Telegram definitively rejected the initial progress message",
          ),
          onDispatching: () => jobs.markDispatching(lease.job.id, lease.generation),
          onProgressMessage: (messageID) => jobs.markProgressMessage(lease.job.id, lease.generation, messageID),
          onAccepted: (inputID) => jobs.markRunning(lease.job.id, lease.generation, inputID),
          onFinalizing: (result) => jobs.markFinalizing(lease.job.id, lease.generation, encodeFinalization(result)),
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
          return logBoundary("telegram/executor", "durable-job", leaseLost ? "durable job lease lost" : "durable job failed")(cause).pipe(
            Effect.andThen(leaseLost
              ? Effect.void
              : jobs.get(lease.job.id).pipe(
                  Effect.flatMap(Option.match({
                    onNone: () => Effect.void,
                    onSome: (current) => {
                      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(current.attempt, 6))
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
                        return jobs.retry(lease.job.id, lease.generation, Cause.pretty(cause), delay)
                      }
                      if (current.state !== "dispatching" && current.state !== "running") return Effect.void
                      const failed = jobs.fail(lease.job.id, lease.generation, Cause.pretty(cause), true)
                      return failed.pipe(Effect.andThen(
                        decodePayload(lease.job).pipe(
                          Effect.flatMap((payload) => sendText(
                            payload.chatId,
                            "Run tracking stopped after an uncertain external operation. The prompt was not submitted again.",
                            payload.threadId,
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
      submit: (chatId: number, message: Message, text: string) => Effect.gen(function* () {
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
        const sessionID = yield* sessions.getOrCreate(clientId(chatId))
        const directory = yield* sessions.directoryFor(clientId(chatId))
        const model = yield* store.getModel(directory).pipe(Effect.map(Option.getOrUndefined))
        const payload: TelegramJobPayload = {
          chatId,
          message,
          text,
          sessionID,
          directory,
          attachments: encodeAttachmentSnapshots(attachments.value),
        }
        if (message.message_thread_id !== undefined) Object.assign(payload, { threadId: message.message_thread_id })
        if (model !== undefined) Object.assign(payload, { model })
        const submitted = yield* jobs.submit({
          sourceKey: `telegram:${chatId}:${message.message_id}`,
          channel: "telegram",
          owner: ownerFor(sessionID),
          payload: JSON.stringify(payload),
          sessionID,
        })
        if (!submitted.created) return
        const ownerJobs = yield* jobs.listOwner("telegram", ownerFor(sessionID))
        const waitingBehindAnother = ownerJobs.some((job) => job.id !== submitted.job.id && (
          job.state === "dispatching" || job.state === "running" || job.state === "finalizing" || job.state === "pending"
        ))
        if (waitingBehindAnother) {
          yield* sendText(chatId, "Queued. It runs when the current task finishes.", message.message_thread_id)
        }
      }).pipe(Effect.provide(context)),
      reconnect: (chatId: number, message: Message, force: boolean) => Effect.gen(function* () {
        const threadId = message.message_thread_id
        const directory = yield* sessions.directoryFor(clientId(chatId))
        const sessionID = yield* store.getSessionIDForDirectory(directory)
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
          const payload: TelegramJobPayload = {
            chatId,
            threadId,
            message,
            text: "",
            sessionID: sessionID.value,
            directory,
            reconnect: true,
          }
          yield* jobs.submit({
            sourceKey: `telegram:${chatId}:${message.message_id}`,
            channel: "telegram",
            owner,
            payload: JSON.stringify(payload),
            sessionID: sessionID.value,
          })
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
          Effect.map((payload) => JSON.stringify({
            ...payload,
            chatId,
            ...(threadId === undefined ? { threadId: undefined } : { threadId }),
            message,
          })),
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
        const permissionReviews = yield* permissionRegistry.listUncertainDeliveries(chatId)
        const questionReviews = yield* questionRegistry.listUncertainDeliveries(chatId)
        const directory = yield* sessions.directoryFor(clientId(chatId))
        const sessionID = yield* store.getSessionIDForDirectory(directory)
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
      resolveReview: (chatId, reviewID, threadId) => Effect.gen(function* () {
        const permissionMatch = /^permission:(\d+)$/.exec(reviewID)
        if (permissionMatch !== null) {
          const token = Number(permissionMatch[1])
          const retried = Number.isSafeInteger(token) && (yield* permissionRegistry.retryUncertainDelivery(token, chatId))
          yield* sendText(chatId, retried ? "Permission prompt scheduled for retry." : "That permission delivery review was not found.", threadId)
          return
        }
        const questionMatch = /^question:(\d+):(\d+)$/.exec(reviewID)
        if (questionMatch !== null) {
          const token = Number(questionMatch[1])
          const questionIndex = Number(questionMatch[2])
          const retried = Number.isSafeInteger(token) && Number.isSafeInteger(questionIndex) &&
            (yield* questionRegistry.retryUncertainDelivery(token, questionIndex, chatId))
          yield* sendText(chatId, retried ? "Question prompt scheduled for retry." : "That question delivery review was not found.", threadId)
          return
        }
        const directory = yield* sessions.directoryFor(clientId(chatId))
        const sessionID = yield* store.getSessionIDForDirectory(directory)
        if (Option.isNone(sessionID)) {
          yield* sendText(chatId, "No session yet.", threadId)
          return
        }
        const resolved = yield* resolveOwnedDurableReview(jobs, ownerFor(sessionID.value), reviewID)
        yield* sendText(chatId, resolved ? "Review resolved and retained job data removed." : "That review job was not found in the current session.", threadId)
      }).pipe(Effect.provide(context)),
    }
  }),
)
