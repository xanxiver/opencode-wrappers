import { Cause, Effect, Option } from "effect"
import { AppConfigTag } from "../config.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode } from "../core/opencode.js"
import { Store } from "../core/store.js"
import { TelegramApi } from "./api.js"
import { chatIdFromClient } from "./handlers/index.js"
import { PermissionRegistry } from "./permissions.js"
import { QuestionRegistry } from "./questions.js"
import { renderPermission, renderQuestion } from "./render.js"
import { questionKeyboard } from "./run.js"

const logPendingFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  logBoundary("telegram/resurface", "opencode-client", message)(cause)

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
    const api = yield* TelegramApi
    const permissionRegistry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    const clients = yield* store.listClients()
    for (const clientIdValue of clients) {
      yield* Option.match(chatIdFromClient(clientIdValue), {
        onNone: () => Effect.void,
        onSome: (chatId) =>
          Effect.gen(function* () {
            const directory = yield* store.getDirectory(clientIdValue)
            const resolved = directory.pipe(Option.getOrElse(() => config.projectDirectory))
                 const sessionIDOption = yield* store.getSessionIDForDirectory(resolved)
                 yield* Option.match(sessionIDOption, {
                   onNone: () => Effect.void,
                   onSome: (sessionID) =>
                     Effect.gen(function* () {
                       const permissions = yield* opencode.listPendingPermissions(resolved).pipe(
                         Effect.catchCause((cause) =>
                           logPendingFailure("list pending permissions failed")(cause).pipe(
                             Effect.andThen(Effect.succeed<readonly { id: string; sessionID: string; action: string; resources: readonly string[] }[]>([])),
                           ),
                         ),
                       )
                       const questions = yield* opencode.listPendingQuestions(resolved).pipe(
                         Effect.catchCause((cause) =>
                           logPendingFailure("list pending questions failed")(cause).pipe(
                             Effect.andThen(Effect.succeed<readonly { id: string; sessionID: string; questions: readonly { header: string; question: string; options: readonly { label: string; description: string }[]; custom?: boolean; multiple?: boolean }[] }[]>([])),
                           ),
                         ),
                       )
                  for (const request of permissions) {
                    if (request.sessionID !== sessionID) continue
                    const token = yield* permissionRegistry.register({
                      sessionID,
                      requestID: request.id,
                      chatId,
                    })
                    const message = yield* api.sendMessage({
                      chatId,
                      text: renderPermission(request.action, request.resources),
                      replyMarkup: {
                        inline_keyboard: [[
                          { text: "Once", callback_data: `perm:${token}:once` },
                          { text: "Always", callback_data: `perm:${token}:always` },
                          { text: "Reject", callback_data: `perm:${token}:reject` },
                        ]],
                      },
                    })
                    yield* permissionRegistry.attachMessageId(token, message.message_id)
                  }
                  for (const request of questions) {
                    if (request.sessionID !== sessionID) continue
                    const token = yield* questionRegistry.register({
                      sessionID,
                      requestID: request.id,
                      chatId,
                      questions: request.questions.map((question) => question.question),
                      options: request.questions.map((question) =>
                        question.options.map((option) => option.label)
                      ),
                      customs: request.questions.map((question) => question.custom ?? false),
                      multiples: request.questions.map((question) => question.multiple ?? false),
                    })
                    for (const [index, question] of request.questions.entries()) {
                      const message = yield* api.sendMessage({
                        chatId,
                        text: renderQuestion(question),
                        replyMarkup: question.options.length === 0
                          ? undefined
                          : questionKeyboard(token, index, question),
                      })
                      yield* questionRegistry.attachMessageId(token, index, message.message_id)
                    }
                  }
                }),
            })
          }),
      })
    }
  })
