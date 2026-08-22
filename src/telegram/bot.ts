import { Cause, Effect, FiberMap, Option, Ref, Schedule } from "effect"
import { logBoundary } from "../core/logging.js"
import { ApiError, TelegramApi, type TelegramApiClient, type Update } from "./api.js"
import { AttachmentDownloadError } from "./files.js"
import { handleUpdate } from "./handlers/index.js"

/** Telegram permits only one active getUpdates poller for a bot token. */
export const isPollingConflict = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (error) => error instanceof ApiError && error.code === 409)

/** Updates handled concurrently at once; further updates wait in the batch. */
export const MAX_CONCURRENT_UPDATES = 8

/**
 * Handle one update and advance the polling cursor whether it succeeds or is
 * quarantined. The cursor only moves forward: with concurrent handling, a
 * slow older update must never pull the confirmed offset below one that a
 * faster newer update already confirmed.
 */
export const processUpdate = <E, R>(
  update: Update,
  offset: Ref.Ref<number>,
  handler: Effect.Effect<void, E, R>,
  retryable: (error: E) => boolean = () => false,
) => {
  const retried = handler.pipe(Effect.retry({ times: 2, while: retryable }))
  return retried.pipe(
    Effect.catchCause((cause) =>
      logBoundary("telegram/bot", "telegram-update", "update handling failed; update quarantined")(cause).pipe(
        // A poison update must not block all later Telegram updates forever.
        // The complete Cause is logged above; quarantine is represented by
        // advancing the polling cursor after the bounded retry policy.
        Effect.andThen(Ref.update(offset, (current) => Math.max(current, update.update_id + 1))),
      ),
    ),
    Effect.tap(() => Ref.update(offset, (current) => Math.max(current, update.update_id + 1))),
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
 * True when an update is already confirmed by a concurrent handler that
 * finished after this batch was fetched. Re-running it would duplicate the
 * reply, so the poller skips it.
 */
export const isStaleUpdate = (confirmedOffset: number, updateID: number): boolean =>
  confirmedOffset > updateID

/**
 * Long-polling loop over the Telegram Bot API.
 * Updates are handled concurrently up to MAX_CONCURRENT_UPDATES; each update
 * confirms its own polling cursor when it finishes. The poll never stops.
 */
export const run = () =>
  Effect.scoped(
    Effect.gen(function* () {
    const api = yield* TelegramApi
    const start = yield* dropUpdateBacklog(api)
    const offset = yield* Ref.make(start)
    const fibers = yield* FiberMap.make<number, void, unknown>()
    const pollOnce = Effect.gen(function* () {
      const current = yield* Ref.get(offset)
      const updates = yield* api.getUpdates(current, 30)
      for (const update of updates) {
        // A concurrent handler may have finished while this batch was in
        // flight, confirming past this update; re-running it here would
        // duplicate the reply even though Telegram will not send it again.
        if (isStaleUpdate(yield* Ref.get(offset), update.update_id)) continue
        if ((yield* FiberMap.size(fibers)) >= MAX_CONCURRENT_UPDATES) {
          // Apply backpressure: handle this update inline before fanning out
          // again, so an unbounded burst cannot pile up fibers.
          yield* processUpdate(update, offset, handleUpdate(update), (error) =>
            error instanceof AttachmentDownloadError && error.transient)
          continue
        }
        yield* FiberMap.run(
          fibers,
          update.update_id,
          processUpdate(update, offset, handleUpdate(update), (error) =>
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
