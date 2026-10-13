import { Buffer } from "node:buffer"
import { Data, Effect, Option, Schema } from "effect"

/**
 * Encrypted share links: <base-url>/?m=<payload>
 *
 * The payload is a deflate-raw compressed markdown message, encrypted with
 * AES-256-GCM, prefixed with the random 12 byte IV, and encoded as unpadded
 * base64url. The shared key stays in the backend configuration and must never
 * appear in a URL, in browser code, or in a log.
 */

export const SHARE_VARIANTS = ["calm", "desk", "term", "memo", "card"] as const
export type ShareVariant = (typeof SHARE_VARIANTS)[number]
export const SHARE_DEFAULT_VARIANT: ShareVariant = "calm"

/** Server-side limits mirrored by the share service. */
export const SHARE_MAX_MARKDOWN_BYTES = 256 * 1024
export const SHARE_MAX_PAYLOAD_CHARS = 64 * 1024

const IV_BYTES = 12
const KEY_BYTES = 32

/** Media types the share service upload endpoint accepts. */
export const SHARE_MEDIA_MIMES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/ogg",
]

export const isShareMediaMime = (mime: string): boolean => SHARE_MEDIA_MIMES.includes(mime)

export class ShareLinkError extends Data.TaggedError("ShareLinkError")<{
  readonly operation: string
  readonly cause?: unknown
}> {}

const fail = (operation: string, cause?: unknown) => new ShareLinkError({ operation, cause })

/** Parse a 32 byte key from 64 hex chars or 43 base64url chars. */
export const parseSharedKey = (value: string): Option.Option<Uint8Array> => {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Option.some(new Uint8Array(Buffer.from(trimmed, "hex")))
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    const bytes = new Uint8Array(Buffer.from(trimmed, "base64url"))
    return bytes.byteLength === KEY_BYTES ? Option.some(bytes) : Option.none()
  }
  return Option.none()
}

const deflateRaw = (bytes: Uint8Array): Effect.Effect<Uint8Array, ShareLinkError> =>
  Effect.tryPromise({
    try: () =>
      new Response(new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw")))
        .arrayBuffer()
        .then((buffer) => new Uint8Array(buffer)),
    catch: (cause) => fail("compress", cause),
  })

const importAesKey = (raw: Uint8Array): Effect.Effect<CryptoKey, ShareLinkError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.importKey("raw", Uint8Array.from(raw), "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: (cause) => fail("key", cause),
  })

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength)
  output.set(left, 0)
  output.set(right, left.byteLength)
  return output
}

/** Compress, encrypt, and encode one markdown message. Never logs its input. */
export const encodeSharePayload = (input: {
  readonly markdown: string
  readonly key: Uint8Array
}): Effect.Effect<string, ShareLinkError> =>
  Effect.gen(function* () {
    if (input.key.byteLength !== KEY_BYTES) {
      return yield* Effect.fail(fail("encode", new Error("The message key must be 32 bytes.")))
    }
    const plain = new TextEncoder().encode(input.markdown)
    if (plain.byteLength > SHARE_MAX_MARKDOWN_BYTES) {
      return yield* Effect.fail(fail("encode", new Error("The message exceeds the share-link markdown limit.")))
    }
    const compressed = yield* deflateRaw(plain)
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = yield* importAesKey(input.key)
    const ciphertext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.encrypt({ name: "AES-GCM", iv: Uint8Array.from(iv) }, key, Uint8Array.from(compressed))
          .then((buffer) => new Uint8Array(buffer)),
      catch: (cause) => fail("encrypt", cause),
    })
    const payload = Buffer.from(concatBytes(iv, ciphertext)).toString("base64url")
    if (payload.length > SHARE_MAX_PAYLOAD_CHARS) {
      return yield* Effect.fail(fail("encode", new Error("The encoded message exceeds the share-link payload limit.")))
    }
    return payload
  })

/** Decode, decrypt, and decompress one payload. Used by tests and verification. */
export const decodeSharePayload = (input: {
  readonly payload: string
  readonly key: Uint8Array
}): Effect.Effect<string, ShareLinkError> =>
  Effect.gen(function* () {
    if (input.key.byteLength !== KEY_BYTES) {
      return yield* Effect.fail(fail("decode", new Error("The message key must be 32 bytes.")))
    }
    const packed = new Uint8Array(Buffer.from(input.payload, "base64url"))
    if (packed.byteLength < IV_BYTES + 16) {
      return yield* Effect.fail(fail("decode", new Error("The payload is too short.")))
    }
    const key = yield* importAesKey(input.key)
    const plain = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: Uint8Array.from(packed.subarray(0, IV_BYTES)) },
          key,
          Uint8Array.from(packed.subarray(IV_BYTES)),
        ).then((buffer) => new Uint8Array(buffer)),
      catch: (cause) => fail("decrypt", cause),
    })
    const decompressed = yield* Effect.tryPromise({
      try: () =>
        new Response(new Blob([Uint8Array.from(plain)]).stream().pipeThrough(new DecompressionStream("deflate-raw")))
          .arrayBuffer()
          .then((buffer) => new Uint8Array(buffer)),
      catch: (cause) => fail("decompress", cause),
    })
    return new TextDecoder().decode(decompressed)
  })

/** Build the public share URL. The variant defaults to calm. */
export const buildShareUrl = (input: {
  readonly payload: string
  readonly variant?: ShareVariant
  readonly baseUrl: string
}): string => {
  const url = new URL(input.baseUrl)
  url.searchParams.set("variant", input.variant ?? SHARE_DEFAULT_VARIANT)
  url.searchParams.set("m", input.payload)
  return url.toString()
}

const UploadResponse = Schema.Struct({
  uploadUrl: Schema.String,
  objectUrl: Schema.String,
})

/**
 * Upload one local file and return its public object URL. The caller is
 * responsible for the overall time budget; the object is deleted by the service after
 * 24 hours.
 */
export const uploadShareMedia = (input: {
  readonly baseUrl: string
  readonly token: string
  readonly bytes: Uint8Array
  readonly mime: string
}): Effect.Effect<string, ShareLinkError> =>
  Effect.gen(function* () {
    const presign = new URL("/api/upload", input.baseUrl)
    presign.searchParams.set("type", input.mime)
    presign.searchParams.set("size", String(input.bytes.byteLength))
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(presign, {
          method: "POST",
          headers: { authorization: `Bearer ${input.token}` },
        }),
      catch: (cause) => fail("upload.presign", cause),
    })
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => fail("upload.presign", cause),
    })
    if (!response.ok) {
      return yield* Effect.fail(fail("upload.presign", new Error(`Share upload presign failed with ${response.status}`)))
    }
    const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(UploadResponse)(
      yield* Effect.try({
        try: () => JSON.parse(body),
        catch: (cause) => fail("upload.presign", cause),
      }),
    ))
    if (parsed === undefined) {
      return yield* Effect.fail(fail("upload.presign", new Error("The upload response is invalid.")))
    }
    const uploaded = yield* Effect.tryPromise({
      try: () =>
        fetch(parsed.uploadUrl, {
          method: "PUT",
          headers: { "content-type": input.mime },
          body: Uint8Array.from(input.bytes),
        }),
      catch: (cause) => fail("upload.put", cause),
    })
    if (!uploaded.ok) {
      return yield* Effect.fail(fail("upload.put", new Error(`The media upload failed with ${uploaded.status}`)))
    }
    return parsed.objectUrl
  })
