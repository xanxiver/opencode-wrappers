import { Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { QuestionRegistry } from "../questions.js"
import {
  parseQuestionCallback,
  renderQuestionWithSelection,
} from "../render.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure, sendText } from "./shared.js"
import { isComplete } from "../questions.js"

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
        return opencode.replyQuestion({
          sessionID: current.sessionID,
          requestID: current.requestID,
          answers: current.answers.map((answer) => answer ?? []),
        }).pipe(
          Effect.andThen(registry.remove(current.token)),
          Effect.andThen(
            Effect.forEach(current.messageIds, (messageId) => apiEdit(current.chatId, messageId, "Answered")),
          ),
          Effect.as(true),
        )
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
                    return recordQuestionAnswer(parsed.token, parsed.questionIndex, []).pipe(
                      Effect.andThen(answer(query.id, "Skipped.")),
                    )
                  case "confirm": {
                    if (!(current.multiples[parsed.questionIndex] ?? false)) {
                      return answer(query.id, "Invalid action.")
                    }
                    const value = current.selections[parsed.questionIndex] ?? []
                    return recordQuestionAnswer(parsed.token, parsed.questionIndex, value).pipe(
                      Effect.andThen(answer(query.id, "Answer recorded.")),
                    )
                  }
                  case "option": {
                    const label = Option.getOrElse(
                      Option.fromNullishOr(questionOptions[parsed.choice.index]),
                      () => "",
                    )
                    if (label === "") return answer(query.id, "Invalid option.")
                    if (current.multiples[parsed.questionIndex] ?? false) {
                      return Effect.gen(function* () {
                        const updated = yield* registry.toggleSelection(
                          parsed.token,
                          parsed.questionIndex,
                          label,
                        )
                        yield* Option.match(updated, {
                          onNone: () => answer(query.id, "Expired."),
                          onSome: (next) => {
                            const messageId = next.messageIds[parsed.questionIndex]
                            const selected = next.selections[parsed.questionIndex] ?? []
                            return apiEdit(
                              next.chatId,
                              messageId,
                              renderQuestionWithSelection(
                                {
                                  header: "",
                                  question: next.questions[parsed.questionIndex] ?? "",
                                  options: questionOptions.map((item) => ({ label: item, description: "" })),
                                  custom: next.customs[parsed.questionIndex] ?? false,
                                },
                                selected,
                              ),
                            )
                          },
                        })
                        yield* answer(query.id, "Selection updated.")
                      }).pipe(Effect.catchCause(callbackFailure(query, "question callback failed", "Failed.")))
                    }
                    return recordQuestionAnswer(parsed.token, parsed.questionIndex, [label]).pipe(
                      Effect.andThen(answer(query.id, "Answer recorded.")),
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
