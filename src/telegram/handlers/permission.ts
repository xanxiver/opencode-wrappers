import { Effect, Option } from "effect"
import { OpenCode } from "../../core/opencode.js"
import { PermissionRegistry } from "../permissions.js"
import { renderPermissionDecision } from "../render.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure } from "./shared.js"
import { parsePermissionCallback } from "../render.js"

export const handlePermissionCallback = (query: CallbackQuery, data: string) =>
  Option.match(parsePermissionCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        const callbackMessage = query.message
        if (callbackMessage === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const registry = yield* PermissionRegistry
        const opencode = yield* OpenCode
        const entry = yield* registry.claim(
          parsed.token,
          callbackMessage.chat.id,
          callbackMessage.message_id,
        )
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) =>
            opencode.replyPermission({
              sessionID: value.sessionID,
              requestID: value.requestID,
              reply: parsed.reply,
            }).pipe(
              Effect.catchCause((cause) =>
                registry.restore(parsed.token, value).pipe(Effect.andThen(Effect.failCause(cause))),
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  const decision = renderPermissionDecision(parsed.reply)
                  yield* apiEdit(value.chatId, value.messageId, decision)
                  yield* answer(query.id, decision)
                }),
              ),
            ),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "permission callback failed", "Failed to reply.")),
      ),
  })
