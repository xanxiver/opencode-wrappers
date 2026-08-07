import { Effect, Option } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { OpenCode } from "../../core/opencode.js"
import type { Sessions } from "../../core/sessions.js"
import type { Store } from "../../core/store.js"
import type { CallbackQuery, TelegramApi } from "../api.js"
import type { ModelRegistry } from "../models.js"
import type { PermissionRegistry } from "../permissions.js"
import type { Pickers } from "../pickers.js"
import type { QuestionRegistry } from "../questions.js"
import { answer } from "./shared.js"
import { handlePermissionCallback } from "./permission.js"
import {
  handleModelCallback,
  handleModelCancelCallback,
  handleModelPageCallback,
  handleModelVariantCallback,
} from "./model.js"
import { handleQuestionCallback } from "./question.js"
import {
  handleDirectoryCallback,
  handleSessionCallback,
  handleSessionCancelCallback,
  handleSessionPageCallback,
} from "./picker.js"

/** Services used by the callback handlers. Keep the dispatcher boundary typed. */
type CallbackEnv =
  | HttpClient.HttpClient
  | OpenCode
  | Sessions
  | Store
  | TelegramApi
  | ModelRegistry
  | PermissionRegistry
  | Pickers
  | QuestionRegistry

export const handleCallback = (query: CallbackQuery): Effect.Effect<void, never, CallbackEnv> =>
  Option.match(Option.fromNullishOr(query.data), {
    onNone: () => answer(query.id, "No data."),
    onSome: (data) => {
      const [prefix] = data.split(":")
      switch (prefix) {
        case "perm":
          return handlePermissionCallback(query, data)
        case "model":
          return handleModelCallback(query, data)
        case "modelp":
          return handleModelPageCallback(query, data)
        case "modelv":
          return handleModelVariantCallback(query, data)
        case "modelc":
          return handleModelCancelCallback(query, data)
        case "q":
          return handleQuestionCallback(query, data)
        case "dir":
          return handleDirectoryCallback(query, data)
        case "ses":
          return handleSessionCallback(query, data)
        case "sesp":
          return handleSessionPageCallback(query, data)
        case "sesc":
          return handleSessionCancelCallback(query, data)
        default:
          return answer(query.id, "Unknown action.")
      }
    },
  })
