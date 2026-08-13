import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Sessions } from "../src/core/sessions.js"
import { TelegramApi } from "../src/telegram/api.js"
import { setProjectDirectory } from "../src/telegram/handlers/run.js"

describe("project directory confirmation", () => {
  test("can persist without sending a second confirmation", async () => {
    const messages: string[] = []
    const sessions = Layer.succeed(Sessions, {
      getOrCreate: () => Effect.succeed("session"),
      reset: () => Effect.void,
      directoryFor: () => Effect.succeed("/old"),
      setDirectory: () => Effect.succeed(undefined),
    })
    const telegram = Layer.succeed(TelegramApi, {
      sendMessage: (input) => Effect.sync(() => {
        messages.push(input.text)
        return { message_id: 1, chat: { id: input.chatId } }
      }),
      getUpdates: () => Effect.never,
      sendPhoto: () => Effect.never,
      sendVideo: () => Effect.never,
      sendDocument: () => Effect.never,
      editMessageText: () => Effect.never,
      answerCallbackQuery: () => Effect.succeed(true),
      getFile: () => Effect.never,
      downloadFile: () => Effect.never,
    })

    const updated = await Effect.runPromise(
      setProjectDirectory(7, "/new", 42, false).pipe(
        Effect.provide(sessions),
        Effect.provide(telegram),
        Effect.provide(FetchHttpClient.layer),
      ),
    )

    expect(updated).toBe(true)
    expect(messages).toEqual([])
  })
})
