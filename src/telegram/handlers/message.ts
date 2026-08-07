import { Effect, Option } from "effect"
import { normalizeCommand, parsePromptCommand } from "../render.js"
import type { Message } from "../api.js"
import { HELP_TEXT, sendText } from "./shared.js"
import { answerRepliedQuestion } from "./question.js"
import { runWithFiles } from "./run.js"
import { showModels } from "./model.js"
import { showProjects, showSessions } from "./picker.js"
import { compactSession, resetSession, resumeRun, setProjectDirectory, showStatus, stopRun } from "./run.js"

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
    if (text === "/start" || text === "/help") {
      yield* sendText(chatId, HELP_TEXT, threadId)
      return
    }
    if (text === "/new") {
      yield* resetSession(chatId, threadId)
      return
    }
    if (text === "/stop") {
      yield* stopRun(chatId, threadId)
      return
    }
    if (text === "/resume") {
      yield* resumeRun(chatId, threadId)
      return
    }
    if (text === "/compact") {
      yield* compactSession(chatId, threadId)
      return
    }
    if (text === "/model") {
      yield* showModels(chatId, threadId)
      return
    }
    if (text === "/status") {
      yield* showStatus(chatId, threadId)
      return
    }
    if (text === "/projects") {
      yield* showProjects(chatId, threadId)
      return
    }
    if (text === "/sessions") {
      yield* showSessions(chatId, threadId)
      return
    }
    if (text === "/whoami") {
      yield* sendText(
        chatId,
        message.from === undefined ? "Unknown user." : `Your user id is ${message.from.id}.`,
        threadId,
      )
      return
    }
    if (text === "/review" || (text !== undefined && text.startsWith("/review "))) {
      const focus = text === "/review" ? "" : text.slice("/review ".length).trim()
      const prompt = focus.length === 0
        ? "Review the current changes in this repository. Report bugs, security issues, and missing tests."
        : `Review the current changes in this repository, with focus on: ${focus}`
      yield* runWithFiles(chatId, message, prompt)
      return
    }
    if (text !== undefined && text.startsWith("/project ")) {
      const path = text.slice("/project ".length).trim()
      yield* Option.match(Option.fromNullishOr(path.length === 0 ? undefined : path), {
        onNone: () => sendText(chatId, "Usage: /project <path>", threadId),
        onSome: (directory) => setProjectDirectory(chatId, directory, threadId),
      })
      return
    }
    // Only /prompt messages are relayed as prompts.
    const prompt = parsePromptCommand(text)
    if (Option.isSome(prompt)) {
      yield* runWithFiles(chatId, message, prompt.value)
      return
    }
    // Unknown slash commands are still given a short usage hint.
    yield* sendText(chatId, "Use /prompt to run a task.", threadId)
  })
