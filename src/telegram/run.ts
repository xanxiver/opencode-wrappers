import { Cause, Deferred, Duration, Effect, Exit, FileSystem, Fiber, Option, Path, Ref, Schedule, Schema, Stream } from "effect"
import { Buffer } from "node:buffer"
import type { HttpClient } from "effect/unstable/http"
import type { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import type { Attachment } from "../core/attachments.js"
import { toFileAttachment } from "../core/attachments.js"
import type { DurableExecutorError, DurableLeaseLost } from "../core/durable-executor.js"
import { logBoundary } from "../core/logging.js"
import { OpenCode, questionRequestFromEvent, type PendingQuestionRequest } from "../core/opencode.js"
import { isDefinitiveSendRejection, recordDefinitiveSendFailure, TelegramApi, type KeyboardMarkup } from "./api.js"
import { AppConfigTag, parseRunTimeout } from "../config.js"
import { PermissionRegistry, type PermissionRegistryService } from "./permissions.js"
import type { InteractionStoreError } from "./interaction-store.js"
import { QuestionRegistry, type QuestionRegistryService } from "./questions.js"
import {
  renderFinal,
  renderPermission,
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
  readonly reconnect?: boolean
  /** Accepted OpenCode input used to select only this run's final response. */
  readonly inputID?: string
  /** Reuse the durable Telegram anchor while recovering a run. */
  readonly progressMessageID?: number
  /** Persist the Telegram anchor before execution continues. */
  readonly onProgressMessage?: (messageID: number) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Fence initial Telegram message creation before crossing the API boundary. */
  readonly onProgressDispatching?: () => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Clear the fence when Telegram definitively rejects message creation. */
  readonly onProgressRejected?: () => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Persist OpenCode acceptance before monitoring continues. */
  readonly onAccepted?: (inputID: string) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Fence an uncertain OpenCode submission before calling the API. */
  readonly onDispatching?: () => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
  /** Persist the canonical result before Telegram finalization. */
  readonly onFinalizing?: (result: RunFinalization) => Effect.Effect<void, DurableExecutorError | DurableLeaseLost>
}

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
  readonly media: readonly MediaArtifact[]
  readonly mediaKeys: ReadonlySet<string>
}

export interface MediaArtifact {
  readonly key: string
  readonly name: string
  readonly mime: string
  readonly bytes: Uint8Array
}

export interface RunFinalization {
  readonly text: string
  readonly media: readonly MediaArtifact[]
}

const ToolFilePartSchema = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  mime: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})
const ToolStateSchema = Schema.Struct({ content: Schema.Array(Schema.Unknown) })
type ToolFilePart = Schema.Schema.Type<typeof ToolFilePartSchema>

type ToolContentValue = ReturnType<typeof JSON.parse>

const isToolFilePart = (value: ToolContentValue): value is ToolFilePart => {
  const decoded = Exit.getSuccess(Schema.decodeUnknownExit(ToolFilePartSchema)(value))
  return Option.isSome(decoded) && (decoded.value.uri !== undefined || decoded.value.path !== undefined)
}

const decodeToolFilePart = (value: ToolContentValue): Option.Option<ToolFilePart> => {
  const decoded = Exit.getSuccess(Schema.decodeUnknownExit(ToolFilePartSchema)(value))
  return Option.filter(decoded, (part) => part.uri !== undefined || part.path !== undefined)
}

const decodeToolFileJson = (value: string): Option.Option<ToolFilePart> => {
  const decoded = Exit.getSuccess(Schema.decodeUnknownExit(Schema.fromJsonString(ToolFilePartSchema))(value))
  return Option.filter(decoded, (part) => part.uri !== undefined || part.path !== undefined)
}

const deduplicateMedia = (media: readonly MediaArtifact[]): readonly MediaArtifact[] => {
  const keys = new Set<string>()
  return media.filter((item) => {
    if (keys.has(item.key)) return false
    keys.add(item.key)
    return true
  })
}

const MAX_TELEGRAM_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_TELEGRAM_MEDIA_COUNT = 10
const MAX_TELEGRAM_MEDIA_TOTAL_BYTES = 50 * 1024 * 1024

type SupportedMediaMime =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm"

const startsWithBytes = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte)

const asciiAt = (bytes: Uint8Array, offset: number, value: string): boolean =>
  offset + value.length <= bytes.length && [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0))

const containsAscii = (bytes: Uint8Array, value: string, maxBytes: number): boolean => {
  const limit = Math.min(bytes.length - value.length, maxBytes - value.length)
  for (let offset = 0; offset <= limit; offset += 1) {
    if (asciiAt(bytes, offset, value)) return true
  }
  return false
}

const mp4Brands = new Set(["avc1", "iso2", "iso3", "iso4", "iso5", "iso6", "isom", "M4V ", "mp41", "mp42"])

const uint32BigEndian = (bytes: Uint8Array, offset: number): number | undefined =>
  offset + 4 > bytes.length
    ? undefined
    : (((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0))

const uint32LittleEndian = (bytes: Uint8Array, offset: number): number | undefined =>
  offset + 4 > bytes.length
    ? undefined
    : ((bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16) + ((bytes[offset + 3] ?? 0) * 0x1000000))

const crc32 = (bytes: Uint8Array, start: number, end: number): number => {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const isPng = (bytes: Uint8Array): boolean => {
  if (!startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false
  let offset = 8
  let first = true
  let hasImageData = false
  while (offset + 12 <= bytes.length) {
    const length = uint32BigEndian(bytes, offset)
    if (length === undefined || length > bytes.length - offset - 12) return false
    const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
    if (first && (type !== "IHDR" || length !== 13)) return false
    const expectedCrc = uint32BigEndian(bytes, offset + 8 + length)
    if (expectedCrc === undefined || crc32(bytes, offset + 4, offset + 8 + length) !== expectedCrc) return false
    if (first) {
      const width = uint32BigEndian(bytes, offset + 8)
      const height = uint32BigEndian(bytes, offset + 12)
      if (width === undefined || height === undefined || width === 0 || height === 0) return false
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || (bytes[offset + 20] ?? 2) > 1) return false
    }
    if (type === "IDAT") hasImageData = true
    const next = offset + 12 + length
    if (type === "IEND") return hasImageData && length === 0 && next === bytes.length
    first = false
    offset = next
  }
  return false
}

const isJpeg = (bytes: Uint8Array): boolean => {
  if (!startsWithBytes(bytes, [0xff, 0xd8, 0xff]) || bytes.length < 8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false
  let offset = 2
  let hasFrame = false
  let hasScan = false
  while (offset + 1 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset] ?? 0
    offset += 1
    if (marker === 0xd9) return hasFrame && offset === bytes.length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return false
    const length = ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0)
    if (length < 2 || offset + length > bytes.length) return false
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 8 || bytes[offset + 3] === 0 && bytes[offset + 4] === 0 || bytes[offset + 5] === 0 && bytes[offset + 6] === 0) return false
      hasFrame = true
    }
    offset += length
    if (marker === 0xda) {
      hasScan = true
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        const next = bytes[offset + 1] ?? 0
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2
          continue
        }
        break
      }
    }
  }
  return hasFrame && hasScan && offset === bytes.length - 2
}

const skipGifSubBlocks = (bytes: Uint8Array, start: number): number | undefined => {
  let offset = start
  while (offset < bytes.length) {
    const length = bytes[offset] ?? 0
    offset += 1
    if (length === 0) return offset
    if (offset + length > bytes.length) return undefined
    offset += length
  }
  return undefined
}

const isGif = (bytes: Uint8Array): boolean => {
  if (bytes.length < 14 || (!asciiAt(bytes, 0, "GIF87a") && !asciiAt(bytes, 0, "GIF89a"))) return false
  if ((bytes[6] ?? 0) + (bytes[7] ?? 0) === 0 || (bytes[8] ?? 0) + (bytes[9] ?? 0) === 0) return false
  const packed = bytes[10] ?? 0
  let offset = 13 + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1))
  let hasImage = false
  while (offset < bytes.length) {
    const marker = bytes[offset] ?? 0
    offset += 1
    if (marker === 0x3b) return hasImage && offset === bytes.length
    if (marker === 0x21) {
      if (offset >= bytes.length) return false
      offset += 1
      const next = skipGifSubBlocks(bytes, offset)
      if (next === undefined) return false
      offset = next
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return false
    const imagePacked = bytes[offset + 8] ?? 0
    offset += 9 + ((imagePacked & 0x80) === 0 ? 0 : 3 * 2 ** ((imagePacked & 0x07) + 1))
    if (offset >= bytes.length || (bytes[offset] ?? 0) > 12) return false
    const next = skipGifSubBlocks(bytes, offset + 1)
    if (next === undefined) return false
    offset = next
    hasImage = true
  }
  return false
}

const isWebp = (bytes: Uint8Array): boolean => {
  if (bytes.length < 20 || !asciiAt(bytes, 0, "RIFF") || !asciiAt(bytes, 8, "WEBP")) return false
  const size = uint32LittleEndian(bytes, 4)
  if (size !== bytes.length - 8) return false
  let offset = 12
  let hasImage = false
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0)
    const length = uint32LittleEndian(bytes, offset + 4)
    if (length === undefined || length > bytes.length - offset - 8) return false
    if (["VP8 ", "VP8L", "VP8X"].includes(type)) hasImage = true
    offset += 8 + length + (length % 2)
  }
  return hasImage && offset === bytes.length
}

const isoMediaMime = (bytes: Uint8Array): SupportedMediaMime | undefined => {
  let offset = 0
  let mime: SupportedMediaMime | undefined
  let hasMediaBox = false
  while (offset + 8 <= bytes.length) {
    const declaredSize = uint32BigEndian(bytes, offset)
    if (declaredSize === undefined) return undefined
    const size = declaredSize === 0 ? bytes.length - offset : declaredSize
    if (size < 8 || size > bytes.length - offset) return undefined
    const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
    if (type === "ftyp" && size >= 12) {
      const brand = String.fromCharCode(bytes[offset + 8] ?? 0, bytes[offset + 9] ?? 0, bytes[offset + 10] ?? 0, bytes[offset + 11] ?? 0)
      if (brand === "qt  ") mime = "video/quicktime"
      else if (mp4Brands.has(brand)) mime = "video/mp4"
      else return undefined
    }
    if (type === "mdat" || type === "moov") hasMediaBox = true
    offset += size
  }
  return offset === bytes.length && hasMediaBox ? mime : undefined
}

/** Detect supported Telegram media from bytes. Declared MIME types are not trusted. */
export const detectSupportedMediaMime = (bytes: Uint8Array): SupportedMediaMime | undefined => {
  if (isPng(bytes)) return "image/png"
  if (isJpeg(bytes)) return "image/jpeg"
  if (isGif(bytes)) return "image/gif"
  if (isWebp(bytes)) return "image/webp"
  if (
    startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]) &&
    startsWithBytes(bytes.subarray(4), [0x18, 0x53, 0x80, 0x67]) &&
    containsAscii(bytes, "webm", 4_096) &&
    bytes.some((byte, index) => byte === 0x1f && startsWithBytes(bytes.subarray(index), [0x1f, 0x43, 0xb6, 0x75]))
  ) return "video/webm"
  return isoMediaMime(bytes)
}

const validatedMedia = (
  part: ToolFilePart,
  bytes: Uint8Array,
  fallbackName: string,
  key: string,
  uriMime?: string,
): MediaArtifact | undefined => {
  if (bytes.length === 0 || bytes.length > MAX_TELEGRAM_MEDIA_BYTES) return undefined
  const mime = detectSupportedMediaMime(bytes)
  if (mime === undefined) return undefined
  const declaredMime = part.mime ?? uriMime
  if (declaredMime !== undefined && declaredMime !== mime) return undefined
  const name = part.name?.trim() || fallbackName
  return { key: `${key}:${mime}`, name, mime, bytes }
}

const limitMedia = (media: readonly MediaArtifact[]): readonly MediaArtifact[] => {
  let totalBytes = 0
  const accepted: MediaArtifact[] = []
  for (const item of deduplicateMedia(media)) {
    if (accepted.length >= MAX_TELEGRAM_MEDIA_COUNT || totalBytes + item.bytes.length > MAX_TELEGRAM_MEDIA_TOTAL_BYTES) break
    accepted.push(item)
    totalBytes += item.bytes.length
  }
  return accepted
}

/** Decode an inline data URI without performing I/O. */
const mediaFromToolPart = (part: ToolFilePart, maxBytes: number): MediaArtifact | undefined => {
  if (part.path !== undefined) return undefined
  const uri = part.uri
  if (uri === undefined || !uri.startsWith("data:")) return undefined
  const comma = uri.indexOf(",")
  if (comma < 0) return undefined
  const metadata = uri.slice(5, comma).split(";")
  if (!metadata.includes("base64")) return undefined
  const encoded = uri.slice(comma + 1)
  if (encoded.length > Math.ceil(Math.min(MAX_TELEGRAM_MEDIA_BYTES, maxBytes) / 3) * 4) return undefined
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
  const uriMime = metadata[0]?.trim() || undefined
  const compactKey = `data:${encoded.length}:${encoded.slice(0, 128)}:${encoded.slice(-128)}`
  return validatedMedia(part, bytes, "generated-media", compactKey, uriMime)
}

/** Load generated files through the Effect FileSystem service at the boundary. */
const mediaFromToolPartEffect = (part: ToolFilePart, maxBytes: number): Effect.Effect<Option.Option<MediaArtifact>, never, FileSystem.FileSystem | Path.Path> =>
  part.path === undefined
    ? Effect.succeed(Option.fromNullishOr(mediaFromToolPart(part, maxBytes)))
    : Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const filePath = part.path
        if (filePath === undefined || !paths.isAbsolute(filePath)) return Option.none<MediaArtifact>()
        const details = yield* fs.stat(filePath).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            logBoundary("telegram/run", "media-file", `failed to inspect ${filePath}`)(cause).pipe(
              Effect.andThen(Effect.succeed(Option.none())),
            ),
          ),
        )
        if (Option.isNone(details) || details.value.type !== "File" || details.value.size > BigInt(Math.min(MAX_TELEGRAM_MEDIA_BYTES, maxBytes))) {
          return Option.none<MediaArtifact>()
        }
        const bytes = yield* fs.readFile(filePath).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            logBoundary("telegram/run", "media-file", `failed to read ${filePath}`)(cause).pipe(
              Effect.andThen(Effect.succeed(Option.none<Uint8Array>())),
            ),
          ),
        )
        if (Option.isNone(bytes)) return Option.none<MediaArtifact>()
        const media = validatedMedia(part, bytes.value, paths.basename(filePath), filePath)
        if (media === undefined) return Option.none<MediaArtifact>()
        // A path identifies the artifact for the duration of a run. Do not
        // include the current byte length: screenshots can be rewritten
        // between the tool event and the final response marker, which would
        // otherwise make the same file look like two different attachments.
        return Option.some(media)
      })

const collectMediaParts = (parts: readonly unknown[]): Effect.Effect<readonly MediaArtifact[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const items: MediaArtifact[] = []
    const keys = new Set<string>()
    let totalBytes = 0
    for (const part of parts) {
      if (items.length >= MAX_TELEGRAM_MEDIA_COUNT || totalBytes >= MAX_TELEGRAM_MEDIA_TOTAL_BYTES) break
      let candidate = Option.none<ToolFilePart>()
      if (isToolFilePart(part)) candidate = decodeToolFilePart(part)
      else {
        const textPart = Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))(part),
        )
        if (textPart !== undefined) candidate = decodeToolFileJson(textPart.text)
      }
      if (Option.isNone(candidate)) continue
      const media = yield* mediaFromToolPartEffect(candidate.value, MAX_TELEGRAM_MEDIA_TOTAL_BYTES - totalBytes)
      if (Option.isNone(media) || keys.has(media.value.key)) continue
      keys.add(media.value.key)
      items.push(media.value)
      totalBytes += media.value.bytes.length
    }
    return items
  })

const mediaFromToolContentEffect = (content: ToolContentValue): Effect.Effect<readonly MediaArtifact[], never, FileSystem.FileSystem | Path.Path> =>
  Array.isArray(content) ? collectMediaParts(content) : Effect.succeed([])

export const mediaFromResponseText = (text: string): Effect.Effect<{ readonly text: string; readonly media: readonly MediaArtifact[] }, never, FileSystem.FileSystem | Path.Path> => {
  const contracts: ToolFilePart[] = []
  const visibleText = text.replace(TELEGRAM_MEDIA_PATTERN, (_match, encoded: string) => {
    Option.map(decodeToolFileJson(encoded), (part) => contracts.push(part))
    return ""
  }).trim()
  return collectMediaParts(contracts).pipe(Effect.map((media) => ({ text: visibleText, media })))
}

const TELEGRAM_MEDIA_PATTERN = /<telegram-media>\s*([\s\S]*?)\s*<\/telegram-media>/g

const visibleResponseText = (text: string): string => text.replace(TELEGRAM_MEDIA_PATTERN, "").trim()

interface RecoverableMessage {
  readonly id: string
  readonly type: string
  readonly content?: readonly { readonly type: string; readonly text?: string; readonly state?: unknown }[]
}

interface RecoverableMessagePage {
  readonly data: readonly RecoverableMessage[]
  readonly cursor: { readonly next?: string }
}

export const MAX_RECOVERY_MESSAGE_PAGES = 100

const assistantTurnForInput = (
  messages: readonly RecoverableMessage[],
  inputID: string,
): readonly RecoverableMessage[] => {
  const inputIndex = messages.findIndex((message) => message.id === inputID && message.type === "user")
  if (inputIndex < 0) return []
  const turn: RecoverableMessage[] = []
  for (let index = inputIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.type === "user") break
    if (message.type === "assistant") turn.push(message)
  }
  return turn
}

/** Select the complete assistant turn after an accepted input from a descending page. */
export const assistantResponseForInput = (messages: readonly RecoverableMessage[], inputID: string): string | undefined => {
  const text = assistantTurnForInput(messages, inputID).flatMap((message) =>
    (message.content ?? []).flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : [])
  ).filter((part) => part.length > 0).join("\n\n")
  return text.length === 0 ? undefined : text
}

const toolMediaPartsForInput = (messages: readonly RecoverableMessage[], inputID: string): readonly unknown[] =>
  assistantTurnForInput(messages, inputID).flatMap((message) => (message.content ?? []).flatMap((part) => {
    if (part.type !== "tool") return []
    const state = Option.getOrUndefined(Schema.decodeUnknownOption(ToolStateSchema)(part.state))
    return state?.content ?? []
  }))

export const recoveredResponseForInput = (
  messages: readonly RecoverableMessage[],
  inputID: string,
): Effect.Effect<Option.Option<{ readonly text: string; readonly media: readonly MediaArtifact[] }>, never, FileSystem.FileSystem | Path.Path> => {
  const turn = assistantTurnForInput(messages, inputID)
  if (turn.length === 0) return Effect.succeed(Option.none())
  const text = assistantResponseForInput(messages, inputID) ?? ""
  return Effect.all({
    response: mediaFromResponseText(text),
    toolMedia: collectMediaParts(toolMediaPartsForInput(messages, inputID)),
  }).pipe(Effect.map(({ response, toolMedia }) => {
    const media = limitMedia([...toolMedia, ...response.media])
    return response.text.length === 0 && media.length === 0
      ? Option.none()
      : Option.some({ text: response.text, media })
  }))
}

/** Page backward through message history until the accepted input is found. */
export const recoveredResponseFromPages = <R>(
  inputID: string,
  listPage: (cursor?: string) => Effect.Effect<RecoverableMessagePage | undefined, never, R>,
): Effect.Effect<Option.Option<{ readonly text: string; readonly media: readonly MediaArtifact[] }>, never, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const messages: RecoverableMessage[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < MAX_RECOVERY_MESSAGE_PAGES; pageIndex += 1) {
      const page = yield* listPage(cursor)
      if (page === undefined) return Option.none()
      messages.push(...page.data)
      if (messages.some((message) => message.id === inputID && message.type === "user")) {
        return yield* recoveredResponseForInput(messages, inputID)
      }
      const next = page.cursor.next
      if (next === undefined || cursors.has(next)) return Option.none()
      cursors.add(next)
      cursor = next
    }
    return Option.none()
  })

export const recoveredResponseFromHistory = (
  sessionID: string,
  inputID: string,
): Effect.Effect<Option.Option<{ readonly text: string; readonly media: readonly MediaArtifact[] }>, never, OpenCode | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    return yield* recoveredResponseFromPages(inputID, (cursor) =>
      opencode.listMessages({ sessionID, limit: 100, order: "desc", cursor }).pipe(
        Effect.catchCause((cause) => logOpenCodeFailure("read canonical final response failed")(cause).pipe(Effect.as(undefined))),
      ))
  })

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
  const text = truncate(renderProgress({ ...current, text: visibleResponseText(current.text) }))
  return text === current.lastSent ? Option.none() : Option.some(text)
}

type SessionEvent = OpenCodeEvent

const isSessionEvent = (sessionID: string) => (event: OpenCodeEvent): event is SessionEvent => {
  let eventSessionID: string | undefined
  if (event.type === "form.created") eventSessionID = event.data.form.sessionID
  else if ("sessionID" in event.data) eventSessionID = event.data.sessionID
  return eventSessionID === sessionID
}

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

export const matchesSessionRoute = (
  route: { readonly chatId: number; readonly threadId?: number },
  chatId: number,
  threadId?: number,
): boolean => route.chatId === chatId && route.threadId === threadId

const isSourceRoute = (
  registry: PermissionRegistryService,
  sessionID: string,
  chatId: number,
  threadId: Option.Option<number>,
): Effect.Effect<boolean, InteractionStoreError> =>
  registry.getSessionRoute(sessionID).pipe(Effect.map(Option.exists((route) =>
    matchesSessionRoute(route, chatId, Option.getOrUndefined(threadId))
  )))

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

const surfaceQuestion = (
  request: PendingQuestionRequest,
  chatId: number,
  threadId: Option.Option<number>,
  questionRegistry: QuestionRegistryService,
): Effect.Effect<void, never, TelegramApi | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    // Event streams can reconnect and replay the same request. Register
    // atomically so a replay does not create a second Telegram prompt.
    const tokenOption = yield* questionRegistry.registerOrResume({
      sessionID: request.sessionID,
      requestID: request.id,
      chatId,
      questions: request.questions.map((question) => question.question),
      options: request.questions.map((question) => question.options.map((option) => option.label)),
      customs: request.questions.map((question) => question.custom ?? false),
      multiples: request.questions.map((question) => question.multiple ?? false),
    })
    if (Option.isNone(tokenOption)) return
    const token = tokenOption.value
    yield* Effect.forEach(request.questions.entries(), ([index, question]) =>
      Effect.gen(function* () {
        const claimed = yield* questionRegistry.claimDeliveryWithGeneration(token, index, chatId)
        if (Option.isNone(claimed)) return
        const message = yield* recordDefinitiveSendFailure(api.sendMessage({
          chatId,
          text: renderQuestion(question),
          messageThreadId: Option.getOrUndefined(threadId),
          replyMarkup: question.options.length === 0 ? undefined : questionKeyboard(token, index, question),
        }), questionRegistry.rejectDeliveryWithGeneration(token, index, chatId, claimed.value))
        yield* questionRegistry.attachMessageId(token, index, message.message_id, claimed.value)
      }),
    )
  }).pipe(Effect.catchCause(logTelegramFailure("question prompt failed")))

const handleEvent = (
  event: SessionEvent,
  chatId: number,
  threadId: Option.Option<number>,
  state: Ref.Ref<RunState>,
  terminal: Ref.Ref<Option.Option<RunOutcome>>,
  terminalHandled: Deferred.Deferred<void>,
  registry: PermissionRegistryService,
  questionRegistry: QuestionRegistryService,
): Effect.Effect<void, never, TelegramApi | HttpClient.HttpClient | OpenCode | FileSystem.FileSystem | Path.Path> => {
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
    case "session.tool.success": {
      return mediaFromToolContentEffect(event.data.content).pipe(
        Effect.flatMap((media) => {
          if (media.length === 0) return Ref.update(state, (current) => ({ ...current, activity: Option.none(), dirty: true }))
          return Ref.update(state, (current) => {
            const fresh = media.filter((item) => !current.mediaKeys.has(item.key))
            const accepted = limitMedia([...current.media, ...fresh])
            return {
              ...current,
              activity: Option.none(),
              dirty: true,
              media: accepted,
              mediaKeys: new Set(accepted.map((item) => item.key)),
            }
          })
        }),
      )
    }
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
        if (!(yield* isSourceRoute(registry, event.data.sessionID, chatId, threadId))) return
        const tokenOption = yield* registry.registerOrResume({
          sessionID: event.data.sessionID,
          requestID: event.data.id,
          chatId,
        })
        if (Option.isNone(tokenOption)) return
        const token = tokenOption.value
        const api = yield* TelegramApi
        const claimed = yield* registry.claimDeliveryWithGeneration(token, chatId)
        if (Option.isNone(claimed)) return
        const message = yield* recordDefinitiveSendFailure(api.sendMessage({
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
        }), registry.rejectDeliveryWithGeneration(token, chatId, claimed.value))
        yield* registry.attachMessageId(token, message.message_id, claimed.value)
      }).pipe(Effect.catchCause(logTelegramFailure("permission prompt failed")))
    }
    case "question.asked":
    case "form.created": {
      const request = questionRequestFromEvent(event)
      if (request === undefined) return Effect.void
      return registry.getSessionRoute(request.sessionID).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.void,
          onSome: (route) => matchesSessionRoute(route, chatId, Option.getOrUndefined(threadId))
            ? surfaceQuestion(request, chatId, threadId, questionRegistry)
            : Effect.void,
        })),
        Effect.catchCause(logTelegramFailure("read question session route failed")),
      )
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
    let progressMessageID = input.progressMessageID
    if (progressMessageID === undefined) {
      if (input.onProgressDispatching !== undefined) yield* input.onProgressDispatching()
      const status = yield* api.sendMessage({
          chatId: input.chatId,
          text: "Working…",
          messageThreadId: input.threadId,
        }).pipe(Effect.catchTag("ApiError", (error) =>
          isDefinitiveSendRejection(error) && input.onProgressRejected !== undefined
            ? input.onProgressRejected().pipe(Effect.andThen(Effect.fail(error)))
            : Effect.fail(error)))
      progressMessageID = status.message_id
      if (input.onProgressMessage !== undefined) yield* input.onProgressMessage(progressMessageID)
    }
    const state = yield* Ref.make<RunState>({
      messageId: progressMessageID,
      text: "",
      reasoning: "",
      activity: Option.none(),
      usage: Option.none(),
      lastSent: "Working…",
      dirty: false,
      media: [],
      mediaKeys: new Set(),
    })
    const acceptedInputID = yield* Ref.make(Option.fromNullishOr(input.inputID))

    const flusher = yield* Effect.forkChild(
      Effect.repeat(
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const nextText = nextProgressEdit(current)
          if (Option.isSome(nextText)) {
            const edited = yield* api.editMessageText({
              chatId: input.chatId,
              messageId: current.messageId,
              text: nextText.value,
            }).pipe(
              Effect.as(true),
              Effect.catchCause((cause) => logTelegramFailure("progress edit failed")(cause).pipe(Effect.as(false))),
            )
            if (edited) {
              yield* Ref.update(state, (next) => ({
                ...next,
                dirty: next.text !== current.text || next.reasoning !== current.reasoning || Option.getOrUndefined(next.activity) !== Option.getOrUndefined(current.activity),
                lastSent: nextText.value,
              }))
            }
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
      if (input.reconnect === true) {
        yield* registry.setSessionRoute(input.sessionID, { chatId: input.chatId, threadId: input.threadId })
        yield* questionRegistry.setSessionRoute(input.sessionID, { chatId: input.chatId, threadId: input.threadId })
      }
      if (input.reconnect !== true) {
        const idle = yield* waitUntilIdle("wait before prompt failed")
        if (!idle) return "error" as const
        yield* registry.setSessionRoute(input.sessionID, { chatId: input.chatId, threadId: input.threadId })
        yield* questionRegistry.setSessionRoute(input.sessionID, { chatId: input.chatId, threadId: input.threadId })
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
      if (input.reconnect !== true) {
        if (input.onDispatching !== undefined) yield* input.onDispatching()
        const pending = yield* opencode.prompt({
           sessionID: input.sessionID,
          text: input.text ?? "",
          files: attachments,
        })
        yield* Ref.set(acceptedInputID, Option.some(pending.id))
        if (input.onAccepted !== undefined) yield* input.onAccepted(pending.id)
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
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
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
              Effect.andThen(Effect.failCause(cause)),
            )
      }),
    )

    yield* Fiber.interrupt(flusher)
    const finalState = yield* Ref.get(state)
    const usageLine = Option.match(finalState.usage, {
      onNone: () => "",
      onSome: (usage) => `\n\n${renderUsage(usage)}`,
    })
    const inputID = yield* Ref.get(acceptedInputID)
    const canonicalResponse = outcome === "done" && Option.isSome(inputID)
      ? yield* recoveredResponseFromHistory(input.sessionID, inputID.value)
      : Option.none()
    const response = Option.isSome(canonicalResponse)
      ? canonicalResponse.value
      : yield* mediaFromResponseText(finalState.text)
    const finalMedia = limitMedia([...finalState.media, ...response.media])
    const finalText = truncate(renderFinal(response.text, outcome) + usageLine)
    const finalization: RunFinalization = { text: finalText, media: finalMedia }
    if (input.onFinalizing !== undefined) yield* input.onFinalizing(finalization)
    return finalization
  })
