import { Cause, Deferred, Duration, Effect, Fiber, Option, Ref, Schedule, Stream } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import type { Attachment } from "../core/attachments.js"
import { toFileAttachment } from "../core/attachments.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode } from "../core/opencode.js"
import { TelegramApi, type KeyboardMarkup } from "./api.js"
import { AppConfigTag, parseRunTimeout } from "../config.js"
import { PermissionRegistry, type PermissionRegistryShape } from "./permissions.js"
import { QuestionRegistry, type QuestionRegistryShape } from "./questions.js"
import {
  renderFinal,
  renderPermission,
  renderPermissionDecision,
  renderProgress,
  renderQuestion,
  renderUsage,
  truncate,
  type RunOutcome,
  type UsageView,
} from "./render.js"

export interface RunInput {
  readonly chatId: number
  readonly sessionID: string
  readonly text?: string
  readonly files: readonly Attachment[]
  /** Forum topic thread id; all messages of this run go into that thread. */
  readonly threadId?: number
  /** The model to (re-)apply before prompting, from the per-directory memory. */
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  /** Attach to an already running session instead of starting a new prompt. */
  readonly resume?: boolean
}

/** A done answer shorter than this is sent as its own message. */
export const SHORT_ANSWER_LIMIT = 600

/** Default max run time; set TELEGRAM_RUN_TIMEOUT=none to disable it. */
export const RUN_TIMEOUT = Duration.minutes(10)

/** Reconnect schedule for the event stream (max 5 retries, 30s cap). */
const reconnectSchedule = Schedule.exponential("500 millis", 2).pipe(
  Schedule.upTo({ times: 5, duration: "30 seconds" }),
)

interface RunState {
  readonly messageId: number
  readonly text: string
  readonly reasoning: string
  readonly activity: Option.Option<string>
  readonly usage: Option.Option<UsageView>
  readonly lastSent: string
  readonly dirty: boolean
}

/**
 * The next progress edit for the flusher: the text to send, or none when
 * nothing changed since the last edit. Skipping identical edits avoids
 * Telegram's "message is not modified" error.
 */
export const nextProgressEdit = (current: {
  readonly text: string
  readonly reasoning: string
  readonly activity: Option.Option<string>
  readonly lastSent: string
  readonly dirty: boolean
}): Option.Option<string> => {
  if (!current.dirty) return Option.none()
  const text = truncate(renderProgress(current))
  return text === current.lastSent ? Option.none() : Option.some(text)
}

type SessionEvent = OpenCodeEvent & { readonly data: { readonly sessionID: string } }

const isSessionEvent = (sessionID: string) => (event: OpenCodeEvent): event is SessionEvent =>
  "sessionID" in event.data && event.data.sessionID === sessionID

const isTerminalEvent = (event: SessionEvent): boolean =>
  event.type === "session.deleted" ||
  event.type === "session.execution.succeeded" ||
  event.type === "session.execution.failed" ||
  event.type === "session.execution.interrupted"

const logTelegramFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.annotateLogs({ component: "telegram/run", boundary: "telegram-bot-api" })(
    Effect.logWarning(message, Cause.pretty(cause)),
  )

const logOpenCodeFailure = (message: string) => (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  logBoundary("telegram/run", "opencode-client", message)(cause)

const showActivity = (state: Ref.Ref<RunState>, label: string) =>
  Ref.update(state, (current) => ({ ...current, activity: Option.some(label), dirty: true }))

const chunk = <A>(items: readonly A[], size: number): ReadonlyArray<readonly A[]> => {
  const rows: A[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size))
  }
  return rows
}

export const questionKeyboard = (
  token: number,
  questionIndex: number,
  question: { readonly options: readonly { readonly label: string; readonly description: string }[]; readonly multiple?: boolean },
): KeyboardMarkup => {
  const buttons = question.options.map((option, optionIndex) => ({
    text: option.label,
    callback_data: `q:${token}:${questionIndex}:${optionIndex}`,
  }))
  buttons.push({ text: "Skip", callback_data: `q:${token}:${questionIndex}:skip` })
  if (question.multiple === true) {
    buttons.push({ text: "Confirm", callback_data: `q:${token}:${questionIndex}:confirm` })
  }
  return { inline_keyboard: chunk(buttons, 2) }
}

const handleEvent = (
  event: SessionEvent,
  chatId: number,
  threadId: Option.Option<number>,
  state: Ref.Ref<RunState>,
  terminal: Ref.Ref<Option.Option<RunOutcome>>,
  terminalHandled: Deferred.Deferred<void>,
  registry: PermissionRegistryShape,
  questionRegistry: QuestionRegistryShape,
): Effect.Effect<void, never, TelegramApi | HttpClient.HttpClient | OpenCode> => {
  switch (event.type) {
    case "session.text.delta": {
      return Ref.update(state, (current) => ({
        ...current,
        text: current.text + event.data.delta,
        dirty: true,
      }))
    }
    case "session.reasoning.delta": {
      return Ref.update(state, (current) => ({
        ...current,
        reasoning: current.reasoning + event.data.delta,
        dirty: true,
      }))
    }
    case "session.tool.called": {
      return Ref.update(state, (current) => ({
        ...current,
        activity: Option.some(`Tool: ${event.data.id}`),
        dirty: true,
      }))
    }
    case "session.created":
      return showActivity(state, "Session created")
    case "session.agent.selected":
      return showActivity(state, "Agent selected")
    case "session.model.selected":
      return showActivity(state, "Model selected")
    case "session.moved":
      return showActivity(state, "Session moved")
    case "session.renamed":
      return showActivity(state, "Session renamed")
    case "session.forked":
      return showActivity(state, "Session forked")
    case "session.input.promoted":
      return showActivity(state, "Input promoted")
    case "session.input.admitted":
      return showActivity(state, "Input admitted")
    case "session.execution.started":
      return showActivity(state, "Execution started")
    case "session.instructions.updated":
      return showActivity(state, "Instructions updated")
    case "session.synthetic":
      return showActivity(state, "Synthetic message added")
    case "session.skill.activated":
      return showActivity(state, "Skill activated")
    case "session.shell.started":
      return showActivity(state, "Background shell started")
    case "session.shell.ended":
      return showActivity(state, "Background shell finished")
    case "session.step.started":
      return showActivity(state, "Step started")
    case "session.step.ended":
      return showActivity(state, "Step finished")
    case "session.step.failed":
      return showActivity(state, "Step failed")
    case "session.text.started":
      return showActivity(state, "Writing response")
    case "session.text.ended":
      return showActivity(state, "Response written")
    case "session.reasoning.started":
      return showActivity(state, "Thinking")
    case "session.reasoning.ended":
      return showActivity(state, "Thinking finished")
    case "session.tool.input.started":
      return showActivity(state, "Preparing tool input")
    case "session.tool.input.delta":
      return showActivity(state, "Preparing tool input")
    case "session.tool.input.ended":
      return showActivity(state, "Tool input ready")
    case "session.tool.progress":
      return showActivity(state, "Tool in progress")
    case "session.retry.scheduled":
      return showActivity(state, "Retry scheduled")
    case "session.compaction.admitted":
      return showActivity(state, "Compaction admitted")
    case "session.compaction.started":
      return showActivity(state, "Compacting session")
    case "session.compaction.delta":
      return showActivity(state, "Compacting session")
    case "session.compaction.ended":
      return showActivity(state, "Compaction finished")
    case "session.compaction.failed":
      return showActivity(state, "Compaction failed")
    case "session.revert.staged":
      return showActivity(state, "Revert staged")
    case "session.revert.cleared":
      return showActivity(state, "Revert cleared")
    case "session.revert.committed":
      return showActivity(state, "Revert committed")
    case "session.tool.success":
    case "session.tool.failed": {
      return Ref.update(state, (current) => ({ ...current, activity: Option.none(), dirty: true }))
    }
    case "session.usage.updated": {
      return Ref.update(state, (current) => ({
        ...current,
        usage: Option.some({
          cost: event.data.cost,
          tokens: {
            input: event.data.tokens.input,
            output: event.data.tokens.output,
            reasoning: event.data.tokens.reasoning,
          },
        }),
      }))
    }
    case "permission.asked": {
      return Effect.gen(function* () {
        const token = yield* registry.register({
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          chatId,
        })
        const api = yield* TelegramApi
        const message = yield* api.sendMessage({
          chatId,
          text: renderPermission(event.data.action, event.data.resources),
          messageThreadId: Option.getOrUndefined(threadId),
          replyMarkup: {
            inline_keyboard: [[
              { text: "Once", callback_data: `perm:${token}:once` },
              { text: "Always", callback_data: `perm:${token}:always` },
              { text: "Reject", callback_data: `perm:${token}:reject` },
            ]],
          },
        })
        yield* registry.attachMessageId(token, message.message_id)
      }).pipe(Effect.catchCause(logTelegramFailure("permission prompt failed")))
    }
    case "question.asked": {
      return Effect.gen(function* () {
        const api = yield* TelegramApi
        const token = yield* questionRegistry.register({
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          chatId,
          questions: event.data.questions.map((question) => question.question),
          options: event.data.questions.map((question) =>
            question.options.map((option) => option.label)
          ),
          customs: event.data.questions.map((question) => question.custom ?? false),
          multiples: event.data.questions.map((question) => question.multiple ?? false),
        })
        for (const [index, question] of event.data.questions.entries()) {
          const message = yield* api.sendMessage({
            chatId,
            text: renderQuestion(question),
            messageThreadId: Option.getOrUndefined(threadId),
            replyMarkup: question.options.length === 0
              ? undefined
              : questionKeyboard(token, index, question),
          })
          yield* questionRegistry.attachMessageId(token, index, message.message_id)
        }
      }).pipe(Effect.catchCause(logTelegramFailure("question prompt failed")))
    }
    case "session.execution.succeeded": {
      return Effect.all([
        Ref.set(terminal, Option.some("done")),
        Deferred.succeed(terminalHandled, undefined),
      ], { discard: true })
    }
    case "session.deleted": {
      return Effect.gen(function* () {
        yield* Ref.set(terminal, Option.some("error"))
        yield* Deferred.succeed(terminalHandled, undefined)
        yield* showActivity(state, "Session deleted")
      })
    }
    case "session.execution.failed": {
      return Effect.all([
        Ref.set(terminal, Option.some("failed")),
        Deferred.succeed(terminalHandled, undefined),
      ], { discard: true })
    }
    case "session.execution.interrupted": {
      return Effect.all([
        Ref.set(terminal, Option.some("interrupted")),
        Deferred.succeed(terminalHandled, undefined),
      ], { discard: true })
    }
    default: {
      return Effect.void
    }
  }
}

/**
 * Run one prompt in a session and live-edit a Telegram message with
 * progress. Ends with a final status message.
 */
export const runPrompt = (input: RunInput) =>
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const api = yield* TelegramApi
    const opencode = yield* OpenCode
    const registry = yield* PermissionRegistry
    const questionRegistry = yield* QuestionRegistry
    const attachments = yield* Effect.forEach(input.files, (attachment) =>
      Effect.succeed(toFileAttachment(attachment))
    )
    const status = yield* api.sendMessage({
      chatId: input.chatId,
      text: "Working…",
      messageThreadId: input.threadId,
    })
    const state = yield* Ref.make<RunState>({
      messageId: status.message_id,
      text: "",
      reasoning: "",
      activity: Option.none(),
      usage: Option.none(),
      lastSent: "Working…",
      dirty: false,
    })

    const flusher = yield* Effect.forkChild(
      Effect.repeat(
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const nextText = nextProgressEdit(current)
          if (Option.isSome(nextText)) {
            yield* api.editMessageText({
              chatId: input.chatId,
              messageId: current.messageId,
              text: nextText.value,
            }).pipe(
              Effect.catchCause(logTelegramFailure("progress edit failed")),
              Effect.andThen(Ref.update(state, (next) => ({ ...next, dirty: false, lastSent: nextText.value }))),
            )
          } else {
            yield* Ref.update(state, (next) => ({ ...next, dirty: false }))
          }
        }),
        Schedule.fixed("1 second"),
      ),
    )

    const run = Effect.gen(function* () {
      const terminal = yield* Ref.make<Option.Option<RunOutcome>>(Option.none())
      const terminalHandled = yield* Deferred.make<void>()
      const eventReady = yield* Deferred.make<void>()
      const waitUntilIdle = (failureMessage: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          while (true) {
            const result = yield* opencode.wait(input.sessionID).pipe(
              Effect.as(Option.some(true)),
              Effect.catchCause((waitCause) =>
                opencode.activeSessions().pipe(
                  Effect.flatMap((active) => {
                    if (!active.includes(input.sessionID)) return Effect.succeed(Option.some(true))
                    return Effect.annotateLogs({
                      component: "telegram/run",
                      boundary: "opencode-client",
                    })(
                      Effect.logWarning(`${failureMessage}; session is still active, retrying`, Cause.pretty(waitCause)),
                    ).pipe(Effect.as(Option.some(false)))
                  }),
                  Effect.catchCause((statusCause) =>
                    logOpenCodeFailure(failureMessage)(waitCause).pipe(
                      Effect.andThen(
                        logOpenCodeFailure("active session check after wait failed")(statusCause),
                      ),
                      Effect.andThen(Effect.succeed(Option.none<boolean>())),
                    ),
                  ),
                ),
              ),
            )
            if (Option.isNone(result)) return false
            if (result.value) return true
            // Bun aborts a quiet fetch after five minutes. The OpenCode run is
            // still active, so reconnect to the long-poll endpoint.
            yield* Effect.sleep("1 second")
          }
        })
      if (input.resume !== true) {
        const idle = yield* waitUntilIdle("wait before prompt failed")
        if (!idle) return "error" as const
        // Re-apply the last chosen model for this directory, so a fresh
        // session (/new or compaction) does not fall back to default.
        if (input.model !== undefined) {
          yield* opencode.switchModel({
            sessionID: input.sessionID,
            model: input.model,
          }).pipe(Effect.catchCause(logOpenCodeFailure("re-apply model failed")))
        }
      }
      const eventStream = opencode.events().pipe(
        Stream.tap((event) =>
          event.type === "server.connected"
            ? Effect.asVoid(Deferred.succeed(eventReady, undefined))
            : Effect.void,
        ),
        Stream.filter(isSessionEvent(input.sessionID)),
        Stream.takeUntil(isTerminalEvent),
        Stream.runForEach((event) =>
          handleEvent(
            event,
            input.chatId,
            Option.fromNullishOr(input.threadId),
            state,
            terminal,
            terminalHandled,
            registry,
            questionRegistry,
          )
        ),
        Effect.retry(reconnectSchedule),
      )
      // Start consuming events before prompting. The prompt can complete very
      // quickly, so subscribing afterwards can miss the terminal event.
      const eventFiber = yield* Effect.forkChild(
        eventStream.pipe(Effect.catchCause(logOpenCodeFailure("event stream failed"))),
      )
      const connected = yield* Effect.timeoutOption(Deferred.await(eventReady), "5 seconds")
      if (Option.isNone(connected)) {
        yield* Fiber.interrupt(eventFiber)
        return "error" as const
      }
      if (input.resume !== true) {
        yield* opencode.prompt({ sessionID: input.sessionID, text: input.text ?? "", files: attachments })
      }
      // The wait call is the completion fallback when the event stream misses
      // an event during connection setup. It also keeps this run blocked while
      // OpenCode waits for a question or permission response.
      const waitCompleted = yield* waitUntilIdle("wait after prompt failed")
      const terminalState = yield* Ref.get(terminal)
      if (Option.isNone(terminalState)) {
        yield* Effect.timeoutOption(Deferred.await(terminalHandled), "1 second")
      }
      yield* Fiber.interrupt(eventFiber)
      // `session.wait` completed successfully, so a missed terminal event is
      // still a completed run rather than an error.
      return (yield* Ref.get(terminal)).pipe(
        Option.getOrElse((): RunOutcome => (waitCompleted ? "done" : "error")),
      )
    })
    const configuredTimeout = config.telegramRunTimeout.trim().toLowerCase()
    const timedRun = configuredTimeout === "none"
      ? run
      : Option.match(parseRunTimeout(configuredTimeout), {
        onNone: () => run.pipe(Effect.timeout(RUN_TIMEOUT)),
        onSome: (duration) => run.pipe(Effect.timeout(duration)),
      })
    const outcome = yield* timedRun.pipe(
      Effect.catchCause((cause) => {
        const timedOut = Option.match(Cause.findErrorOption(cause), {
          onNone: () => false,
          onSome: (error) => error instanceof Cause.TimeoutError,
        })
        return timedOut
          ? Effect.andThen(
            opencode.interrupt(input.sessionID).pipe(
              Effect.catchCause((cause) => logOpenCodeFailure("interrupt on timeout")(cause)),
            ),
            Effect.succeed<RunOutcome>("timeout"),
          )
          : logBoundary("telegram/run", "opencode-client", "open code run failed")(cause).pipe(
              Effect.andThen(Effect.succeed<RunOutcome>("error")),
            )
      }),
    )

    yield* Fiber.interrupt(flusher)
    const finalState = yield* Ref.get(state)
    const usageLine = Option.match(finalState.usage, {
      onNone: () => "",
      onSome: (usage) => `\n\n${renderUsage(usage)}`,
    })
    const finalText = truncate(renderFinal(finalState.text, outcome) + usageLine)
    const isShortAnswer =
      outcome === "done" && finalState.text.length > 0 && finalState.text.length <= SHORT_ANSWER_LIMIT
    if (isShortAnswer) {
      yield* api.sendMessage({
        chatId: input.chatId,
        text: finalText,
        messageThreadId: input.threadId,
      }).pipe(
        Effect.catchCause(logTelegramFailure("answer message failed")),
      )
      if (finalState.lastSent !== "Done.") {
        yield* api.editMessageText({
          chatId: input.chatId,
          messageId: finalState.messageId,
          text: "Done.",
        }).pipe(Effect.catchCause(logTelegramFailure("final edit failed")))
      }
    } else if (finalText !== finalState.lastSent) {
      yield* api.editMessageText({
        chatId: input.chatId,
        messageId: finalState.messageId,
        text: finalText,
      }).pipe(Effect.catchCause(logTelegramFailure("final edit failed")))
    }
  })
