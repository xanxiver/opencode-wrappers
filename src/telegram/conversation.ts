import { Option, Schema } from "effect"
import { TELEGRAM_CONTROLLER_BOT_KEY } from "../config.js"
import type { Message } from "./api.js"

/** Identity of one Telegram chat or forum topic. */
export interface TelegramConversation {
  readonly chatId: number
  readonly threadId?: number
}

/** Complete ownership coordinates for one Telegram outbound message. */
export const TelegramDeliveryRouteSchema = Schema.Struct({
  botKey: Schema.NonEmptyString,
  chatId: Schema.Number,
  threadId: Schema.optional(Schema.Number),
})

export type TelegramDeliveryRoute = Schema.Schema.Type<typeof TelegramDeliveryRouteSchema>

/** Controller-owned request context resolved once at Telegram ingress. */
export interface TelegramRequestContext extends TelegramConversation {
  readonly conversationId: string
  readonly controllerRoute: TelegramDeliveryRoute
}

/** Keep the old private-chat key format and add an explicit topic suffix. */
export const conversationId = ({ chatId, threadId }: TelegramConversation): string =>
  threadId === undefined ? `tg:${chatId}` : `tg:${chatId}:thread:${threadId}`

export const deliveryRoute = (
  botKey: string,
  { chatId, threadId }: TelegramConversation,
): TelegramDeliveryRoute => threadId === undefined
  ? { botKey, chatId }
  : { botKey, chatId, threadId }

export const controllerRoute = (conversation: TelegramConversation): TelegramDeliveryRoute =>
  deliveryRoute(TELEGRAM_CONTROLLER_BOT_KEY, conversation)

export const requestContext = (conversation: TelegramConversation): TelegramRequestContext => ({
  ...conversation,
  conversationId: conversationId(conversation),
  controllerRoute: controllerRoute(conversation),
})

/** Extract the chat id from a persisted conversation identity. */
export const chatIdFromConversation = (value: string): Option.Option<number> => {
  const match = /^tg:(-?\d+)(?::thread:-?\d+)?$/.exec(value)
  if (match === null) return Option.none()
  const chatId = Number(match[1])
  return Number.isSafeInteger(chatId) ? Option.some(chatId) : Option.none()
}

export const isGroupConversation = (value: string): boolean =>
  Option.exists(chatIdFromConversation(value), (chatId) => chatId < 0)

export const conversationFromMessage = (message: Message): TelegramConversation => ({
  chatId: message.chat.id,
  threadId: message.message_thread_id,
})
