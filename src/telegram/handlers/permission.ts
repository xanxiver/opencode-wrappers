import { Cause, Effect, Option } from "effect"
import { OpenCode, OpenCodeError, type OpenCodeService } from "../../core/opencode.js"
import { logBoundary } from "../../core/logging.js"
import {
  permissionTargets,
  PermissionRegistry,
  type PendingPermission,
  type PermissionRegistryService,
  type PermissionReplyClaim,
} from "../permissions.js"
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

/** OpenCode may have resolved the request before the callback was processed. */
const permissionAlreadyResolved = (error: OpenCodeError): boolean => {
  const cause = error.cause
  return typeof cause === "object" && cause !== null && (cause as { readonly _tag?: unknown })._tag === "PermissionNotFoundError"
}

/** One claimed Telegram prompt plus its registry token. */
interface PermissionReplyWork {
  readonly token: number
  readonly claim: PermissionReplyClaim
}

/** Reply to every OpenCode request covered by one Telegram prompt. */
const replyWork = (
  opencode: Pick<OpenCodeService, "replyPermission">,
  work: PermissionReplyWork,
  reply: "once" | "always" | "reject",
): Effect.Effect<boolean> =>
  Effect.forEach(permissionTargets(work.claim.entry), (target) =>
    opencode.replyPermission({
      sessionID: target.sessionID,
      requestID: target.requestID,
      reply,
    }).pipe(
      Effect.as(true),
      Effect.catchTag("OpenCodeError", (error) =>
        permissionAlreadyResolved(error)
          ? Effect.succeed(true)
          : logBoundary("telegram/handlers", "permission-callback", "permission reply failed")(Cause.fail(error)).pipe(
              Effect.as(false),
            ),
      ),
    ), { concurrency: "unbounded" }).pipe(
    Effect.map((results) => results.every(Boolean)),
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "permission-callback", "permission reply failed")(cause).pipe(Effect.as(false)),
    ),
  )

/**
 * Answer the tapped prompt. Equivalent prompts in the same destination cover
 * the same OpenCode action and resources, so one decision answers them all.
 */
const replyPermissionClaim = (
  query: CallbackQuery,
  registry: PermissionRegistryService,
  opencode: Pick<OpenCodeService, "replyPermission">,
  parsed: { readonly token: number; readonly reply: "once" | "always" | "reject" },
  claim: PermissionReplyClaim,
) =>
  Effect.gen(function* () {
    const works: PermissionReplyWork[] = [{ token: parsed.token, claim }]
    const entry = claim.entry
    if (entry.action !== undefined && entry.resources !== undefined) {
      const equivalents = yield* registry.listEquivalent({
        chatId: entry.chatId,
        threadId: entry.threadId,
        action: entry.action,
        resources: entry.resources,
      }).pipe(
        Effect.catchCause((cause) =>
          logBoundary("telegram/handlers", "permission-callback", "permission equivalence lookup failed")(cause).pipe(
            Effect.andThen(Effect.succeed<readonly { readonly token: number; readonly entry: PendingPermission }[]>([])),
          ),
        ),
      )
      for (const equivalent of equivalents) {
        if (equivalent.token === parsed.token) continue
        const sibling = yield* registry.claim(equivalent.token, equivalent.entry.chatId, equivalent.entry.messageId).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "permission-callback", "permission sibling claim failed")(cause).pipe(
              Effect.andThen(Effect.succeed(Option.none<PermissionReplyClaim>())),
            ),
          ),
        )
        if (Option.isSome(sibling)) works.push({ token: equivalent.token, claim: sibling.value })
      }
    }
    const outcomes = yield* withClaimLease(
      parsed.token,
      Effect.forEach(
        works,
        (work) => replyWork(opencode, work, parsed.reply).pipe(Effect.map((ok) => ({ work, ok }))),
        { concurrency: "unbounded" },
      ),
      registry.renewClaim(parsed.token, claim.generation),
    ).pipe(
      Effect.onError(() =>
        Effect.forEach(
          works,
          (work) =>
            registry.restoreClaim(work.token, work.claim).pipe(
              Effect.catchCause((cause) =>
                logBoundary("telegram/handlers", "permission-callback", "permission restore failed")(cause),
              ),
            ),
          { discard: true },
        )),
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "permission-callback", "permission reply lease failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly { readonly work: PermissionReplyWork; readonly ok: boolean }[] | undefined>(undefined)),
        ),
      ),
    )
    if (outcomes === undefined) {
      yield* callbackFailure(query, "permission callback failed", "Failed to reply.")(
        Cause.fail(new Error("permission reply lease lost")),
      )
      return
    }
    const decision = renderPermissionDecision(parsed.reply)
    const completed: PermissionReplyWork[] = []
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        yield* registry.restoreClaim(outcome.work.token, outcome.work.claim).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "permission-callback", "permission restore failed")(cause),
          ),
        )
        continue
      }
      const done = yield* registry.completeClaim(outcome.work.token, outcome.work.claim.generation).pipe(
        Effect.catchCause((cause) =>
          logBoundary("telegram/handlers", "permission-callback", "permission complete failed")(cause).pipe(
            Effect.as(false),
          ),
        ),
      )
      if (done) completed.push(outcome.work)
    }
    if (!completed.some((work) => work.token === parsed.token)) {
      yield* callbackFailure(query, "permission callback failed", "Failed to reply.")(
        Cause.fail(new Error("permission reply failed")),
      )
      return
    }
    yield* Effect.all([
      ...completed.map((work) => bestEffortConfirmation(
        apiEdit(work.claim.entry.chatId, work.claim.entry.messageId, decision),
        "permission accepted but message edit failed",
      )),
      bestEffortConfirmation(
        answer(query.id, decision),
        "permission accepted but callback acknowledgement failed",
      ),
    ], { concurrency: "unbounded" })
  })

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
          onSome: (claim) => replyPermissionClaim(query, registry, opencode, parsed, claim),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "permission callback failed", "Failed to reply.")),
      ),
  })
