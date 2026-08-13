import { Effect, Option } from "effect"
import { normalizeCommand, parsePromptCommand, promptWithReply } from "../render.js"
import type { Message } from "../api.js"
import { HELP_TEXT, sendText } from "./shared.js"
import { answerRepliedQuestion } from "./question.js"
import { runWithFiles } from "./run.js"
import { selectExactModel, showModels } from "./model.js"
import { showProjects, showSessions } from "./picker.js"
import { compactSession, listDurableReviews, reconnectRun, resetSession, resolveDurableReview, setProjectDirectory, setSessionById, showStatus, stopRun } from "./run.js"

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
    if (text === "/reconnect" || text === "/forceReconnect") {
      yield* reconnectRun(chatId, message, text === "/forceReconnect")
      return
    }
    if (text === "/compact") {
      yield* compactSession(chatId, threadId)
      return
    }
    if (text === "/models" || (text !== undefined && text.startsWith("/models "))) {
      const query = text === "/models" ? "" : text.slice("/models ".length).trim()
      yield* showModels(chatId, query, threadId)
      return
    }
    if (text === "/model" || (text !== undefined && text.startsWith("/model "))) {
      const query = text === "/model" ? "" : text.slice("/model ".length).trim()
      yield* selectExactModel(chatId, query, threadId)
      return
    }
    if (text === "/status") {
      yield* showStatus(chatId, threadId)
      return
    }
    if (text === "/reviews") {
      yield* listDurableReviews(chatId, threadId)
      return
    }
    if (text === "/resolve_review" || (text !== undefined && text.startsWith("/resolve_review "))) {
      const jobID = text === "/resolve_review" ? "" : text.slice("/resolve_review ".length).trim()
      yield* jobID.length === 0
        ? sendText(chatId, "Usage: /resolve_review <job-id>", threadId)
        : resolveDurableReview(chatId, jobID, threadId)
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
    if (text === "/session" || (text !== undefined && text.startsWith("/session "))) {
      const sessionID = text === "/session" ? "" : text.slice("/session ".length).trim()
      if (sessionID.length === 0) {
        yield* sendText(chatId, "Usage: /session <id>", threadId)
        return
      }
      yield* setSessionById(chatId, sessionID, threadId)
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
      const repliedText = replied === undefined
        ? undefined
        : replied.text ?? replied.caption
      yield* runWithFiles(chatId, message, promptWithReply(prompt.value, repliedText))
      return
    }
    // Unknown slash commands are still given a short usage hint.
    yield* sendText(chatId, "Use /prompt to run a task.", threadId)
  })
