import type { Message } from "./api.js"

/** Identity of one Telegram chat or forum topic. */
export interface TelegramConversation {
  readonly chatId: number
  readonly threadId?: number
}

/** Keep the old private-chat key format and add an explicit topic suffix. */
export const conversationId = ({ chatId, threadId }: TelegramConversation): string =>
  threadId === undefined ? `tg:${chatId}` : `tg:${chatId}:thread:${threadId}`

export const conversationFromMessage = (message: Message): TelegramConversation => ({
  chatId: message.chat.id,
  threadId: message.message_thread_id,
})
