import { Cause, Effect, Option } from "effect"
import { AppConfigTag } from "../config.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode, rootSessionID, type OpenCodeService } from "../core/opencode.js"
import { Store } from "../core/store.js"
import { recordDefinitiveSendFailure, TelegramApi } from "./api.js"
import { PermissionRegistry, type SessionRoute } from "./permissions.js"
import { QuestionRegistry } from "./questions.js"
import { renderPermission, renderQuestion } from "./render.js"
import { questionKeyboard } from "./run.js"
import type { InteractionStoreError } from "./interaction-store.js"

interface PendingPermissionRequest {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
}

interface PendingQuestionRequest {
  readonly id: string
  readonly sessionID: string
  readonly questions: readonly {
    readonly header: string
    readonly question: string
    readonly options: readonly { readonly label: string; readonly description: string }[]
    readonly custom?: boolean
    readonly multiple?: boolean
  }[]
}

const logPendingFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  logBoundary("telegram/resurface", "opencode-client", message)(cause)

/** Fastest and slowest resurface scan intervals, in seconds. */
export const RESURFACE_MIN_DELAY_SECONDS = 2
export const RESURFACE_MAX_DELAY_SECONDS = 30

/**
 * Deliver one pending permission request. Returns true only when a Telegram
 * message was newly sent; requests that are already surfaced or owned by
 * another sender report false.
 */
const surfacePermission = (
  request: PendingPermissionRequest,
  route: { readonly chatId: number; readonly threadId?: number },
) => Effect.gen(function* () {
  const api = yield* TelegramApi
  const registry = yield* PermissionRegistry
  const tokenOption = yield* registry.registerOrResume({
    sessionID: request.sessionID,
    requestID: request.id,
    chatId: route.chatId,
  })
  if (Option.isNone(tokenOption)) return false
  const token = tokenOption.value
  const claimed = yield* registry.claimDeliveryWithGeneration(token, route.chatId)
  if (Option.isNone(claimed)) return false
  const message = yield* recordDefinitiveSendFailure(api.sendMessage({
    chatId: route.chatId,
    text: renderPermission(request.action, request.resources),
    messageThreadId: route.threadId,
    replyMarkup: { inline_keyboard: [[
      { text: "Once", callback_data: `perm:${token}:once` },
      { text: "Always", callback_data: `perm:${token}:always` },
      { text: "Reject", callback_data: `perm:${token}:reject` },
    ]] },
  }), registry.rejectDeliveryWithGeneration(token, route.chatId, claimed.value))
  yield* registry.attachMessageId(token, message.message_id, claimed.value)
  return true
})

/**
 * Deliver one pending question request's unanswered messages. Returns true
 * only when at least one Telegram message was newly sent.
 */
const surfaceQuestions = (
  request: PendingQuestionRequest,
  route: { readonly chatId: number; readonly threadId?: number },
) => Effect.gen(function* () {
  const api = yield* TelegramApi
  const registry = yield* QuestionRegistry
  const tokenOption = yield* registry.registerOrResume({
    sessionID: request.sessionID,
    requestID: request.id,
    chatId: route.chatId,
    questions: request.questions.map((question) => question.question),
    options: request.questions.map((question) => question.options.map((option) => option.label)),
    customs: request.questions.map((question) => question.custom ?? false),
    multiples: request.questions.map((question) => question.multiple ?? false),
  })
  if (Option.isNone(tokenOption)) return false
  const token = tokenOption.value
  let delivered = false
  yield* Effect.forEach(request.questions.entries(), ([index, question]) => Effect.gen(function* () {
    const claimed = yield* registry.claimDeliveryWithGeneration(token, index, route.chatId)
    if (Option.isNone(claimed)) return
    const message = yield* recordDefinitiveSendFailure(api.sendMessage({
      chatId: route.chatId,
      text: renderQuestion(question),
      messageThreadId: route.threadId,
      replyMarkup: question.options.length === 0 ? undefined : questionKeyboard(token, index, question),
    }), registry.rejectDeliveryWithGeneration(token, index, route.chatId, claimed.value))
    yield* registry.attachMessageId(token, index, message.message_id, claimed.value)
    delivered = true
  }))
  return delivered
})

/** Reconcile already-pending interactions when a user explicitly reconnects. */
export const reconcilePendingSession = (
  directory: string,
  sessionID: string,
  route: { readonly chatId: number; readonly threadId?: number },
) => Effect.gen(function* () {
  const opencode = yield* OpenCode
  const permissionRegistry = yield* PermissionRegistry
  const questionRegistry = yield* QuestionRegistry
  yield* permissionRegistry.purgeExpired
  yield* questionRegistry.purgeExpired
  const effectiveRoute = yield* permissionRegistry.getOrSetSessionRoute(sessionID, route)
  const effectiveQuestionRoute = yield* questionRegistry.getOrSetSessionRoute(sessionID, effectiveRoute)
  const [permissions, questions] = yield* Effect.all([
    opencode.listPendingPermissions(directory),
    opencode.listPendingQuestions(directory),
  ])
  yield* Effect.forEach(permissions, (request) =>
    belongsToRoot(opencode, request.sessionID, sessionID).pipe(
      Effect.flatMap((keep) => keep ? surfacePermission(request, effectiveRoute).pipe(Effect.asVoid) : Effect.void),
    ))
  yield* Effect.forEach(questions, (request) =>
    belongsToRoot(opencode, request.sessionID, sessionID).pipe(
      Effect.flatMap((keep) => keep ? surfaceQuestions(request, effectiveQuestionRoute).pipe(Effect.asVoid) : Effect.void),
    ))
})

/**
 * A request belongs to the root session when it is that session, or when
 * climbing the session tree (through subagent children) reaches it.
 */
const belongsToRoot = (
  opencode: OpenCodeService,
  requestSessionID: string,
  rootSessionIDValue: string,
): Effect.Effect<boolean, never> =>
  requestSessionID === rootSessionIDValue
    ? Effect.succeed(true)
    : rootSessionID(opencode, requestSessionID).pipe(
        Effect.map((root) => root === rootSessionIDValue),
        Effect.catchCause((cause) =>
          logPendingFailure("session tree lookup failed")(cause).pipe(
            Effect.as(false),
          ),
        ),
      )

/**
 * Resolve the Telegram destination for a pending request by climbing a
 * session tree. Requests from subagent (child) sessions have no route of
 * their own; the root run session provides it.
 */
const destinationFor = (
  getSessionRoute: (sessionID: string) => Effect.Effect<Option.Option<SessionRoute>, InteractionStoreError>,
  opencode: OpenCodeService,
  sessionID: string,
): Effect.Effect<Option.Option<SessionRoute>, InteractionStoreError> =>
  getSessionRoute(sessionID).pipe(
    Effect.flatMap(Option.match({
      onSome: (route) => Effect.succeed(Option.some(route)),
      onNone: () => rootSessionID(opencode, sessionID).pipe(
        Effect.flatMap((root) => getSessionRoute(root)),
        Effect.catchCause(() => Effect.succeed(Option.none<SessionRoute>())),
      ),
    })),
  )

/**
 * After a bot restart, re-surface pending permission requests and
 * question requests for sessions we know. Without this, an agent blocked
 * on a permission stays blocked until interrupted.
 *
 * The scan pace follows its yield: an empty pass doubles the interval up to
 * the maximum, and any newly delivered message restores the fastest pace.
 * Requests that are merely still pending do not count, so one long-blocked
 * permission cannot pin the poller at full speed forever.
 */
export const resurfacePending = () =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const store = yield* Store
    const config = yield* AppConfigTag
    const permissionRegistry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    let delaySeconds = RESURFACE_MIN_DELAY_SECONDS
    while (true) {
      yield* permissionRegistry.purgeExpired.pipe(
        Effect.catchCause((cause) => logPendingFailure("permission purge failed")(cause)),
      )
      yield* questionRegistry.purgeExpired.pipe(
        Effect.catchCause((cause) => logPendingFailure("question purge failed")(cause)),
      )
      const surfaced = yield* Effect.gen(function* () {
        let count = 0
        const knownDirectories = yield* store.listDirectories()
        const directories = new Set([config.projectDirectory, ...knownDirectories])
        for (const directory of directories) {
          const permissions = yield* opencode.listPendingPermissions(directory).pipe(
            Effect.catchCause((cause) =>
              logPendingFailure("list pending permissions failed")(cause).pipe(
                Effect.andThen(Effect.succeed<readonly { id: string; sessionID: string; action: string; resources: readonly string[] }[]>([])),
              ),
            ),
          )
          const questions = yield* opencode.listPendingQuestions(directory).pipe(
            Effect.catchCause((cause) =>
              logPendingFailure("list pending questions failed")(cause).pipe(
                Effect.andThen(Effect.succeed<readonly { id: string; sessionID: string; questions: readonly { header: string; question: string; options: readonly { label: string; description: string }[]; custom?: boolean; multiple?: boolean }[] }[]>([])),
              ),
            ),
          )
          for (const request of permissions) {
            const routeOption = yield* destinationFor(permissionRegistry.getSessionRoute, opencode, request.sessionID).pipe(
              Effect.catchCause((cause) =>
                logPendingFailure("permission destination lookup failed")(cause).pipe(Effect.as(Option.none<SessionRoute>())),
              ),
            )
            if (Option.isNone(routeOption)) continue
            const delivered = yield* surfacePermission(request, routeOption.value).pipe(
              Effect.catchCause(logPendingFailure("resurface permission failed")),
            )
            if (delivered) count += 1
          }
          for (const request of questions) {
            const routeOption = yield* destinationFor(questionRegistry.getSessionRoute, opencode, request.sessionID).pipe(
              Effect.catchCause((cause) =>
                logPendingFailure("question destination lookup failed")(cause).pipe(Effect.as(Option.none<SessionRoute>())),
              ),
            )
            if (Option.isNone(routeOption)) continue
            const delivered = yield* surfaceQuestions(request, routeOption.value).pipe(
              Effect.catchCause(logPendingFailure("resurface question failed")),
            )
            if (delivered) count += 1
          }
        }
        return count
      }).pipe(
        Effect.catchCause((cause) => logPendingFailure("pending request scan failed")(cause).pipe(Effect.as(0))),
      )
      yield* Effect.sleep(`${delaySeconds} seconds`)
      delaySeconds = surfaced > 0
        ? RESURFACE_MIN_DELAY_SECONDS
        : Math.min(RESURFACE_MAX_DELAY_SECONDS, delaySeconds * 2)
    }
  })
