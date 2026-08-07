import { Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { Pickers } from "../pickers.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure, chunk, clientId, sendMarkup, sendText } from "./shared.js"
import { setProjectDirectory } from "./run.js"

/** `/projects` — list project directories, let the user pick one for this chat. */
export const showProjects = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const pickers = yield* Pickers
    const projects = yield* opencode.listProjects().pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list projects failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly { id: string }[]>([])),
        ),
      ),
    )
    const directories = yield* Effect.forEach(projects, (project) =>
      opencode.listProjectDirectories(project.id).pipe(
        Effect.catchCause(() => Effect.succeed<readonly { directory: string }[]>([])),
        Effect.map((items) => items.map((item) => item.directory)),
      ),
    ).pipe(Effect.map((nested) => [...new Set(nested.flat())]))
    if (directories.length === 0) {
      yield* sendText(chatId, "No projects found.", threadId)
      return
    }
    const visible = directories.slice(0, 20)
    const tokens = yield* Effect.forEach(visible, (directory) =>
      pickers.registerDirectory({ directory, chatId })
    )
    const rows = chunk(
      visible.map((directory, index) => ({
        text: directory,
        callback_data: `dir:${tokens[index]}`,
      })),
      1,
    )
    const message = yield* sendMarkup(
      chatId,
      directories.length > visible.length
        ? `Select a project directory (showing ${visible.length} of ${directories.length}):`
        : `Select a project directory (${directories.length}):`,
      { inline_keyboard: rows },
      threadId,
    )
    yield* Option.match(message, {
      onNone: () => Effect.void,
      onSome: (sent) =>
        Effect.forEach(tokens, (token) => pickers.attachMessageId(token, sent.message_id), { discard: true }),
    })
  })

/** `/sessions` — list sessions in the chat directory, let the user switch. */
export const showSessions = (chatId: number, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const pickers = yield* Pickers
    const directory = yield* sessions.directoryFor(clientId(chatId))
    const current = yield* store.getSessionIDForDirectory(directory)
    const list = yield* opencode.listSessions(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list sessions failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly { id: string; title?: string }[]>([])),
        ),
      ),
    )
    if (list.length === 0) {
      yield* sendText(chatId, "No sessions in this directory.", threadId)
      return
    }
    const visible = list.slice(0, 20)
    const tokens = yield* Effect.forEach(visible, (session) =>
      pickers.registerSession({
        sessionID: session.id,
        directory,
        title: Option.fromNullishOr(session.title),
        chatId,
      }),
    )
    const rows = chunk(
      visible.map((session, index) => ({
        text: session.title ?? session.id,
        callback_data: `ses:${tokens[index]}`,
      })),
      1,
    )
    const currentLine = Option.match(current, {
      onNone: () => "No active session.",
      onSome: (id) => `Current: ${id}`,
    })
    const message = yield* sendMarkup(
      chatId,
      `Sessions in ${directory}:\n${currentLine}`,
      { inline_keyboard: rows },
      threadId,
    )
    yield* Option.match(message, {
      onNone: () => Effect.void,
      onSome: (sent) =>
        Effect.forEach(tokens, (token) => pickers.attachMessageId(token, sent.message_id), { discard: true }),
    })
  })

export const handleDirectoryCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseTokenCallback(data, "dir"), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.take(token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) => {
            if (!("directory" in value)) return answer(query.id, "Invalid entry.")
            return Effect.gen(function* () {
              const updated = yield* setProjectDirectory(
                message.chat.id,
                value.directory,
                message.message_thread_id,
              )
              if (!updated) {
                yield* answer(query.id, "Failed.")
                return
              }
              // Replace the picker message, which removes the keyboard,
              // mirroring the model picker.
              yield* apiEdit(message.chat.id, message.message_id, `Directory set to ${value.directory}.`)
              yield* answer(query.id, "Directory set.")
            }).pipe(Effect.catchCause(callbackFailure(query, "directory callback failed", "Failed.")))
          },
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "directory callback failed", "Failed."))),
  })

export const handleSessionCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseTokenCallback(data, "ses"), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const store = yield* Store
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.take(token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) => {
            if (!("sessionID" in value)) return answer(query.id, "Invalid entry.")
            return Effect.gen(function* () {
              yield* store.setSessionIDForDirectory(value.directory, value.sessionID)
              const label = Option.getOrElse(value.title, () => value.sessionID)
              // Replace the picker message, which removes the keyboard,
              // mirroring the model picker.
              yield* apiEdit(message.chat.id, message.message_id, `Active session: ${label}.`)
              yield* answer(query.id, `Active session: ${label}.`)
            }).pipe(Effect.catchCause(callbackFailure(query, "session callback failed", "Failed.")))
          },
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "session callback failed", "Failed."))),
  })

/** Parse callback data of the form `<prefix>:<token>`. */
export const parseTokenCallback = (data: string, prefix: string): Option.Option<number> => {
  const parts = data.split(":")
  if (parts.length !== 2 || parts[0] !== prefix) return Option.none()
  const token = Number(parts[1])
  if (!Number.isInteger(token) || token <= 0) return Option.none()
  return Option.some(token)
}
