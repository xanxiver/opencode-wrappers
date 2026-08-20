import { Cause, Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { QuestionRegistry } from "../questions.js"
import {
  parseQuestionCallback,
  renderQuestionWithSelection,
} from "../render.js"
import type { CallbackQuery } from "../api.js"
import { questionKeyboard } from "../run.js"
import { answer, apiEdit, callbackFailure, sendText } from "./shared.js"
import { isComplete } from "../questions.js"
import { withClaimLease } from "./claim-lease.js"

const bestEffortConfirmation = <A, R>(effect: Effect.Effect<A, unknown, R>, message: string): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => logBoundary("telegram/handlers", "telegram-confirmation", message)(cause)),
  )

/**
 * A Telegram callback expires quickly. Acknowledge it before persistence,
 * OpenCode requests, or message edits, then report any later failure in chat.
 */
const runAcknowledgedQuestionAction = <A, E, R>(
  query: CallbackQuery,
  acknowledgement: string,
  action: Effect.Effect<A, E, R>,
) => {
  const message = query.message
  if (message === undefined) return answer(query.id, "Invalid callback.")
  return answer(query.id, acknowledgement).pipe(
    Effect.andThen(action),
    Effect.asVoid,
    Effect.catchCause((cause) =>
      logBoundary("telegram/handlers", "question-callback", "acknowledged question action failed")(cause).pipe(
        Effect.andThen(sendText(
          message.chat.id,
          "The answer could not be recorded. Please try again.",
          message.message_thread_id,
        )),
      ),
    ),
  )
}

/**
 * Record an answer for one question of a pending request.
 * When every question is answered, submit all answers to OpenCode,
 * remove the request and mark the question messages as answered.
 * Returns true when the whole request was submitted.
 */
export const recordQuestionAnswer = (
  token: number,
  questionIndex: number,
  value: readonly string[],
) =>
  Effect.gen(function* () {
    const registry = yield* QuestionRegistry
    const opencode = yield* OpenCode
    const updated = yield* registry.answer(token, questionIndex, value)
    return yield* Option.match(updated, {
      onNone: () => Effect.succeed(false),
      onSome: (current) => {
        if (!isComplete(current)) return Effect.succeed(false)
        return registry.claimComplete(current.token).pipe(Effect.flatMap(Option.match({
          onNone: () => Effect.succeed(false),
          onSome: (claim) => withClaimLease(claim.entry.token, opencode.replyQuestion({
            sessionID: claim.entry.sessionID,
            requestID: claim.entry.requestID,
            answers: claim.entry.answers.map((answer) => answer ?? []),
          }), registry.renewClaim(claim.entry.token, claim.generation)).pipe(
            Effect.onError(() => registry.restoreClaim(claim).pipe(
              Effect.catchCause((cause) => Effect.logError("failed to restore question interaction", Cause.pretty(cause))),
            )),
            Effect.andThen(registry.completeClaim(claim.entry.token, claim.generation)),
            Effect.flatMap((completed) => completed
              ? Effect.forEach(claim.entry.messageIds, (messageId) =>
                  bestEffortConfirmation(apiEdit(claim.entry.chatId, messageId, "Answered"), "question accepted but message edit failed")).pipe(Effect.as(true))
              : Effect.succeed(false)),
          ),
        })))
      },
    })
  })

/** Answer a pending question by replying to its message with text. */
export const answerRepliedQuestion = (
  chatId: number,
  messageId: number,
  text: string,
  threadId?: number,
) =>
  Effect.gen(function* () {
    const registry = yield* QuestionRegistry
    const entry = yield* registry.findByMessage(chatId, messageId)
    return yield* Option.match(entry, {
      onNone: () => Effect.succeed(false),
      onSome: (current) => {
        const questionIndex = questionIndexForEntry(current, messageId)
        const custom = current.customs[questionIndex] ?? false
        const hasOptions = (current.options[questionIndex]?.length ?? 0) > 0
        if (!custom && hasOptions) {
          return sendText(chatId, "That question needs an option answer.", threadId).pipe(Effect.as(true))
        }
        return recordQuestionAnswer(current.token, questionIndex, [text]).pipe(
          Effect.catchCause((cause) =>
            logBoundary("telegram/handlers", "opencode-client", "question reply failed")(cause).pipe(
              Effect.andThen(sendText(chatId, "The answer could not be sent. Please try again.", threadId)),
              Effect.as(true),
            ),
          ),
        )
      },
    })
  })

const questionIndexForEntry = (entry: { readonly messageIds: readonly number[] }, messageId: number): number => {
  const index = entry.messageIds.indexOf(messageId)
  return index === -1 ? 0 : index
}

export const handleQuestionCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseQuestionCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        const registry = yield* QuestionRegistry
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.getForMessage(
          parsed.token,
          parsed.questionIndex,
          message.chat.id,
          message.message_id,
        )
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (current) => {
            const options = Option.fromNullishOr(current.options[parsed.questionIndex])
            return Option.match(options, {
              onNone: () => answer(query.id, "Invalid question."),
              onSome: (questionOptions) => {
                switch (parsed.choice.kind) {
                  case "skip":
                    return runAcknowledgedQuestionAction(
                      query,
                      "Skipped.",
                      recordQuestionAnswer(parsed.token, parsed.questionIndex, []),
                    )
                  case "confirm": {
                    if (!(current.multiples[parsed.questionIndex] ?? false)) {
                      return answer(query.id, "Invalid action.")
                    }
                    const value = current.selections[parsed.questionIndex] ?? []
                    return runAcknowledgedQuestionAction(
                      query,
                      "Answer recorded.",
                      recordQuestionAnswer(parsed.token, parsed.questionIndex, value),
                    )
                  }
                  case "option": {
                    const label = Option.getOrElse(
                      Option.fromNullishOr(questionOptions[parsed.choice.index]),
                      () => "",
                    )
                    if (label === "") return answer(query.id, "Invalid option.")
                    if (current.multiples[parsed.questionIndex] ?? false) {
                      return runAcknowledgedQuestionAction(
                        query,
                        "Selection updated.",
                        Effect.gen(function* () {
                          const updated = yield* registry.toggleSelection(
                            parsed.token,
                            parsed.questionIndex,
                            label,
                          )
                          yield* Option.match(updated, {
                            onNone: () => Effect.void,
                            onSome: (next) => {
                              const messageId = next.messageIds[parsed.questionIndex]
                              const selected = next.selections[parsed.questionIndex] ?? []
                              const question = {
                                header: "",
                                question: next.questions[parsed.questionIndex] ?? "",
                                options: questionOptions.map((item) => ({ label: item, description: "" })),
                                custom: next.customs[parsed.questionIndex] ?? false,
                                multiple: next.multiples[parsed.questionIndex] ?? false,
                              }
                              return bestEffortConfirmation(apiEdit(
                                next.chatId,
                                messageId,
                                renderQuestionWithSelection(question, selected),
                                questionKeyboard(parsed.token, parsed.questionIndex, question),
                              ), "question selection edit failed")
                            },
                          })
                        }),
                      )
                    }
                    return runAcknowledgedQuestionAction(
                      query,
                      "Answer recorded.",
                      recordQuestionAnswer(parsed.token, parsed.questionIndex, [label]),
                    )
                  }
                }
              },
            })
          },
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "question callback failed", "Failed.")),
      ),
  })
