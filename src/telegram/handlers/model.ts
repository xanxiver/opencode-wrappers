import { Effect, Option } from "effect"
import type { Model } from "@opencode-ai/client/effect"
import { logBoundary } from "../../core/logging.js"
import { OpenCode } from "../../core/opencode.js"
import { Sessions } from "../../core/sessions.js"
import { Store } from "../../core/store.js"
import { ModelRegistry, type ModelEntry } from "../models.js"
import {
  MODEL_PAGE_SIZE,
  modelPageKeyboard,
  modelProviderKeyboard,
  parseModelCancelCallback,
  parseModelCallback,
  parseModelPageCallback,
  parseModelProviderCallback,
  parseModelVariantCallback,
  renderModelPageHeader,
} from "../render.js"
import type { CallbackQuery } from "../api.js"
import { answer, apiEdit, callbackFailure, chunk, sendMarkup, sendText } from "./shared.js"
import { conversationId } from "../conversation.js"

const logModelSelection = (
  stage: string,
  details: Readonly<Record<string, string | number | boolean | undefined>> = {},
) => Effect.logInfo("model selection event").pipe(
  Effect.annotateLogs({
    component: "telegram/handlers",
    boundary: "model-selection",
    stage,
    ...details,
  }),
)

/** Remember the chosen model for the chat's directory. */
const rememberModel = (directory: string, model: { readonly id: string; readonly providerID: string; readonly variant?: string }) =>
  Effect.gen(function* () {
    const store = yield* Store
    yield* store.setModel(directory, model).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "sessions", "remember model failed")(cause),
      ),
    )
  })

const modelPickerIsCurrent = (entry: ModelEntry) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const store = yield* Store
    const conversation = conversationId({
      chatId: entry.chatId,
      threadId: entry.threadId,
    })
    const currentDirectory = yield* sessions.directoryFor(conversation)
    if (currentDirectory !== entry.directory) return false
    const currentSession = yield* store.getSessionIDForConversation(conversation)
    return Option.exists(currentSession, (sessionID) => sessionID === entry.sessionID)
  })

export const handleModelCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseModelCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        yield* logModelSelection("model-callback-received", { index: parsed.index })
        const registry = yield* ModelRegistry
        const opencode = yield* OpenCode
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => logModelSelection("registry-entry-missing", { action: "model" }).pipe(
            Effect.andThen(answer(query.id, "Expired.")),
          ),
          onSome: (value) => Effect.gen(function* () {
            yield* logModelSelection("registry-entry-accepted", { action: "model", kind: value.kind })
            if (!(yield* modelPickerIsCurrent(value))) {
              yield* logModelSelection("picker-not-current", { action: "model" })
              yield* answer(query.id, "This model picker is no longer current.")
              return
            }
            switch (value.kind) {
              case "provider":
                return yield* answer(query.id, "Choose a model first.")
              case "variant":
                return yield* answer(query.id, "Invalid entry.")
              case "page": {
                const model = Option.fromNullishOr(value.models[parsed.index])
                return yield* Option.match(model, {
                  onNone: () => answer(query.id, "Invalid model."),
                  onSome: (selected) =>
                    Option.match(
                      Option.fromNullishOr(selected.variants.length === 0 ? undefined : selected.variants),
                      {
                        onNone: () =>
                          logModelSelection("model-switch-requested", {
                            model: selected.id,
                            provider: selected.providerID,
                          }).pipe(
                            Effect.andThen(opencode.switchModel({
                              sessionID: value.sessionID,
                              model: { id: selected.id, providerID: selected.providerID },
                            })),
                             Effect.andThen(rememberModel(value.directory, selected)),
                            Effect.tap(() => logModelSelection("model-switched", {
                              model: selected.id,
                              provider: selected.providerID,
                            })),
                            Effect.andThen(apiEdit(value.chatId, value.messageId, `Model switched to ${selected.id}`)),
                            Effect.andThen(answer(query.id, "Switched.")),
                          ),
                        onSome: (variants) =>
                          Effect.gen(function* () {
                            yield* logModelSelection("variant-picker-opened", {
                              model: selected.id,
                              provider: selected.providerID,
                              variants: variants.length,
                            })
                            const variantToken = yield* registry.registerVariant({
                              sessionID: value.sessionID,
                              providerID: selected.providerID,
                              modelID: selected.id,
                              variants,
                              directory: value.directory,
                              chatId: value.chatId,
                              threadId: value.threadId,
                              messageId: value.messageId,
                            })
                            const rows = chunk(
                              variants.map((variant, index) => ({
                                text: variant,
                                callback_data: `modelv:${variantToken}:${index}`,
                              })),
                              2,
                            ).map((row) => [...row])
                            rows.push([{ text: "Cancel", callback_data: `modelc:${variantToken}` }])
                            yield* apiEdit(
                              value.chatId,
                              value.messageId,
                              `Select a variant for ${selected.id}:`,
                              { inline_keyboard: rows },
                            )
                            yield* answer(query.id, "Choose a variant.")
                          }),
                      }
                    ),
                })
              }
            }
          }),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "model callback failed", "Failed.")),
      ),
  })

/** Page navigation of the model picker. */
export const handleModelPageCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseModelPageCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        yield* logModelSelection("page-callback-received", { page: parsed.page })
        const registry = yield* ModelRegistry
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => logModelSelection("registry-entry-missing", { action: "page" }).pipe(
            Effect.andThen(answer(query.id, "Expired.")),
          ),
          onSome: (value) => Effect.gen(function* () {
            yield* logModelSelection("registry-entry-accepted", { action: "page", kind: value.kind })
            if (!(yield* modelPickerIsCurrent(value))) {
              yield* logModelSelection("picker-not-current", { action: "page" })
              yield* answer(query.id, "This model picker is no longer current.")
              return
            }
            switch (value.kind) {
              case "provider":
                return yield* answer(query.id, "Choose a model first.")
              case "variant":
                return yield* answer(query.id, "Invalid entry.")
              case "page": {
                if (parsed.page < 0 || parsed.page * MODEL_PAGE_SIZE >= value.total) {
                  return yield* answer(query.id, "Invalid page.")
                }
                return yield* Effect.gen(function* () {
                  const nextToken = yield* registry.registerPage({
                    sessionID: value.sessionID,
                    models: value.models,
                    directory: value.directory,
                    page: parsed.page,
                    total: value.total,
                    chatId: value.chatId,
                    threadId: value.threadId,
                  })
                  const from = parsed.page * MODEL_PAGE_SIZE
                  const pageModels = value.models.slice(from, from + MODEL_PAGE_SIZE)
                  yield* registry.attachMessageId(nextToken, value.messageId)
                  yield* apiEdit(
                    value.chatId,
                    value.messageId,
                    renderModelPageHeader(parsed.page, value.total),
                    modelPageKeyboard(nextToken, pageModels, parsed.page, value.total),
                  )
                  yield* answer(query.id, "Page changed.")
                }).pipe(Effect.catchCause(callbackFailure(query, "model page callback failed", "Failed.")))
              }
            }
          }),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "model page callback failed", "Failed.")),
      ),
  })

/** Select a provider, the second step of the model picker. */
export const handleModelProviderCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseModelProviderCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        yield* logModelSelection("provider-callback-received", { index: parsed.index })
        const registry = yield* ModelRegistry
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => logModelSelection("registry-entry-missing", { action: "provider" }).pipe(
            Effect.andThen(answer(query.id, "Expired.")),
          ),
          onSome: (value) => Effect.gen(function* () {
            yield* logModelSelection("registry-entry-accepted", { action: "provider", kind: value.kind })
            if (!(yield* modelPickerIsCurrent(value))) {
              yield* logModelSelection("picker-not-current", { action: "provider" })
              yield* answer(query.id, "This model picker is no longer current.")
              return
            }
            if (value.kind !== "provider") return yield* answer(query.id, "Invalid entry.")
            const provider = Option.fromNullishOr(value.providers[parsed.index])
            return yield* Option.match(provider, {
              onNone: () => answer(query.id, "Invalid provider."),
              onSome: (selected) => Effect.gen(function* () {
                yield* logModelSelection("provider-selected", {
                  provider: selected.id,
                  models: selected.models.length,
                })
                const token = yield* registry.registerPage({
                  sessionID: value.sessionID,
                  models: selected.models,
                  directory: value.directory,
                  page: 0,
                  total: selected.models.length,
                    chatId: value.chatId,
                    threadId: value.threadId,
                })
                yield* registry.attachMessageId(token, value.messageId)
                yield* apiEdit(
                  value.chatId,
                  value.messageId,
                  `Provider ${selected.id} — select a model:`,
                  modelPageKeyboard(token, selected.models.slice(0, MODEL_PAGE_SIZE), 0, selected.models.length),
                )
                yield* answer(query.id, "Choose a model.")
              }),
            })
          }),
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "model provider callback failed", "Failed."))),
  })

export const handleModelVariantCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseModelVariantCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (parsed) =>
      Effect.gen(function* () {
        yield* logModelSelection("variant-callback-received", { index: parsed.index })
        const registry = yield* ModelRegistry
        const opencode = yield* OpenCode
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.take(parsed.token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => logModelSelection("registry-entry-missing", { action: "variant" }).pipe(
            Effect.andThen(answer(query.id, "Expired.")),
          ),
          onSome: (value) => Effect.gen(function* () {
            yield* logModelSelection("registry-entry-accepted", { action: "variant", kind: value.kind })
            if (!(yield* modelPickerIsCurrent(value))) {
              yield* logModelSelection("picker-not-current", { action: "variant" })
              yield* answer(query.id, "This model picker is no longer current.")
              return
            }
            switch (value.kind) {
              case "provider":
                return yield* answer(query.id, "Choose a model first.")
              case "page":
                return yield* answer(query.id, "Invalid entry.")
              case "variant":
                return yield* Option.match(Option.fromNullishOr(value.variants[parsed.index]), {
                  onNone: () => answer(query.id, "Invalid variant."),
                  onSome: (variant) =>
                    logModelSelection("model-switch-requested", {
                      model: value.modelID,
                      provider: value.providerID,
                      variant,
                    }).pipe(
                      Effect.andThen(opencode.switchModel({
                        sessionID: value.sessionID,
                        model: {
                          id: value.modelID,
                          providerID: value.providerID,
                          variant,
                        },
                      })),
                      Effect.andThen(
                        rememberModel(value.directory, {
                          id: value.modelID,
                          providerID: value.providerID,
                          variant,
                        }),
                      ),
                      Effect.tap(() => logModelSelection("model-variant-switched", {
                        model: value.modelID,
                        provider: value.providerID,
                        variant,
                      })),
                      Effect.andThen(
                        apiEdit(value.chatId, value.messageId, `Model switched to ${value.modelID} (${variant})`),
                      ),
                      Effect.andThen(answer(query.id, "Switched.")),
                    ),
                })
            }
          }),
        })
      }).pipe(
        Effect.catchCause(callbackFailure(query, "model variant callback failed", "Failed.")),
      ),
  })

/** Cancel the model picker without changing the active model. */
export const handleModelCancelCallback = (query: CallbackQuery, data: string) =>
  Option.match(parseModelCancelCallback(data), {
    onNone: () => answer(query.id, "Invalid data."),
    onSome: (token) =>
      Effect.gen(function* () {
        yield* logModelSelection("cancel-callback-received")
        const registry = yield* ModelRegistry
        const message = query.message
        if (message === undefined) {
          yield* answer(query.id, "Invalid callback.")
          return
        }
        const entry = yield* registry.cancel(token, message.chat.id, message.message_id)
        yield* Option.match(entry, {
          onNone: () => answer(query.id, "Expired."),
          onSome: (value) =>
            apiEdit(value.chatId, value.messageId, "Model selection cancelled.").pipe(
              Effect.andThen(answer(query.id, "Cancelled.")),
            ),
        })
      }).pipe(Effect.catchCause(callbackFailure(query, "model cancel callback failed", "Failed."))),
  })

/** `/models [query]` — choose provider, model, then optional variant. */
export const showModels = (chatId: number, query = "", threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const store = yield* Store
    const registry = yield* ModelRegistry
    const conversation = conversationId({ chatId, threadId })
    yield* logModelSelection("picker-requested", { hasQuery: query.trim().length > 0 })
    const sessionID = yield* sessions.getOrCreate(conversation)
    const directory = yield* sessions.directoryFor(conversation)
    const remembered = yield* store.getModel(directory)
    const currentLine = Option.match(remembered, {
      onNone: () => "",
      onSome: (model) => `Current model: ${model.id}${model.variant === undefined ? "" : ` [${model.variant}]`}\n`,
    })
    const models = yield* opencode.listModels(directory).pipe(
      Effect.catchCause((cause) =>
        logBoundary("telegram/handlers", "opencode-client", "list models failed")(cause).pipe(
          Effect.andThen(Effect.succeed<readonly Model.Info[]>([])),
        ),
      ),
    )
    yield* logModelSelection("models-loaded", { models: models.length })
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const filteredModels = normalizedQuery.length === 0
      ? models
      : models.filter((model) =>
        model.id.toLocaleLowerCase().includes(normalizedQuery) ||
        model.providerID.toLocaleLowerCase().includes(normalizedQuery),
      )
    if (filteredModels.length === 0) {
      yield* sendText(chatId, "No models available.", threadId)
      return
    }
    const providers = [...new Set(filteredModels.map((model) => model.providerID))].map((id) => ({
      id,
      models: filteredModels.filter((model) => model.providerID === id).map((model) => ({
        id: model.id,
        providerID: model.providerID,
        variants: model.variants.map((variant) => variant.id),
      })),
    }))
    yield* logModelSelection("provider-picker-opened", {
      providers: providers.length,
      models: filteredModels.length,
    })
    const token = yield* registry.registerProviders({
      sessionID,
      providers,
      directory,
      chatId,
      threadId,
    })
    const message = yield* sendMarkup(
      chatId,
      currentLine + (normalizedQuery.length === 0 ? "Select a provider:" : `Providers and models matching “${query.trim()}”:`),
      modelProviderKeyboard(token, providers),
      threadId,
    )
    yield* Option.match(message, {
      onNone: () => Effect.void,
      onSome: (sent) => registry.attachMessageId(token, sent.message_id),
    })
  })

/** `/model <exact model>` — switch directly without opening the picker. */
export const selectExactModel = (chatId: number, query: string, threadId?: number) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const opencode = yield* OpenCode
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      yield* sendText(chatId, "Usage: /model <exact-model>", threadId)
      return
    }
    const conversation = conversationId({ chatId, threadId })
    const directory = yield* sessions.directoryFor(conversation)
    const sessionID = yield* sessions.getOrCreate(conversation)
    const models = yield* opencode.listModels(directory).pipe(
      Effect.catchCause((cause) => logBoundary("telegram/handlers", "opencode-client", "list models failed")(cause).pipe(
        Effect.andThen(Effect.succeed<readonly Model.Info[]>([])),
      )),
    )
    const matches = models.filter((model) => model.id === trimmed || `${model.providerID}/${model.id}` === trimmed)
    if (matches.length !== 1) {
      yield* sendText(chatId, matches.length === 0 ? `Model not found: ${trimmed}` : "Model name is ambiguous; use provider/model.", threadId)
      return
    }
    const selected = matches[0]
    if (selected === undefined) {
      yield* sendText(chatId, `Model not found: ${trimmed}`, threadId)
      return
    }
    yield* opencode.switchModel({ sessionID, model: { id: selected.id, providerID: selected.providerID } })
    yield* rememberModel(directory, { id: selected.id, providerID: selected.providerID })
    yield* sendText(chatId, `Model switched to ${selected.providerID}/${selected.id}.`, threadId)
  })
