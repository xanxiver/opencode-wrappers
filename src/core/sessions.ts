import { Context, Data, Effect, Layer, Option, Semaphore } from "effect"
import { OpenCode } from "./opencode.js"
import { Store } from "./store.js"
import { AppConfigTag, type AppConfig } from "../config.js"

export class SessionsError extends Data.TaggedError("SessionsError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export interface SessionsService {
  readonly getOrCreate: (clientId: string) => Effect.Effect<string, SessionsError>
  readonly reset: (clientId: string) => Effect.Effect<void, SessionsError>
  readonly directoryFor: (clientId: string) => Effect.Effect<string, SessionsError>
  readonly setDirectory: (clientId: string, directory: string) => Effect.Effect<void, SessionsError>
}

export class Sessions extends Context.Service<Sessions, SessionsService>()("opencode2-uis/Sessions") {}

const mapError = (message: string) =>
  (cause: unknown): SessionsError => new SessionsError({ message, cause })

export const Live: Layer.Layer<Sessions, never, OpenCode | Store | AppConfig> = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const opencode = yield* OpenCode
    const store = yield* Store
    const config = yield* AppConfigTag
    const lock = yield* Semaphore.make(1)
    const directoryFor = (clientId: string): Effect.Effect<string, SessionsError> =>
      store.getDirectory(clientId).pipe(
        Effect.map((directory) => directory.pipe(Option.getOrElse(() => config.projectDirectory))),
        Effect.mapError(mapError("resolve directory failed")),
      )
    const getOrCreate = (clientId: string): Effect.Effect<string, SessionsError> =>
      lock.withPermit(
        Effect.gen(function* () {
          const directory = yield* directoryFor(clientId)
          const existing = yield* store.getSessionIDForConversation(clientId)
          return yield* Option.match(existing, {
            onNone: () =>
              Effect.gen(function* () {
                const session = yield* opencode.createSession(directory).pipe(
                  Effect.mapError(mapError("create session failed")),
                )
                yield* store.setSessionIDForConversation(clientId, session.id).pipe(
                  Effect.mapError(mapError("persist session failed")),
                )
                // Track the chat so pending requests can be resurfaced later.
                yield* store.setDirectory(clientId, directory).pipe(
                  Effect.mapError(mapError("persist directory failed")),
                )
                return session.id
              }),
            onSome: (sessionID) => Effect.succeed(sessionID),
          })
        }),
      )
    return {
      getOrCreate,
      reset: (clientId) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* store.removeSessionIDForConversation(clientId).pipe(
              Effect.mapError(mapError("reset session failed")),
            )
          }),
        ),
      directoryFor,
      setDirectory: (clientId, directory) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* directoryFor(clientId)
            const update = current === directory
              ? store.setDirectory(clientId, directory)
              : store.switchConversationDirectory(clientId, directory)
            yield* update.pipe(Effect.mapError(mapError("set directory failed")))
          }),
        ),
    }
  }),
)
