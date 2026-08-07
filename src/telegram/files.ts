import { Data, Effect, Option, Result } from "effect"
import type { Attachment } from "../core/attachments.js"
import { TelegramApi, type Message } from "./api.js"

export const ALLOWED_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "csv",
  "xlsx",
  "docx",
  "md",
  "mdx",
] as const

export type DetectedKind = "pdf" | "png" | "jpg" | "gif" | "webp" | "zip" | "text"

export class FileValidationError extends Data.TaggedError("FileValidationError")<{
  readonly message: string
}> {}

/** Extract the lowercase extension from a file name. Dotfiles have no extension. */
export const extensionOf = (name: string): Option.Option<string> => {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return Option.none()
  return Option.some(base.slice(dot + 1).toLowerCase())
}

const isText = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Detect the real content type from magic bytes. */
export const detectKind = (bytes: Uint8Array): Option.Option<DetectedKind> => {
  if (bytes.length === 0) return Option.none()
  const startsWith = (prefix: readonly number[]): boolean =>
    prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte)
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return Option.some("pdf") // %PDF
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return Option.some("png")
  if (startsWith([0xff, 0xd8, 0xff])) return Option.some("jpg")
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return Option.some("gif") // GIF8
  if (
    bytes.length >= 12 &&
    startsWith([0x52, 0x49, 0x46, 0x46]) && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return Option.some("webp")
  }
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return Option.some("zip") // PK\x03\x04
  if (isText(bytes)) return Option.some("text")
  return Option.none()
}

/** Which detected kind is expected for a given extension. */
export const kindForExtension = (extension: string): Option.Option<DetectedKind> => {
  switch (extension) {
    case "pdf":
      return Option.some("pdf")
    case "png":
      return Option.some("png")
    case "jpg":
    case "jpeg":
      return Option.some("jpg")
    case "gif":
      return Option.some("gif")
    case "webp":
      return Option.some("webp")
    case "xlsx":
    case "docx":
      return Option.some("zip")
    case "csv":
    case "md":
    case "mdx":
      return Option.some("text")
    default:
      return Option.none()
  }
}

export const mimeForExtension = (extension: string): Option.Option<string> => {
  switch (extension) {
    case "pdf":
      return Option.some("application/pdf")
    case "png":
      return Option.some("image/png")
    case "jpg":
    case "jpeg":
      return Option.some("image/jpeg")
    case "gif":
      return Option.some("image/gif")
    case "webp":
      return Option.some("image/webp")
    case "csv":
      return Option.some("text/csv")
    case "xlsx":
      return Option.some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    case "docx":
      return Option.some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    case "md":
    case "mdx":
      return Option.some("text/markdown")
    default:
      return Option.none()
  }
}

const extensionForMime = (mime: string): Option.Option<string> => {
  switch (mime) {
    case "application/pdf":
      return Option.some("pdf")
    case "image/png":
      return Option.some("png")
    case "image/jpeg":
      return Option.some("jpg")
    case "image/gif":
      return Option.some("gif")
    case "image/webp":
      return Option.some("webp")
    case "text/csv":
      return Option.some("csv")
    case "text/markdown":
      return Option.some("md")
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return Option.some("xlsx")
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return Option.some("docx")
    default:
      return Option.none()
  }
}

/** Validate extension + magic bytes; produce the typed attachment. */
export const validateAttachment = (
  name: string,
  bytes: Uint8Array,
): Result.Result<Attachment, FileValidationError> =>
  Result.gen(function* () {
    const extension = yield* Result.fromOption(() =>
      new FileValidationError({ message: `file "${name}" has no extension` }),
    )(extensionOf(name))
    const expected = yield* Result.fromOption(() =>
      new FileValidationError({
        message: `file "${name}": extension ".${extension}" is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
      }),
    )(kindForExtension(extension))
    const detected = yield* Result.fromOption(() =>
      new FileValidationError({ message: `file "${name}": content is not a recognized file type` }),
    )(detectKind(bytes))
    if (detected !== expected) {
      return yield* Result.fail(
        new FileValidationError({ message: `file "${name}": content does not match extension ".${extension}"` }),
      )
    }
    const mime = yield* Result.fromOption(() =>
      new FileValidationError({ message: `file "${name}": no mime type known` }),
    )(mimeForExtension(extension))
    return { name, bytes, mime }
  })

const PHOTO_KINDS: readonly DetectedKind[] = ["png", "jpg", "gif", "webp"]

/** Validate a Telegram photo (no file name; type comes from content). */
export const validatePhoto = (bytes: Uint8Array): Result.Result<Attachment, FileValidationError> =>
  Result.gen(function* () {
    const detected = yield* Result.fromOption(() =>
      new FileValidationError({ message: "photo is not a supported image. Allowed: png, jpg, gif, webp" }),
    )(detectKind(bytes))
    if (!PHOTO_KINDS.includes(detected)) {
      return yield* Result.fail(
        new FileValidationError({ message: "photo is not a supported image. Allowed: png, jpg, gif, webp" }),
      )
    }
    const mime = yield* Result.fromOption(() =>
      new FileValidationError({ message: "photo: no mime type known" }),
    )(mimeForExtension(detected))
    return { name: `photo.${detected}`, bytes, mime }
  })

interface FileRef {
  readonly fileId: string
  readonly name: Option.Option<string>
  readonly mimeType: Option.Option<string>
  readonly isPhoto: boolean
}

/** Collect file references from a message and its replied-to message. */
export const collectRefs = (message: Message): readonly FileRef[] => {
  const refs: FileRef[] = []
  const pushDocument = (document: NonNullable<Message["document"]>) => {
    refs.push({
      fileId: document.file_id,
      name: Option.fromNullishOr(document.file_name),
      mimeType: Option.fromNullishOr(document.mime_type),
      isPhoto: false,
    })
  }
  const pushPhoto = (photo: NonNullable<Message["photo"]>) => {
    if (photo.length > 0) {
      refs.push({
        fileId: photo[photo.length - 1].file_id,
        name: Option.none(),
        mimeType: Option.none(),
        isPhoto: true,
      })
    }
  }
  if (message.document !== undefined) pushDocument(message.document)
  if (message.photo !== undefined) pushPhoto(message.photo)
  const replied = message.reply_to_message
  if (replied !== undefined) {
    if (replied.document !== undefined) pushDocument(replied.document)
    if (replied.photo !== undefined) pushPhoto(replied.photo)
  }
  return refs
}

const dedupe = (refs: readonly FileRef[]): readonly FileRef[] => {
  const seen = new Set<string>()
  const result: FileRef[] = []
  for (const ref of refs) {
    if (!seen.has(ref.fileId)) {
      seen.add(ref.fileId)
      result.push(ref)
    }
  }
  return result
}

/** Resolve a document's name: explicit name, else a name derived from mime. */
const nameForRef = (ref: FileRef): Result.Result<string, FileValidationError> =>
  Option.match(ref.name, {
    onNone: () =>
      Option.match(ref.mimeType, {
        onNone: () =>
          Result.fail(new FileValidationError({ message: "file has no name and its type cannot be determined" })),
        onSome: (mime) =>
          Option.match(extensionForMime(mime), {
            onNone: () =>
              Result.fail(new FileValidationError({ message: "file has no name and its type cannot be determined" })),
            onSome: (extension) => Result.succeed(`attachment.${extension}`),
          }),
      }),
    onSome: (name) => Result.succeed(name),
  })

const downloadAndValidate = (ref: FileRef) =>
  Effect.gen(function* () {
    const api = yield* TelegramApi
    const info = yield* api.getFile(ref.fileId).pipe(
      Effect.mapError(
        (cause) =>
          new FileValidationError({
            message: `failed to get file info: ${cause.description ?? cause.operation}`,
          }),
      ),
    )
    if (info.file_path === undefined) {
      return yield* Effect.fail(new FileValidationError({ message: "telegram did not return a file path" }))
    }
    const bytes = yield* api.downloadFile(info.file_path).pipe(
      Effect.mapError(() => new FileValidationError({ message: "failed to download file" })),
    )
    const validated = ref.isPhoto
      ? validatePhoto(bytes)
      : Result.match(nameForRef(ref), {
        onSuccess: (name) => validateAttachment(name, bytes),
        onFailure: (error) => Result.fail(error),
      })
    return yield* Result.match(validated, {
      onSuccess: (attachment) => Effect.succeed(attachment),
      onFailure: (error) => Effect.fail(error),
    })
  })

/**
 * Download and validate all attachments of a message (own + replied-to).
 * Fails with a user-readable message when any file is rejected.
 */
export const collectAttachments = (message: Message) => {
  const refs = dedupe(collectRefs(message))
  return Effect.forEach(refs, (ref) => downloadAndValidate(ref), { concurrency: 4 })
}
