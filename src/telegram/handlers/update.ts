import { Effect, Option } from "effect"
import { Access } from "../access.js"
import { normalizeCommand } from "../render.js"
import type { Update } from "../api.js"
import { sendText } from "./shared.js"
import { handleCallback } from "./callbacks.js"
import { handleMessage } from "./message.js"

export const handleUpdate = (update: Update) =>
  Effect.gen(function* () {
    // /whoami is open to everyone: a new user needs their user id to
    // configure TELEGRAM_ALLOWED_USERS (the whitelist gates everything else).
    const message = update.message
    if (message?.text !== undefined && normalizeCommand(message.text) === "/whoami" && message.from !== undefined) {
      yield* sendText(message.chat.id, `Your user id is ${message.from.id}.`, message.message_thread_id)
      return
    }
    const access = yield* Access
    const userId = message?.from?.id ?? update.callback_query?.from?.id
    if (userId === undefined || !access.isAllowed(userId)) {
      yield* Effect.annotateLogs({ component: "telegram/handlers", boundary: "access" })(
        Effect.logWarning("denied update from unauthorized user", userId),
      )
      return
    }
    yield* Option.match(Option.fromNullishOr(message), {
      onNone: () => Effect.void,
      onSome: (value) => handleMessage(value),
    })
    yield* Option.match(Option.fromNullishOr(update.callback_query), {
      onNone: () => Effect.void,
      onSome: (callback) => handleCallback(callback),
    })
  })
