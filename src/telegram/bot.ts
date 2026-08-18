import { Cause, Effect, Option, Ref, Schedule } from "effect"
import { logBoundary } from "../core/logging.js"
import { ApiError, TelegramApi, type Update } from "./api.js"
import { AttachmentDownloadError } from "./files.js"
import { handleUpdate } from "./handlers/index.js"

/** Telegram permits only one active getUpdates poller for a bot token. */
export const isPollingConflict = (cause: Cause.Cause<unknown>): boolean =>
  Option.exists(Cause.findErrorOption(cause), (error) => error instanceof ApiError && error.code === 409)

/** Handle one update and advance the offset whether it succeeds or is quarantined. */
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
        Effect.andThen(Ref.set(offset, update.update_id + 1)),
      ),
    ),
    Effect.tap(() => Ref.set(offset, update.update_id + 1)),
  )
}

/**
 * Long-polling loop over the Telegram Bot API.
 * Updates are handled in order; the poll never stops.
 */
export const run = () =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    const offset = yield* Ref.make(0)
    const pollOnce = Effect.gen(function* () {
      const current = yield* Ref.get(offset)
      const updates = yield* api.getUpdates(current, 30)
      for (const update of updates) {
        yield* processUpdate(update, offset, handleUpdate(update), (error) =>
          error instanceof AttachmentDownloadError && error.transient)
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
  })
