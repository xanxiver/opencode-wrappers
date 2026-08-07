import { Effect, Ref, Schedule } from "effect"
import { logBoundary } from "../core/logging.js"
import { TelegramApi } from "./api.js"
import { handleUpdate } from "./handlers/index.js"

const updateRetrySchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.upTo({ times: 5, duration: "30 seconds" }),
)

/** Keep a failed child update observable and retry typed handler failures. */
const handleUpdateSafely = (update: Parameters<typeof handleUpdate>[0]) =>
  handleUpdate(update).pipe(
    Effect.retry({ schedule: updateRetrySchedule, while: () => true }),
    Effect.catchCause((cause) =>
      logBoundary("telegram/bot", "telegram-update", "update handling failed after retries")(cause),
    ),
  )

/**
 * Long-polling loop over the Telegram Bot API.
 * Each update is handled in its own fiber; the poll never stops.
 */
export const run = () =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    const offset = yield* Ref.make(0)
    const pollOnce = Effect.gen(function* () {
      const current = yield* Ref.get(offset)
      const updates = yield* api.getUpdates(current, 30)
      if (updates.length > 0) {
        const next = updates.reduce((max, update) => Math.max(max, update.update_id), current) + 1
        yield* Ref.set(offset, next)
        yield* Effect.forEach(updates, (update) => Effect.forkChild(handleUpdateSafely(update)))
      }
    })
    yield* pollOnce.pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/bot", "telegram-poll", "poll failed")(cause).pipe(
          Effect.andThen(Effect.sleep("2 seconds")),
        ),
      ),
      Effect.repeat(Schedule.spaced("100 millis")),
    )
  })
