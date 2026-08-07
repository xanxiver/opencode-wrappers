import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Result } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { TelegramApi, type Message } from "../src/telegram/api.js"
import {
  collectAttachments,
  collectRefs,
  detectKind,
  extensionOf,
  kindForExtension,
  mimeForExtension,
  validateAttachment,
  validatePhoto,
} from "../src/telegram/files.js"

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

const PDF = text("%PDF-1.7\n1 0 obj\n")
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d)
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const GIF = text("GIF89a....")
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00)
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x00)
const CSV = text("name,age\nalice,30\n")
const MD = text("# Title\n\nbody text\n")

describe("extensionOf", () => {
  test("extracts lowercase extension", () => {
    expect(extensionOf("report.PDF")).toEqual(Option.some("pdf"))
    expect(extensionOf("a.b.c.md")).toEqual(Option.some("md"))
    expect(extensionOf("dir/file.TXT")).toEqual(Option.some("txt"))
  })

  test("returns none for files without extension", () => {
    expect(extensionOf("noext")).toEqual(Option.none())
    expect(extensionOf(".gitignore")).toEqual(Option.none())
    expect(extensionOf("")).toEqual(Option.none())
  })
})

describe("kindForExtension", () => {
  test("maps allowed extensions", () => {
    expect(kindForExtension("pdf")).toEqual(Option.some("pdf"))
    expect(kindForExtension("png")).toEqual(Option.some("png"))
    expect(kindForExtension("jpg")).toEqual(Option.some("jpg"))
    expect(kindForExtension("jpeg")).toEqual(Option.some("jpg"))
    expect(kindForExtension("gif")).toEqual(Option.some("gif"))
    expect(kindForExtension("webp")).toEqual(Option.some("webp"))
    expect(kindForExtension("xlsx")).toEqual(Option.some("zip"))
    expect(kindForExtension("docx")).toEqual(Option.some("zip"))
    expect(kindForExtension("csv")).toEqual(Option.some("text"))
    expect(kindForExtension("md")).toEqual(Option.some("text"))
    expect(kindForExtension("mdx")).toEqual(Option.some("text"))
  })

  test("rejects unknown extensions", () => {
    expect(kindForExtension("exe")).toEqual(Option.none())
    expect(kindForExtension("")).toEqual(Option.none())
  })
})

describe("mimeForExtension", () => {
  test("maps allowed extensions to mime types", () => {
    expect(mimeForExtension("pdf")).toEqual(Option.some("application/pdf"))
    expect(mimeForExtension("png")).toEqual(Option.some("image/png"))
    expect(mimeForExtension("jpg")).toEqual(Option.some("image/jpeg"))
    expect(mimeForExtension("jpeg")).toEqual(Option.some("image/jpeg"))
    expect(mimeForExtension("gif")).toEqual(Option.some("image/gif"))
    expect(mimeForExtension("webp")).toEqual(Option.some("image/webp"))
    expect(mimeForExtension("csv")).toEqual(Option.some("text/csv"))
    expect(mimeForExtension("xlsx")).toEqual(Option.some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
    expect(mimeForExtension("docx")).toEqual(Option.some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
    expect(mimeForExtension("md")).toEqual(Option.some("text/markdown"))
    expect(mimeForExtension("mdx")).toEqual(Option.some("text/markdown"))
    expect(mimeForExtension("exe")).toEqual(Option.none())
  })
})

describe("detectKind", () => {
  test("detects binary formats by magic bytes", () => {
    expect(detectKind(PDF)).toEqual(Option.some("pdf"))
    expect(detectKind(PNG)).toEqual(Option.some("png"))
    expect(detectKind(JPG)).toEqual(Option.some("jpg"))
    expect(detectKind(GIF)).toEqual(Option.some("gif"))
    expect(detectKind(WEBP)).toEqual(Option.some("webp"))
    expect(detectKind(ZIP)).toEqual(Option.some("zip"))
  })

  test("detects text content", () => {
    expect(detectKind(CSV)).toEqual(Option.some("text"))
    expect(detectKind(MD)).toEqual(Option.some("text"))
  })

  test("returns none for empty or binary content", () => {
    expect(detectKind(new Uint8Array())).toEqual(Option.none())
    expect(detectKind(bytes(0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00))).toEqual(Option.none()) // MZ + NUL
    expect(detectKind(bytes(0x00, 0x01, 0x02))).toEqual(Option.none()) // NUL byte
  })
})

describe("validateAttachment", () => {
  test("accepts files whose content matches the extension", () => {
    const pdf = validateAttachment("doc.pdf", PDF)
    expect(Result.isSuccess(pdf)).toBe(true)
    expect(Result.match(pdf, {
      onSuccess: (value) => value.mime,
      onFailure: () => "",
    })).toBe("application/pdf")

    expect(Result.isSuccess(validateAttachment("book.xlsx", ZIP))).toBe(true)
    expect(Result.isSuccess(validateAttachment("notes.docx", ZIP))).toBe(true)
    expect(Result.isSuccess(validateAttachment("README.md", MD))).toBe(true)
    expect(Result.isSuccess(validateAttachment("data.CSV", CSV))).toBe(true)
    expect(Result.isSuccess(validateAttachment("photo.jpeg", JPG))).toBe(true)
  })

  test("rejects files without extension", () => {
    expect(Result.isFailure(validateAttachment("noextension", PDF))).toBe(true)
  })

  test("rejects disallowed extensions", () => {
    const result = validateAttachment("virus.exe", PDF)
    expect(Result.isFailure(result)).toBe(true)
    expect(Result.match(result, {
      onSuccess: () => "",
      onFailure: (error) => error.message,
    })).toContain("not allowed")
  })

  test("rejects content that does not match the extension", () => {
    const result = validateAttachment("fake.pdf", PNG)
    expect(Result.isFailure(result)).toBe(true)
    expect(Result.match(result, {
      onSuccess: () => "",
      onFailure: (error) => error.message,
    })).toContain("does not match")
  })

  test("rejects unrecognized content", () => {
    expect(Result.isFailure(validateAttachment("readme.md", bytes(0x00, 0xff, 0xfe, 0x00, 0x01)))).toBe(true)
  })

  test("rejects empty files", () => {
    expect(Result.isFailure(validateAttachment("empty.pdf", new Uint8Array()))).toBe(true)
  })

  test("rejects text masquerading as image", () => {
    expect(Result.isFailure(validateAttachment("image.png", text("just text, not an image")))).toBe(true)
  })
})

describe("validatePhoto", () => {
  test("accepts png/jpg/gif/webp content", () => {
    const png = validatePhoto(PNG)
    expect(Result.isSuccess(png)).toBe(true)
    expect(Result.match(png, {
      onSuccess: (value) => value.name,
      onFailure: () => "",
    })).toBe("photo.png")
    expect(Result.isSuccess(validatePhoto(JPG))).toBe(true)
    expect(Result.isSuccess(validatePhoto(GIF))).toBe(true)
    expect(Result.isSuccess(validatePhoto(WEBP))).toBe(true)
  })

  test("rejects non-image content", () => {
    expect(Result.isFailure(validatePhoto(PDF))).toBe(true)
    expect(Result.isFailure(validatePhoto(MD))).toBe(true)
    expect(Result.isFailure(validatePhoto(ZIP))).toBe(true)
    expect(Result.isFailure(validatePhoto(new Uint8Array()))).toBe(true)
  })
})

describe("collectRefs", () => {
  const docMessage: Message = {
    message_id: 1,
    chat: { id: 42 },
    document: { file_id: "doc1", file_name: "report.pdf" },
  }

  const photoMessage: Message = {
    message_id: 2,
    chat: { id: 42 },
    photo: [
      { file_id: "small", width: 100, height: 100 },
      { file_id: "large", width: 800, height: 800 },
    ],
  }

  test("collects a document", () => {
    const refs = collectRefs(docMessage)
    expect(refs.length).toBe(1)
    expect(refs[0].fileId).toBe("doc1")
    expect(refs[0].name).toEqual(Option.some("report.pdf"))
    expect(refs[0].isPhoto).toBe(false)
  })

  test("collects the largest photo", () => {
    const refs = collectRefs(photoMessage)
    expect(refs.length).toBe(1)
    expect(refs[0].fileId).toBe("large")
    expect(refs[0].isPhoto).toBe(true)
  })

  test("collects attachments from the replied-to message", () => {
    const reply: Message = {
      message_id: 3,
      chat: { id: 42 },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42 },
        document: { file_id: "doc1", file_name: "report.pdf" },
      },
    }
    const refs = collectRefs(reply)
    expect(refs.length).toBe(1)
    expect(refs[0].fileId).toBe("doc1")
  })

  test("collects own and replied attachments", () => {
    const both: Message = {
      message_id: 4,
      chat: { id: 42 },
      document: { file_id: "own", file_name: "a.csv" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42 },
        document: { file_id: "replied", file_name: "b.csv" },
      },
    }
    const refs = collectRefs(both)
    expect(refs.map((ref) => ref.fileId)).toEqual(["own", "replied"])
  })

  test("collectRefs keeps duplicate file ids", () => {
    const same: Message = {
      message_id: 5,
      chat: { id: 42 },
      document: { file_id: "dup", file_name: "a.csv" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42 },
        document: { file_id: "dup", file_name: "a.csv" },
      },
    }
    expect(collectRefs(same).length).toBe(2)
  })
})

describe("collectAttachments", () => {
  const fakeFiles: Record<string, Uint8Array> = {
    "files/doc1.bin": PDF,
    "files/photo.bin": PNG,
    "files/fake.bin": text("not really a pdf"),
    "files/dup.bin": CSV,
  }

  const fakeApi = Layer.succeed(TelegramApi, {
    getUpdates: () => Effect.never,
    sendMessage: () => Effect.never,
    editMessageText: () => Effect.never,
    answerCallbackQuery: () => Effect.never,
    getFile: (fileId: string) =>
      Effect.succeed({
        file_id: fileId,
        file_path: `files/${fileId}.bin`,
      }),
    downloadFile: (filePath: string) =>
      Effect.succeed(fakeFiles[filePath] ?? new Uint8Array()),
  })

  const run = (message: Message) =>
    collectAttachments(message).pipe(
      Effect.provide(fakeApi),
      Effect.provide(FetchHttpClient.layer),
    )

  test("downloads and validates a document", async () => {
    const message: Message = {
      message_id: 1,
      chat: { id: 42 },
      document: { file_id: "doc1", file_name: "report.pdf" },
    }
    const attachments = await Effect.runPromise(run(message))
    expect(attachments.length).toBe(1)
    expect(attachments[0].name).toBe("report.pdf")
    expect(attachments[0].mime).toBe("application/pdf")
  })

  test("downloads and validates a photo, deriving the name", async () => {
    const message: Message = {
      message_id: 2,
      chat: { id: 42 },
      photo: [{ file_id: "photo", width: 100, height: 100 }],
    }
    const attachments = await Effect.runPromise(run(message))
    expect(attachments.length).toBe(1)
    expect(attachments[0].name).toBe("photo.png")
  })

  test("fails with a user-readable error on invalid content", async () => {
    const message: Message = {
      message_id: 3,
      chat: { id: 42 },
      document: { file_id: "fake", file_name: "fake.pdf" },
    }
    await expect(Effect.runPromise(run(message))).rejects.toThrow(/does not match/)
  })

  test("downloads a duplicate file id only once", async () => {
    const message: Message = {
      message_id: 5,
      chat: { id: 42 },
      document: { file_id: "dup", file_name: "a.csv" },
      reply_to_message: {
        message_id: 1,
        chat: { id: 42 },
        document: { file_id: "dup", file_name: "a.csv" },
      },
    }
    const attachments = await Effect.runPromise(run(message))
    expect(attachments.length).toBe(1)
    expect(attachments[0].name).toBe("a.csv")
  })
})
