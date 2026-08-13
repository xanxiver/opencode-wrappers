import { Effect, Option } from "effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { Pickers } from "../pickers.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure, chunk, clientId, sendMarkup, sendText } from "./shared.js"
import { parseDirectoryPageCallback, parseSessionPageCallback } from "../render.js"
import { setProjectDirectory } from "./run.js"

const PROJECT_PAGE_SIZE = 10

const projectPickerPage = (directories: readonly string[], page: number, chatId: number) =>
  Effect.gen(function* () {
    const pickers = yield* Pickers
    const pageCount = Math.ceil(directories.length / PROJECT_PAGE_SIZE)
    const visible = directories.slice(page * PROJECT_PAGE_SIZE, (page + 1) * PROJECT_PAGE_SIZE)
    const tokens = yield* Effect.forEach(visible, (directory) => pickers.registerDirectory({ directory, chatId }))
    const pageToken = yield* pickers.registerDirectoryPage({ directories, page, chatId })
    const rows = [...chunk(visible.map((directory, index) => ({
      text: directory,
      callback_data: `dir:${tokens[index]}`,
    })), 1)]
    const navigation = [
      ...(page <= 0 ? [] : [{ text: "Previous", callback_data: `dirp:${pageToken}:${page - 1}` }]),
      ...(page + 1 >= pageCount ? [] : [{ text: "Next", callback_data: `dirp:${pageToken}:${page + 1}` }]),
    ]
    if (navigation.length > 0) rows.push(navigation)
    rows.push([{ text: "Cancel", callback_data: `dirc:${pageToken}` }])
    return { rows, tokens, pageToken, pageCount }
  })

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
        Effect.catchCause((cause) =>
          logBoundary("telegram/handlers", "opencode-client", "list project directories failed")(cause).pipe(
            Effect.andThen(Effect.succeed<readonly { directory: string }[]>([])),
          ),
        ),
        Effect.map((items) => items.map((item) => item.directory)),
      ),
    ).pipe(Effect.map((nested) => [...new Set(nested.flat())]))
    if (directories.length === 0) {
      yield* sendText(chatId, "No projects found.", threadId)
      return
    }
    const sorted = [...directories].sort((left, right) => left.localeCompare(right))
    const page = yield* projectPickerPage(sorted, 0, chatId)
    const message = yield* sendMarkup(
      chatId,
      `Select a project directory (page 1 of ${page.pageCount}):`,
      { inline_keyboard: page.rows },
      threadId,
    )
    yield* Option.match(message, {
      onNone: () => Effect.void,
      onSome: (sent) =>
        Effect.gen(function* () {
          yield* Effect.forEach(page.tokens, (token) => pickers.attachMessageId(token, sent.message_id), { discard: true })
          yield* pickers.attachMessageId(page.pageToken, sent.message_id)
        }),
    })
  })

/** Navigate the project-directory picker. */
export const handleDirectoryPageCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseDirectoryPageCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) => {
            if (!("kind" in value) || value.kind !== "directory-page") return answer(query.id, "Invalid entry.")
            const pageCount = Math.ceil(value.directories.length / PROJECT_PAGE_SIZE)
            if (parsed.page >= pageCount) return answer(query.id, "No more projects.")
            return Effect.gen(function* () {
              const page = yield* projectPickerPage(value.directories, parsed.page, value.chatId)
              yield* Effect.forEach(page.tokens, (token) => pickers.attachMessageId(token, message.message_id), { discard: true })
              yield* pickers.attachMessageId(page.pageToken, message.message_id)
              yield* apiEdit(value.chatId, message.message_id, `Select a project directory (page ${parsed.page + 1} of ${page.pageCount}):`, { inline_keyboard: page.rows })
              yield* answer(query.id, "Page changed.")
            }).pipe(Effect.catchCause(callbackFailure(query, "directory page callback failed", "Failed.")))
          },
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "directory page callback failed", "Failed."))),
  })

/** Cancel the project-directory picker without changing the directory. */
export const handleDirectoryCancelCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseTokenCallback(data, "dirc"), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.cancel(token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) => apiEdit(value.chatId, value.messageId, "Project selection cancelled.").pipe(
            Effect.andThen(answer(query.id, "Cancelled.")),
          ),
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "directory cancel callback failed", "Failed."))),
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
    const list = yield* opencode.listSessions({ directory, limit: 20 }).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list sessions failed")(cause).pipe(
          Effect.andThen(Effect.succeed({
            data: [],
            previous: undefined,
            next: undefined,
          })),
        ),
      ),
      Effect.map((page) => ({
        data: page.data,
        previous: "cursor" in page ? page.cursor.previous : page.previous,
        next: "cursor" in page ? page.cursor.next : page.next,
      })),
    )
    if (list.data.length === 0) {
      yield* sendText(chatId, "No sessions in this directory.", threadId)
      return
    }
    const visible = list.data
    const tokens = yield* Effect.forEach(visible, (session) =>
      pickers.registerSession({
        sessionID: session.id,
        directory,
        title: Option.fromNullishOr(session.title),
        chatId,
      }),
    )
    const rows = [...chunk(
      visible.map((session, index) => ({
        text: session.title ?? session.id,
        callback_data: `ses:${tokens[index]}`,
      })),
      1,
    )]
    const pageToken = yield* pickers.registerSessionPage({
      directory,
      chatId,
      previous: list.previous ?? undefined,
      next: list.next ?? undefined,
    })
    const navigation = [
      ...(list.previous == null ? [] : [{ text: "Previous", callback_data: `sesp:${pageToken}:previous` }]),
      ...(list.next == null ? [] : [{ text: "Next", callback_data: `sesp:${pageToken}:next` }]),
    ]
    if (navigation.length > 0) rows.push(navigation)
    rows.push([{ text: "Cancel", callback_data: `sesc:${pageToken}` }])
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
        Effect.gen(function* () {
          yield* Effect.forEach(tokens, (token) => pickers.attachMessageId(token, sent.message_id), { discard: true })
          yield* pickers.attachMessageId(pageToken, sent.message_id)
        }),
    })
  })

/** Navigate the cursor-based session picker. */
export const handleSessionPageCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseSessionPageCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const opencode = yield* OpenCode
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) => {
            if (!("kind" in value) || value.kind !== "session-page") return answer(query.id, "Invalid entry.")
            const cursor = parsed.direction === "next" ? value.next : value.previous
            if (cursor === undefined) return answer(query.id, "No more sessions.")
            return Effect.gen(function* () {
              const page = yield* opencode.listSessions({ directory: value.directory, cursor, limit: 20 })
              if (page.data.length === 0) {
                yield* answer(query.id, "No sessions on that page.")
                return
              }
              const sessionTokens = yield* Effect.forEach(page.data, (session) => pickers.registerSession({
                sessionID: session.id,
                directory: value.directory,
                title: Option.fromNullishOr(session.title),
                chatId: value.chatId,
              }))
              const pageToken = yield* pickers.registerSessionPage({
                directory: value.directory,
                chatId: value.chatId,
                previous: page.cursor.previous ?? undefined,
                next: page.cursor.next ?? undefined,
              })
            const rows = [...chunk(page.data.map((session, index) => ({
                text: session.title ?? session.id,
                callback_data: `ses:${sessionTokens[index]}`,
            })), 1)]
              const navigation = [
                ...(page.cursor.previous == null ? [] : [{ text: "Previous", callback_data: `sesp:${pageToken}:previous` }]),
                ...(page.cursor.next == null ? [] : [{ text: "Next", callback_data: `sesp:${pageToken}:next` }]),
              ]
              if (navigation.length > 0) rows.push(navigation)
              rows.push([{ text: "Cancel", callback_data: `sesc:${pageToken}` }])
              yield* pickers.attachMessageId(pageToken, message.message_id)
              yield* Effect.forEach(sessionTokens, (token) => pickers.attachMessageId(token, message.message_id), { discard: true })
              yield* apiEdit(value.chatId, message.message_id, `Sessions in ${value.directory}:`, { inline_keyboard: rows })
              yield* answer(query.id, "Page changed.")
            }).pipe(Effect.catchCause(callbackFailure(query, "session page callback failed", "Failed.")))
          },
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "session page callback failed", "Failed."))),
  })

/** Cancel the session picker without changing the active session. */
export const handleSessionCancelCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseTokenCallback(data, "sesc"), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) =>
      Effect.gen(function* () {
        const pickers = yield* Pickers
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* pickers.cancel(token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) =>
            apiEdit(value.chatId, value.messageId, "Session selection cancelled.").pipe(
              Effect.andThen(answer(query.id, "Cancelled.")),
            ),
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "session cancel callback failed", "Failed."))),
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
