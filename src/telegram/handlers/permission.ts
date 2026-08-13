import { Cause, Effect, Option } from "effect"
import { OpenCode } from "../../core/opencode.js"
import { logBoundary } from "../../core/logging.js"
import { PermissionRegistry } from "../permissions.js"
import { renderPermissionDecision } from "../render.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure } from "./shared.js"
import { parsePermissionCallback } from "../render.js"
import { withClaimLease } from "./claim-lease.js"

const bestEffortConfirmation = <A, R>(effect: Effect.Effect<A, unknown, R>, message: string): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => logBoundary("telegram/handlers", "telegram-confirmation", message)(cause)),
  )

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
          onSome: (claim) =>
            withClaimLease(parsed.token, opencode.replyPermission({
              sessionID: claim.entry.sessionID,
              requestID: claim.entry.requestID,
              reply: parsed.reply,
            }), registry.renewClaim(parsed.token, claim.generation)).pipe(
              Effect.onError(() => registry.restoreClaim(parsed.token, claim).pipe(
                Effect.catchCause((cause) => Effect.logError("failed to restore permission interaction", Cause.pretty(cause))),
              )),
              Effect.andThen(registry.completeClaim(parsed.token, claim.generation)),
              Effect.flatMap((completed) => completed
                ? Effect.all([
                  bestEffortConfirmation(
                    apiEdit(claim.entry.chatId, claim.entry.messageId, renderPermissionDecision(parsed.reply)),
                    "permission accepted but message edit failed",
                  ),
                  bestEffortConfirmation(
                    answer(query.id, renderPermissionDecision(parsed.reply)),
                    "permission accepted but callback acknowledgement failed",
                  ),
                ])
                : Effect.void),
            ),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "permission callback failed", "Failed to reply.")),
      ),
  })
