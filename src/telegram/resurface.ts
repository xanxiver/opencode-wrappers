import { Cause, Effect, Option, Schedule } from "effect"
import { AppConfigTag } from "../config.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode } from "../core/opencode.js"
import { Store } from "../core/store.js"
import { recordDefinitiveSendFailure, TelegramApi } from "./api.js"
import { PermissionRegistry } from "./permissions.js"
import { QuestionRegistry } from "./questions.js"
import { renderPermission, renderQuestion } from "./render.js"
import { questionKeyboard } from "./run.js"

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
  if (Option.isNone(tokenOption)) return
  const token = tokenOption.value
  const claimed = yield* registry.claimDeliveryWithGeneration(token, route.chatId)
  if (Option.isNone(claimed)) return
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
})

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
  if (Option.isNone(tokenOption)) return
  const token = tokenOption.value
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
  }))
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
  yield* Effect.forEach(permissions.filter((request) => request.sessionID === sessionID), (request) =>
    surfacePermission(request, effectiveRoute))
  yield* Effect.forEach(questions.filter((request) => request.sessionID === sessionID), (request) =>
    surfaceQuestions(request, effectiveQuestionRoute))
})

/**
 * After a bot restart, re-surface pending permission requests and
 * question requests for sessions we know. Without this, an agent blocked
 * on a permission stays blocked until interrupted.
 */
export const resurfacePending = () =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const store = yield* Store
    const config = yield* AppConfigTag
    const permissionRegistry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    yield* permissionRegistry.purgeExpired
    yield* questionRegistry.purgeExpired
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
        const routeOption = yield* permissionRegistry.getSessionRoute(request.sessionID)
        if (Option.isNone(routeOption)) continue
        yield* surfacePermission(request, routeOption.value).pipe(
          Effect.catchCause(logPendingFailure("resurface permission failed")),
        )
      }
      for (const request of questions) {
        const routeOption = yield* questionRegistry.getSessionRoute(request.sessionID)
        if (Option.isNone(routeOption)) continue
        yield* surfaceQuestions(request, routeOption.value).pipe(
          Effect.catchCause(logPendingFailure("resurface question failed")),
        )
      }
    }
  }).pipe(
    Effect.catchCause((cause) => logPendingFailure("pending request poll failed")(cause)),
    Effect.repeat(Schedule.spaced("2 seconds")),
  )
