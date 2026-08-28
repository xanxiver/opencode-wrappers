import { Cause, Effect, Fiber, FiberMap, Option, Ref, Schedule } from "effect"
import { logBoundary } from "../core/logging.js"
import { ApiError, TelegramApi, type TelegramApiClient, type Update } from "./api.js"
import { AttachmentDownloadError } from "./files.js"
import { handleUpdate } from "./handlers/index.js"

/** Telegram permits only one active getUpdates poller for a bot token. */
export const isPollingConflict = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (error) => error instanceof ApiError && error.code === 409)

/** Updates handled concurrently at once; further updates wait in the batch. */
export const MAX_CONCURRENT_UPDATES = 8

interface UpdateAcknowledgementState {
  readonly offset: number
  readonly pending: ReadonlySet<number>
  readonly completed: ReadonlySet<number>
}

export interface UpdateAcknowledgements {
  readonly current: Effect.Effect<number>
  readonly register: (updates: readonly Update[]) => Effect.Effect<void>
  readonly complete: (updateID: number) => Effect.Effect<void>
  readonly isCompleted: (updateID: number) => Effect.Effect<boolean>
}

const advanceAcknowledgement = (state: UpdateAcknowledgementState): UpdateAcknowledgementState => {
  const pending = [...state.pending]
  const completed = [...state.completed]
  let offset = state.offset
  if (pending.length > 0) offset = Math.max(offset, Math.min(...pending))
  else if (completed.length > 0) offset = Math.max(offset, Math.max(...completed) + 1)
  return {
    offset,
    pending: new Set(pending.filter((updateID) => updateID >= offset)),
    completed: new Set(completed.filter((updateID) => updateID >= offset)),
  }
}

/** Track an acknowledged prefix while newer updates can finish out of order. */
export const makeUpdateAcknowledgements = (initialOffset: number): Effect.Effect<UpdateAcknowledgements> =>
  Ref.make<UpdateAcknowledgementState>({
    offset: initialOffset,
    pending: new Set(),
    completed: new Set(),
  }).pipe(Effect.map((state) => ({
    current: Ref.get(state).pipe(Effect.map((current) => current.offset)),
    register: (updates) => Ref.update(state, (current) => {
      const pending = new Set(current.pending)
      for (const update of updates) {
        if (
          update.update_id >= current.offset &&
          !pending.has(update.update_id) &&
          !current.completed.has(update.update_id)
        ) pending.add(update.update_id)
      }
      return advanceAcknowledgement({ ...current, pending })
    }),
    complete: (updateID) => Ref.update(state, (current) => {
      if (updateID < current.offset) return current
      const pending = new Set(current.pending)
      pending.delete(updateID)
      return advanceAcknowledgement({
        ...current,
        pending,
        completed: new Set(current.completed).add(updateID),
      })
    }),
    isCompleted: (updateID) => Ref.get(state).pipe(
      Effect.map((current) => updateID < current.offset || current.completed.has(updateID)),
    ),
  })))

/** Wait until the controller can start another update without exceeding its cap. */
export const awaitUpdateCapacity = (
  fibers: FiberMap.FiberMap<number, void, unknown>,
): Effect.Effect<void> => Effect.gen(function* () {
  while ((yield* FiberMap.size(fibers)) >= MAX_CONCURRENT_UPDATES) {
    const completions = [...fibers].map(([, fiber]) => Fiber.await(fiber))
    if (completions.length === 0) {
      yield* Effect.yieldNow
      continue
    }
    yield* Effect.raceAll(completions)
    // Let FiberMap's completion observer remove the winning fiber.
    yield* Effect.yieldNow
  }
})

/**
 * Handle one update and mark it complete whether it succeeds or is
 * quarantined. The acknowledgement tracker advances only after every earlier
 * registered update is complete.
 */
export const processUpdate = <E, R>(
  update: Update,
  handler: Effect.Effect<void, E, R>,
  acknowledge: Effect.Effect<void>,
  retryable: (error: E) => boolean = () => false,
) => {
  const retried = handler.pipe(Effect.retry({ times: 2, while: retryable }))
  return retried.pipe(
    // A poison update must not block all later Telegram updates forever. The
    // complete Cause is logged before the update is marked complete.
    Effect.catchCause((cause) =>
      logBoundary("telegram/bot", "telegram-update", "update handling failed; update quarantined")(cause)),
    Effect.andThen(acknowledge),
  )
}

/**
 * Confirm and drop everything Telegram has queued for this bot. Long-polling
 * starts from the newest update so prompts typed during downtime are not
 * executed hours later; jobs already submitted stay idempotent by their
 * durable source key.
 */
export const dropUpdateBacklog = (api: Pick<TelegramApiClient, "getUpdates">) =>
  api.getUpdates(-1, 0).pipe(
    Effect.map((latest) => latest.at(-1)?.update_id ?? -1),
    Effect.map((newest) => newest + 1),
    Effect.catchCause((cause) =>
      logBoundary("telegram/bot", "telegram-poll", "could not read the update backlog; starting from the oldest update")(cause).pipe(
        Effect.as(0),
      ),
    ),
  )

/**
 * True when an update is below the controller's acknowledged prefix.
 */
export const isStaleUpdate = (confirmedOffset: number, updateID: number): boolean =>
  confirmedOffset > updateID

/**
 * Long-polling loop over the Telegram Bot API.
 * Updates are handled concurrently up to MAX_CONCURRENT_UPDATES. Completion
 * advances one contiguous acknowledgement frontier. The poll never stops.
 */
export const run = () =>
  Effect.scoped(
    Effect.gen(function* () {
    const api = yield* TelegramApi
    const start = yield* dropUpdateBacklog(api)
    const acknowledgements = yield* makeUpdateAcknowledgements(start)
    const fibers = yield* FiberMap.make<number, void, unknown>()
    const pollOnce = Effect.gen(function* () {
      const current = yield* acknowledgements.current
      const updates = yield* api.getUpdates(current, 30)
      yield* acknowledgements.register(updates)
      for (const update of updates) {
        // A concurrent handler may have finished while this batch was in
        // flight, confirming past this update; re-running it here would
        // duplicate the reply even though Telegram will not send it again.
        if (yield* acknowledgements.isCompleted(update.update_id)) continue
        if (yield* FiberMap.has(fibers, update.update_id)) continue
        yield* awaitUpdateCapacity(fibers)
        // A duplicate handler can finish while this update waits for capacity.
        if (yield* acknowledgements.isCompleted(update.update_id)) continue
        if (yield* FiberMap.has(fibers, update.update_id)) continue
        yield* FiberMap.run(
          fibers,
          update.update_id,
          processUpdate(update, handleUpdate(update), acknowledgements.complete(update.update_id), (error) =>
            error instanceof AttachmentDownloadError && error.transient),
          // Telegram re-delivers every unconfirmed update on each poll. Skip
          // an update whose handler is still running instead of interrupting
          // and restarting it; the handler confirms its own offset when done.
          { onlyIfMissing: true },
        )
      }
    })
    yield* pollOnce.pipe(
      Effect.catchCause((cause) =>
        isPollingConflict(cause)
          ? logBoundary(
              "telegram/bot",
              "telegram-poll",
              "another Telegram poller is active; stopping this duplicate bot",
            )(cause).pipe(Effect.andThen(Effect.failCause(cause)))
          : logBoundary("telegram/bot", "telegram-poll", "poll failed")(cause).pipe(
              Effect.andThen(Effect.sleep("2 seconds")),
            ),
      ),
      Effect.repeat(Schedule.spaced("100 millis")),
    )
    }),
  )
