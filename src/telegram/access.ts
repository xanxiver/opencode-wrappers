import { Context, Effect, Layer } from "effect"
import { AppConfigTag, type AppConfig } from "../config.js"

/** Parse a comma-separated list of numeric user ids. */
export const parseAllowedUsers = (raw: string | undefined): ReadonlySet<number> => {
  if (raw === undefined || raw.trim() === "") return new Set()
  const ids = new Set<number>()
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (trimmed === "") continue
    const id = Number(trimmed)
    if (Number.isInteger(id) && id > 0) ids.add(id)
  }
  return ids
}

export interface AccessShape {
  readonly isAllowed: (userId: number) => boolean
}

export class Access extends Context.Service<Access, AccessShape>()("opencode2-uis/Access") {}

export const Live: Layer.Layer<Access, never, AppConfig> = Layer.effect(
  Access,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    const allowed = parseAllowedUsers(config.telegramAllowedUsers)
    return {
      isAllowed: (userId) => allowed.has(userId),
    }
  }),
)

export const AccessLive = Live
