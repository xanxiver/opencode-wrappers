import { Effect, Option } from "effect"
import { normalizeCommand, parsePromptCommand, promptWithReply } from "../render.js"
import type { Message } from "../api.js"
import { HELP_TEXT, sendText } from "./shared.js"
import { answerRepliedQuestion } from "./question.js"
import { runWithFiles } from "./run.js"
import { selectExactModel, showModels } from "./model.js"
import { showProjects, showSessions } from "./picker.js"
import { compactSession, listDurableReviews, reconnectRun, resetSession, resolveDurableReview, setProjectDirectory, setSessionById, showStatus, stopRun } from "./run.js"

type ParsedCommand = {
  readonly name: string
  readonly argument: string
  readonly hasArgument: boolean
}

/** Split a normalized slash command once. The dispatcher decides its meaning. */
export const parseMessageCommand = (text: string): ParsedCommand => {
  const separator = text.indexOf(" ")
  if (separator < 0) return { name: text, argument: "", hasArgument: false }
  return {
    name: text.slice(0, separator),
    argument: text.slice(separator + 1).trim(),
    hasArgument: true,
  }
}

export const handleMessage = (message: Message) =>
  Effect.gen(function* () {
    const chatId = message.chat.id
    // Telegram appends the bot name to commands ("/model@MyBot");
    // strip it so command matching works.
    const text = Option.match(Option.fromNullishOr(message.text), {
      onNone: () => undefined,
      onSome: (raw) => normalizeCommand(raw),
    })
    const replied = message.reply_to_message
    const threadId = message.message_thread_id

    // A plain-text reply can answer an agent question. Check this before the
    // slash-command guard, otherwise the documented free-text answer path is
    // unreachable.
    if (replied !== undefined && text !== undefined) {
      const answered = yield* answerRepliedQuestion(chatId, replied.message_id, text, threadId)
      if (answered) return
    }

    // Messages without a slash command are not bot requests. Ignore them
    // silently, including attachment-only messages.
    if (text === undefined || !text.startsWith("/")) return
    const command = parseMessageCommand(text)
    switch (command.name) {
      case "/start":
      case "/help":
        if (command.hasArgument) break
        yield* sendText(chatId, HELP_TEXT, threadId)
        return
      case "/new":
        if (command.hasArgument) break
        yield* resetSession(chatId, threadId)
        return
      case "/stop":
        if (command.hasArgument) break
        yield* stopRun(chatId, threadId)
        return
      case "/reconnect":
      case "/forceReconnect":
        if (command.hasArgument) break
        yield* reconnectRun(chatId, message, command.name === "/forceReconnect")
        return
      case "/compact":
        if (command.hasArgument) break
        yield* compactSession(chatId, threadId)
        return
      case "/models":
        yield* showModels(chatId, command.argument, threadId)
        return
      case "/model":
        yield* selectExactModel(chatId, command.argument, threadId)
        return
      case "/status":
        if (command.hasArgument) break
        yield* showStatus(chatId, threadId)
        return
      case "/reviews":
        if (command.hasArgument) break
        yield* listDurableReviews(chatId, threadId)
        return
      case "/resolve_review":
        yield* command.argument.length === 0
          ? sendText(chatId, "Usage: /resolve_review <job-id>", threadId)
          : resolveDurableReview(chatId, command.argument, threadId)
        return
      case "/projects":
        if (command.hasArgument) break
        yield* showProjects(chatId, threadId)
        return
      case "/sessions":
        if (command.hasArgument) break
        yield* showSessions(chatId, threadId)
        return
      case "/session":
        yield* command.argument.length === 0
          ? sendText(chatId, "Usage: /session <id>", threadId)
          : setSessionById(chatId, command.argument, threadId)
        return
      case "/whoami":
        if (command.hasArgument) break
        yield* sendText(chatId, message.from === undefined ? "Unknown user." : `Your user id is ${message.from.id}.`, threadId)
        return
      case "/review": {
        const prompt = command.argument.length === 0
          ? "Review the current changes in this repository. Report bugs, security issues, and missing tests."
          : `Review the current changes in this repository, with focus on: ${command.argument}`
        yield* runWithFiles(chatId, message, prompt)
        return
      }
      case "/project":
        if (!command.hasArgument) break
        yield* command.argument.length === 0
          ? sendText(chatId, "Usage: /project <path>", threadId)
          : setProjectDirectory(chatId, command.argument, threadId)
        return
    }
    // Only /prompt messages are relayed as prompts.
    const prompt = parsePromptCommand(text)
    if (Option.isSome(prompt)) {
      const repliedText = replied === undefined
        ? undefined
        : replied.text ?? replied.caption
      yield* runWithFiles(chatId, message, promptWithReply(prompt.value, repliedText))
      return
    }
    // Unknown slash commands are still given a short usage hint.
    yield* sendText(chatId, "Use /prompt to run a task.", threadId)
  })
