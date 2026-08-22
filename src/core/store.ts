import { Context, Data, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect"
import { dirname } from "node:path"
import type { PlatformError } from "effect/PlatformError"
import { AppConfigTag, type AppConfig } from "../config.js"
import { logBoundary } from "./logging.js"

export class StoreError extends Data.TaggedError("StoreError")<{
  readonly message: string
  readonly cause: unknown
}> {}

/** The model remembered for a directory. */
export interface StoredModel {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

interface State {
  /** directory -> sessionID. Chats sharing a directory share the session. */
  readonly sessions: Record<string, string>
  /** conversation id -> sessionID. Topic sessions are independent. */
  readonly conversationSessions: Record<string, string>
  /** clientId -> directory override. Chats without an entry use the default. */
  readonly directories: Record<string, string>
  /** directory -> last chosen model, re-applied when a run starts. */
  readonly models: Record<string, StoredModel>
  /** conversation id -> loose prompts enabled. */
  readonly loosePrompts: Record<string, boolean>
  /** conversation id -> auto-continue on failure enabled. */
  readonly autoContinue: Record<string, boolean>
}

const StoredModelSchema = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  variant: Schema.optional(Schema.String),
})

const StateSchema = Schema.Struct({
  sessions: Schema.Record(Schema.String, Schema.String),
  conversationSessions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  directories: Schema.Record(Schema.String, Schema.String),
  models: Schema.optional(Schema.Record(Schema.String, StoredModelSchema)),
  loosePrompts: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  autoContinue: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})

/** Legacy format: clientId -> sessionID (one session per chat). */
const LegacySchema = Schema.Record(Schema.String, Schema.String)
type JsonValue = ReturnType<typeof JSON.parse>

const emptyState = (): State => ({ sessions: {}, conversationSessions: {}, directories: {}, models: {}, loosePrompts: {}, autoContinue: {} })

/** Migrate the legacy chat->session map: each chat keeps its session under its own key. */
const migrateLegacy = (legacy: Record<string, string>): State => {
  const directories: Record<string, string> = {}
  for (const clientId of Object.keys(legacy)) {
    directories[clientId] = clientId
  }
  return { sessions: { ...legacy }, conversationSessions: { ...legacy }, directories, models: {}, loosePrompts: {}, autoContinue: {} }
}

const parseState = (json: JsonValue): Option.Option<{ readonly state: State; readonly migrated: boolean }> =>
  Option.match(Schema.decodeUnknownOption(StateSchema)(json), {
    onNone: () =>
      Option.match(Schema.decodeUnknownOption(LegacySchema)(json), {
        onNone: () => Option.none(),
        onSome: (legacy) => Option.some({ state: migrateLegacy(legacy), migrated: true }),
      }),
    onSome: (state) => {
      const conversationSessions = state.conversationSessions ?? Object.fromEntries(
        Object.entries(state.directories).flatMap(([conversation, directory]) => {
          const sessionID = state.sessions[directory]
          return sessionID === undefined ? [] : [[conversation, sessionID]]
        }),
      )
      return Option.some({ state: { ...state, conversationSessions, models: state.models ?? {}, loosePrompts: state.loosePrompts ?? {}, autoContinue: state.autoContinue ?? {} }, migrated: false })
    },
  })

export interface StoreService {
  readonly getSessionIDForConversation: (conversationId: string) => Effect.Effect<Option.Option<string>, never>
  readonly setSessionIDForConversation: (conversationId: string, sessionID: string) => Effect.Effect<void, StoreError>
  readonly removeSessionIDForConversation: (conversationId: string) => Effect.Effect<void, StoreError>
  readonly getSessionIDForDirectory: (directory: string) => Effect.Effect<Option.Option<string>, never>
  readonly setSessionIDForDirectory: (directory: string, sessionID: string) => Effect.Effect<void, StoreError>
  readonly removeSessionIDForDirectory: (directory: string) => Effect.Effect<void, StoreError>
  readonly getDirectory: (clientId: string) => Effect.Effect<Option.Option<string>, never>
  readonly setDirectory: (clientId: string, directory: string) => Effect.Effect<void, StoreError>
  /** Change a conversation directory and clear its incompatible active session atomically. */
  readonly switchConversationDirectory: (conversationId: string, directory: string) => Effect.Effect<void, StoreError>
  readonly getModel: (directory: string) => Effect.Effect<Option.Option<StoredModel>, never>
  readonly setModel: (directory: string, model: StoredModel) => Effect.Effect<void, StoreError>
  /** True when plain messages start runs for this conversation. */
  readonly getLoosePrompts: (conversationId: string) => Effect.Effect<boolean, never>
  readonly setLoosePrompts: (conversationId: string, enabled: boolean) => Effect.Effect<void, StoreError>
  /** True when failed runs auto-send a continue prompt for this conversation. */
  readonly getAutoContinue: (conversationId: string) => Effect.Effect<boolean, never>
  readonly setAutoContinue: (conversationId: string, enabled: boolean) => Effect.Effect<void, StoreError>
  /** Every client id the store knows about. */
  readonly listClients: () => Effect.Effect<readonly string[], never>
  /** Every directory retained by a client or session mapping. */
  readonly listDirectories: () => Effect.Effect<readonly string[], never>
}

export class Store extends Context.Service<Store, StoreService>()("opencode2-uis/Store") {}

export const Live: Layer.Layer<Store, StoreError, FileSystem.FileSystem | AppConfig> = Layer.effect(
  Store,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const config = yield* AppConfigTag
    const persist = (state: State): Effect.Effect<void, StoreError> =>
      fs.makeDirectory(dirname(config.stateFile), { recursive: true }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
        Effect.andThen(fs.writeFileString(config.stateFile, JSON.stringify(state, null, 2))),
        Effect.catchCause((cause) =>
          logBoundary("core/store", "state-file", "failed to write state file")(cause).pipe(
            Effect.andThen(Effect.failCause(cause)),
          ),
        ),
        Effect.mapError((cause) => new StoreError({ message: "failed to write state file", cause })),
      )
    const loaded = yield* fs.readFileString(config.stateFile).pipe(
      Effect.flatMap((text) => Effect.try({
        try: (): JsonValue => JSON.parse(text),
        catch: (cause) => new StoreError({ message: "state file contains invalid JSON", cause }),
      })),
      Effect.flatMap((json) => Effect.succeed(parseState(json))),
      Effect.catchIf(
        (error: PlatformError | StoreError) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () =>
          Effect.annotateLogs({ component: "core/store", boundary: "state-file" })(
            Effect.logDebug("state file not found; starting empty"),
          ).pipe(Effect.andThen(Effect.succeed(Option.none()))),
        (cause) =>
          Effect.annotateLogs({ component: "core/store", boundary: "state-file" })(
            Effect.logWarning("state file invalid; starting empty", cause),
          ).pipe(Effect.andThen(Effect.succeed(Option.none()))),
      ),
    )
    const { state: initial, migrated } = loaded.pipe(
      Option.getOrElse(() => ({ state: emptyState(), migrated: false })),
    )
    if (migrated) {
      yield* persist(initial)
    }
    const ref = yield* Ref.make(initial)
    // Serialize each durable state transition. Publish it to memory only
    // after the file write succeeds, so failed writes cannot leak into later
    // snapshots.
    const writeLock = yield* Semaphore.make(1)
    const commit = (update: (state: State) => State): Effect.Effect<void, StoreError> =>
      writeLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(ref)
          const next = update(current)
          yield* persist(next)
          yield* Ref.set(ref, next)
        }),
      )
    return {
      getSessionIDForConversation: (conversationId) =>
        Ref.get(ref).pipe(Effect.map((state) => Option.fromNullishOr(state.conversationSessions[conversationId]))),
      setSessionIDForConversation: (conversationId, sessionID) =>
        commit((state) => ({ ...state, conversationSessions: { ...state.conversationSessions, [conversationId]: sessionID } })),
      removeSessionIDForConversation: (conversationId) =>
        commit((state) => {
          const conversationSessions = { ...state.conversationSessions }
          delete conversationSessions[conversationId]
          return { ...state, conversationSessions }
        }),
      getSessionIDForDirectory: (directory) =>
        Ref.get(ref).pipe(Effect.map((state) => Option.fromNullishOr(state.sessions[directory]))),
      setSessionIDForDirectory: (directory, sessionID) =>
        commit((state) => ({
          ...state,
          sessions: { ...state.sessions, [directory]: sessionID },
        })),
      removeSessionIDForDirectory: (directory) =>
        commit((state) => {
          const sessions = { ...state.sessions }
          delete sessions[directory]
          return { ...state, sessions }
        }),
      getDirectory: (clientId) =>
        Ref.get(ref).pipe(Effect.map((state) => Option.fromNullishOr(state.directories[clientId]))),
      setDirectory: (clientId, directory) =>
        commit((state) => ({
          ...state,
          directories: { ...state.directories, [clientId]: directory },
        })),
      switchConversationDirectory: (conversationId, directory) =>
        commit((state) => {
          const conversationSessions = { ...state.conversationSessions }
          delete conversationSessions[conversationId]
          return {
            ...state,
            conversationSessions,
            directories: { ...state.directories, [conversationId]: directory },
          }
        }),
      getModel: (directory) =>
        Ref.get(ref).pipe(Effect.map((state) => Option.fromNullishOr(state.models[directory]))),
      setModel: (directory, model) =>
        commit((state) => ({
          ...state,
          models: { ...state.models, [directory]: model },
        })),
      getLoosePrompts: (conversationId) =>
        Ref.get(ref).pipe(Effect.map((state) => state.loosePrompts[conversationId] ?? false)),
      setLoosePrompts: (conversationId, enabled) =>
        commit((state) => ({
          ...state,
          loosePrompts: { ...state.loosePrompts, [conversationId]: enabled },
        })),
      getAutoContinue: (conversationId) =>
        Ref.get(ref).pipe(Effect.map((state) => state.autoContinue[conversationId] ?? false)),
      setAutoContinue: (conversationId, enabled) =>
        commit((state) => ({
          ...state,
          autoContinue: { ...state.autoContinue, [conversationId]: enabled },
        })),
      listClients: () => Ref.get(ref).pipe(Effect.map((state) => Object.keys(state.directories))),
      listDirectories: () => Ref.get(ref).pipe(Effect.map((state) => [
        ...new Set([...Object.keys(state.sessions), ...Object.values(state.directories)]),
      ])),
    }
  }),
)
