import { Effect, Option } from "effect"
import type { Project } from "@opencode-ai/client/effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { Pickers } from "../pickers.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure, chunk, sendMarkup, sendText } from "./shared.js"
import { conversationId } from "../conversation.js"
import { TelegramDeliveryStatus } from "../delivery-assignments.js"
import { parseDirectoryPageCallback, parseSessionPageCallback } from "../render.js"
import { setProjectDirectory } from "./run.js"

const PROJECT_PAGE_SIZE = 5
const SESSION_PAGE_SIZE = 5

/** Telegram can switch only to top-level sessions; subagents are internal runs. */
export const primarySessions = <A extends { readonly parentID?: unknown }>(sessions: readonly A[]): readonly A[] =>
  sessions.filter((session) => session.parentID === undefined)

type SessionPage = {
  readonly data: readonly { readonly id: string; readonly parentID?: unknown; readonly title?: string }[]
  readonly next?: string
}

export interface SessionPagePosition {
  readonly current: { readonly cursor?: string }
  readonly history: readonly { readonly cursor?: string }[]
  readonly next?: string
}

/** Move between logical Telegram pages rather than raw filtered API pages. */
export const moveSessionPage = (
  position: SessionPagePosition,
  direction: "previous" | "next",
): Option.Option<Pick<SessionPagePosition, "current" | "history">> => {
  if (direction === "next") {
    if (position.next === undefined) return Option.none()
    return Option.some({
      current: { cursor: position.next },
      history: [...position.history, position.current],
    })
  }
  const previous = position.history.at(-1)
  return previous === undefined
    ? Option.none()
    : Option.some({ current: previous, history: position.history.slice(0, -1) })
}

/** Fetch forward until a Telegram page has five selectable top-level sessions. */
export const collectPrimarySessionPage = (
  fetchPage: (cursor: string | undefined, limit: number) => Effect.Effect<SessionPage, never>,
  initialCursor?: string,
): Effect.Effect<SessionPage, never> =>
  Effect.gen(function* () {
    const visible: { readonly id: string; readonly parentID?: unknown; readonly title?: string }[] = []
    let cursor = initialCursor
    let next: string | undefined
    const visited = new Set<string>()

    while (visible.length < SESSION_PAGE_SIZE) {
      const remaining = SESSION_PAGE_SIZE - visible.length
      const page = yield* fetchPage(cursor, remaining)
      // Request only the remaining capacity. This prevents the collector from
      // dropping top-level sessions when it has to cross child-only pages.
      visible.push(...primarySessions(page.data))
      next = page.next
      if (next === undefined || visited.has(next)) break
      visited.add(next)
      cursor = next
    }

    return { data: visible, next }
  })

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
          Effect.andThen(Effect.succeed<readonly Project.Info[]>([])),
        ),
      ),
    )
    const directories = yield* Effect.forEach(projects, (project) =>
      opencode.listProjectDirectories(project).pipe(
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
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const current = yield* store.getSessionIDForConversation(conversation)
    const list = yield* collectPrimarySessionPage((cursor, limit) => opencode.listSessions({ directory, limit, cursor }).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list sessions failed")(cause).pipe(
          Effect.andThen(Effect.succeed({
            data: [],
            next: undefined,
          })),
        ),
      ),
      Effect.map((page) => ({
        data: page.data,
        next: ("cursor" in page ? page.cursor.next : page.next) ?? undefined,
      })),
    ))
    if (list.data.length === 0) {
      yield* sendText(chatId, "No sessions in this directory.", threadId)
      return
    }
    const tokens = yield* Effect.forEach(list.data, (session) =>
      pickers.registerSession({
        sessionID: session.id,
        directory,
        title: Option.fromNullishOr(session.title),
        chatId,
      }),
    )
    const rows = [...chunk(
      list.data.map((session, index) => ({
        text: session.title ?? session.id,
        callback_data: `ses:${tokens[index]}`,
      })),
      1,
    )]
    const pageToken = yield* pickers.registerSessionPage({
      directory,
      chatId,
      current: {},
      history: [],
      next: list.next ?? undefined,
    })
    const navigation = list.next == null
      ? []
      : [{ text: "Next", callback_data: `sesp:${pageToken}:next` }]
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
        const sessions = yield* Sessions
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
            return Effect.gen(function* () {
              const conversation = conversationId({ chatId: message.chat.id, threadId: message.message_thread_id })
              const currentDirectory = yield* sessions.directoryFor(conversation)
              if (currentDirectory !== value.directory) {
                yield* answer(query.id, "This session picker is no longer current.")
                return
              }
               const target = moveSessionPage(value, parsed.direction)
               if (Option.isNone(target)) {
                 yield* answer(query.id, "No more sessions.")
                 return
               }
               const { current, history } = target.value
               const page = yield* collectPrimarySessionPage((nextCursor, limit) => opencode.listSessions({ directory: value.directory, cursor: nextCursor, limit }).pipe(
                 Effect.map((result) => ({
                   data: result.data,
                   next: result.cursor.next ?? undefined,
                 })),
                 Effect.catchCause(() => Effect.succeed({ data: [], next: undefined })),
                ), current.cursor)
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
                  current,
                  history,
                  next: page.next,
              })
               const rows = [...chunk(page.data.map((session, index) => ({
                text: session.title ?? session.id,
                callback_data: `ses:${sessionTokens[index]}`,
            })), 1)]
              const navigation = [
                 ...(history.length === 0 ? [] : [{ text: "Previous", callback_data: `sesp:${pageToken}:previous` }]),
                 ...(page.next == null ? [] : [{ text: "Next", callback_data: `sesp:${pageToken}:next` }]),
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
                false,
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
        const sessions = yield* Sessions
        const store = yield* Store
        const assignments = yield* TelegramDeliveryStatus
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
              const conversation = conversationId({ chatId: message.chat.id, threadId: message.message_thread_id })
              const currentDirectory = yield* sessions.directoryFor(conversation)
              if (currentDirectory !== value.directory) {
                yield* answer(query.id, "This session picker is no longer current.")
                return
              }
              yield* store.setSessionIDForConversation(
                conversation,
                value.sessionID,
              )
              yield* assignments.clear(conversation).pipe(
                Effect.catchCause((cause) => logBoundary(
                  "telegram/handlers",
                  "delivery-assignment",
                  "clear assignment after session picker change failed",
                )(cause)),
              )
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
