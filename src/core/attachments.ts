import { Buffer } from "node:buffer"
import type { PromptInput } from "@opencode-ai/client/effect"

/** A validated, downloadable file attachment. */
export interface Attachment {
  readonly name: string
  readonly bytes: Uint8Array
  readonly mime: string
}

/**
 * Convert an attachment into the OpenCode prompt file shape.
 * The content travels as a `data:` URI, so the OpenCode server does not
 * need access to our filesystem.
 */
export const toFileAttachment = (attachment: Attachment): PromptInput.FileAttachment => ({
  uri: `data:${attachment.mime};base64,${Buffer.from(attachment.bytes).toString("base64")}`,
  name: attachment.name,
})
