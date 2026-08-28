import { Clock, Context, Data, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect"
import {
  TELEGRAM_CONTROLLER_BOT_KEY,
} from "../config.js"
import {
  DurableExecutorStore,
  type DurableExecutorError,
  type DurableExecutorRepository,
  type DurableJob,
} from "../core/durable-executor.js"
import { Store, type StoreService } from "../core/store.js"
import {
  chatIdFromConversation,
  conversationId,
  isGroupConversation,
  TelegramDeliveryRouteSchema,
} from "./conversation.js"
import {
  InteractionStore,
  type InteractionStoreError,
  type InteractionStateStore,
} from "./interaction-store.js"
import {
  TelegramBotPool,
  type TelegramBotPoolService,
  type TelegramDeliveryMember,
  type TelegramDeliveryMemberStatus,
} from "./bot-pool.js"

const ASSIGNMENT_STATE_KEY = "telegram:delivery-assignments:v1"
const ASSIGNMENT_STATE_VERSION = 1

const PersistedAssignmentSchema = Schema.Struct({
  conversationId: Schema.String,
  sessionID: Schema.String,
  deliveryBotKey: Schema.String,
  generation: Schema.Number,
  assignedAt: Schema.Number,
  updatedAt: Schema.Number,
  legacy: Schema.optional(Schema.Boolean),
})

const PersistedStateSchema = Schema.Struct({
  version: Schema.Literal(ASSIGNMENT_STATE_VERSION),
  cursor: Schema.Number,
  assignments: Schema.Array(PersistedAssignmentSchema),
})

type PersistedState = Schema.Schema.Type<typeof PersistedStateSchema>

export interface TelegramDeliveryAssignment {
  readonly conversationId: string
  readonly sessionID: string
  readonly deliveryBotKey: string
  readonly generation: number
  readonly assignedAt: number
  readonly updatedAt: number
  readonly legacy: boolean
}

export class DeliveryAssignmentStateError extends Data.TaggedError("DeliveryAssignmentStateError")<{
  readonly message: string
}> {}

export class NoDeliveryBotAvailable extends Data.TaggedError("NoDeliveryBotAvailable")<{
  readonly chatId: number
  readonly message: string
}> {}

export class DeliveryOwnerBusyUnavailable extends Data.TaggedError("DeliveryOwnerBusyUnavailable")<{
  readonly botKey: string
  readonly sessionID: string
  readonly message: string
}> {}

export class LegacyDeliveryOwnerUnavailable extends Data.TaggedError("LegacyDeliveryOwnerUnavailable")<{
  readonly botKey: string
  readonly sessionID: string
  readonly message: string
}> {}

export type DeliveryAssignmentError =
  | DurableExecutorError
  | InteractionStoreError
  | NoDeliveryBotAvailable
  | DeliveryOwnerBusyUnavailable
  | LegacyDeliveryOwnerUnavailable

export interface TelegramDeliveryAssignmentsService {
  readonly resolve: (
    conversation: string,
    sessionID: string,
    chatId: number,
  ) => Effect.Effect<TelegramDeliveryAssignment, DeliveryAssignmentError>
  readonly get: (
    conversation: string,
    sessionID: string,
  ) => Effect.Effect<Option.Option<TelegramDeliveryAssignment>>
  readonly clear: (conversation: string) => Effect.Effect<void, InteractionStoreError>
  readonly list: Effect.Effect<readonly TelegramDeliveryAssignment[]>
}

export class TelegramDeliveryAssignments extends Context.Service<
  TelegramDeliveryAssignments,
  TelegramDeliveryAssignmentsService
>()("opencode2-uis/TelegramDeliveryAssignments") {}

export interface TelegramDeliveryStatusSnapshot {
  readonly assignment: Option.Option<Pick<TelegramDeliveryAssignment, "deliveryBotKey" | "legacy">>
  readonly members: readonly TelegramDeliveryMemberStatus[]
}

export interface TelegramDeliveryStatusService {
  readonly get: (input: {
    readonly conversationId: string
    readonly sessionID?: string
    readonly chatId: number
  }) => Effect.Effect<Option.Option<TelegramDeliveryStatusSnapshot>>
  readonly clear: (conversationId: string) => Effect.Effect<void, InteractionStoreError>
}

/** Status has a no-op default so non-Telegram unit boundaries stay lightweight. */
export const TelegramDeliveryStatus: Context.Reference<TelegramDeliveryStatusService> = Context.Reference(
  "opencode2-uis/TelegramDeliveryStatus",
  {
    defaultValue: (): TelegramDeliveryStatusService => ({
      get: () => Effect.succeed(Option.none()),
      clear: () => Effect.void,
    }),
  },
)

const toAssignment = (
  assignment: Schema.Schema.Type<typeof PersistedAssignmentSchema>,
): TelegramDeliveryAssignment => ({
  ...assignment,
  legacy: assignment.legacy ?? false,
})

const executableStates = new Set(["pending", "dispatching", "running", "finalizing"])

const LoadPayloadSchema = Schema.Struct({
  chatId: Schema.Number,
  threadId: Schema.optional(Schema.Number),
  sessionID: Schema.String,
  conversationId: Schema.optional(Schema.String),
  runDeliveryRoute: Schema.optional(TelegramDeliveryRouteSchema),
  assignmentGeneration: Schema.optional(Schema.Number),
})

const loadPayload = (job: DurableJob) => Effect.try({
  try: () => JSON.parse(job.payload),
  catch: () => undefined,
}).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(LoadPayloadSchema)),
  Effect.option,
)

const hasLiveDeliveryOwner = (
  jobs: readonly DurableJob[],
  deliveryBotKey: string,
): Effect.Effect<boolean> => Effect.gen(function* () {
  for (const job of jobs) {
    if (!executableStates.has(job.state)) continue
    const payload = yield* loadPayload(job)
    // Fence conservatively when retained state cannot establish its owner.
    if (Option.isNone(payload)) return true
    const owner = payload.value.runDeliveryRoute?.botKey ?? TELEGRAM_CONTROLLER_BOT_KEY
    if (owner === deliveryBotKey) return true
  }
  return false
})

const ownerFor = (sessionID: string): string => `session:${sessionID}`

const activeAssignmentKeys = (
  state: PersistedState,
  selected: ReadonlyMap<string, string>,
): readonly Schema.Schema.Type<typeof PersistedAssignmentSchema>[] =>
  state.assignments.filter((assignment) => selected.get(assignment.conversationId) === assignment.sessionID)

const selectLeastLoaded = (
  members: readonly TelegramDeliveryMember[],
  load: ReadonlyMap<string, ReadonlySet<string>>,
  cursor: number,
): TelegramDeliveryMember | undefined => {
  const ordered = [...members].sort((left, right) => left.botKey.localeCompare(right.botKey))
  const minimum = Math.min(...ordered.map((member) => load.get(member.botKey)?.size ?? 0))
  const tied = ordered.filter((member) => (load.get(member.botKey)?.size ?? 0) === minimum)
  const selected = tied[Math.abs(cursor) % tied.length]
  return selected ?? ordered[0]
}

const loadState = (
  interaction: InteractionStateStore,
  store: Pick<StoreService, "listConversationSessions">,
): Effect.Effect<PersistedState, InteractionStoreError | DeliveryAssignmentStateError> =>
  Effect.gen(function* () {
    const persisted = yield* interaction.get(ASSIGNMENT_STATE_KEY)
    if (Option.isSome(persisted)) {
      return yield* Option.match(Schema.decodeUnknownOption(PersistedStateSchema)(persisted.value), {
        onNone: () => Effect.fail(new DeliveryAssignmentStateError({
          message: "persisted Telegram delivery assignments are invalid",
        })),
        onSome: Effect.succeed,
      })
    }
    const now = yield* Clock.currentTimeMillis
    const existing = yield* store.listConversationSessions()
    const state: PersistedState = {
      version: ASSIGNMENT_STATE_VERSION,
      cursor: 0,
      assignments: existing
        .filter(({ conversationId: value }) => isGroupConversation(value))
        .map(({ conversationId: value, sessionID }) => ({
          conversationId: value,
          sessionID,
          deliveryBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
          generation: 0,
          assignedAt: now,
          updatedAt: now,
          legacy: true,
        })),
    }
    yield* interaction.set(ASSIGNMENT_STATE_KEY, state)
    return state
  })

export const makeTelegramDeliveryAssignments = (
  interaction: InteractionStateStore,
  store: Pick<StoreService, "listConversationSessions">,
  jobs: Pick<DurableExecutorRepository, "listNonTerminal" | "listOwner">,
  pool: Pick<TelegramBotPoolService, "eligibleMembers">,
): Effect.Effect<
  TelegramDeliveryAssignmentsService,
  InteractionStoreError | DeliveryAssignmentStateError
> => Effect.gen(function* () {
    const initial = yield* loadState(interaction, store)
    const state = yield* Ref.make(initial)
    const lock = yield* Semaphore.make(1)
    const persist = (next: PersistedState): Effect.Effect<void, InteractionStoreError> =>
      interaction.set(ASSIGNMENT_STATE_KEY, next).pipe(
        Effect.andThen(Ref.set(state, next)),
      )

    const selectedSessions = (): Effect.Effect<ReadonlyMap<string, string>> =>
      store.listConversationSessions().pipe(
        Effect.map((entries) => {
          const selected = new Map<string, string>()
          for (const entry of entries) selected.set(entry.conversationId, entry.sessionID)
          return selected
        }),
      )

    const currentLoad = (
      snapshot: PersistedState,
    ): Effect.Effect<ReadonlyMap<string, ReadonlySet<string>>, DurableExecutorError> =>
      Effect.gen(function* () {
        const selected = yield* selectedSessions()
        const loads = new Map<string, Set<string>>()
        const add = (botKey: string, key: string): void => {
          const keys = loads.get(botKey) ?? new Set<string>()
          keys.add(key)
          loads.set(botKey, keys)
        }
        const activeAssignments = activeAssignmentKeys(snapshot, selected)
        const activeBySession = new Map(activeAssignments.map((assignment) => [
          `${assignment.conversationId}:${assignment.sessionID}`,
          assignment,
        ]))
        for (const assignment of activeAssignments) {
          add(assignment.deliveryBotKey, `assignment:${assignment.conversationId}:${assignment.sessionID}`)
        }
        const activeJobs = yield* jobs.listNonTerminal("telegram")
        const decoded = yield* Effect.forEach(activeJobs, loadPayload)
        for (let index = 0; index < decoded.length; index += 1) {
          const payloadOption = decoded[index]
          if (payloadOption === undefined) continue
          if (Option.isNone(payloadOption)) continue
          const payload = payloadOption.value
          const conversation = payload.conversationId ?? conversationId({
            chatId: payload.chatId,
            threadId: payload.threadId,
          })
          const botKey = payload.runDeliveryRoute?.botKey ?? TELEGRAM_CONTROLLER_BOT_KEY
          const active = activeBySession.get(`${conversation}:${payload.sessionID}`)
          const coveredByActiveAssignment = active?.deliveryBotKey === botKey && (
            payload.assignmentGeneration === undefined || payload.assignmentGeneration === active.generation
          )
          const job = activeJobs[index]
          if (!coveredByActiveAssignment && job !== undefined) add(botKey, `job:${job.id}`)
        }
        return loads
      })

    const resolve = (
      conversation: string,
      sessionID: string,
      chatId: number,
    ): Effect.Effect<TelegramDeliveryAssignment, DeliveryAssignmentError> =>
      Effect.gen(function* () {
        // Membership probes can wait on Telegram. Keep them outside the
        // assignment lock so unrelated topics can probe in parallel.
        const eligible = yield* pool.eligibleMembers(chatId)
        return yield* lock.withPermit(Effect.gen(function* () {
          const snapshot = yield* Ref.get(state)
          const current = snapshot.assignments.find((assignment) => assignment.conversationId === conversation)
          const currentMember = current === undefined
            ? undefined
            : eligible.find((member) => member.botKey === current.deliveryBotKey)
          if (current?.sessionID === sessionID && currentMember !== undefined) {
            yield* Effect.annotateLogs({
              controllerBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
              deliveryBotKey: current.deliveryBotKey,
              deliveryBotUsername: currentMember.username,
              conversationId: conversation,
              chatId,
              sessionID,
              assignmentGeneration: current.generation,
              legacyOwnership: current.legacy ?? false,
            })(Effect.logDebug("reusing Telegram delivery assignment"))
            return toAssignment(current)
          }
          if (current?.sessionID === sessionID) {
            if (current.legacy === true) {
              return yield* new LegacyDeliveryOwnerUnavailable({
                botKey: current.deliveryBotKey,
                sessionID,
                message: "The legacy Telegram delivery owner is unavailable; select or reset the session before reassignment",
              })
            }
            const ownerJobs = yield* jobs.listOwner("telegram", ownerFor(sessionID))
            if (yield* hasLiveDeliveryOwner(ownerJobs, current.deliveryBotKey)) {
              return yield* new DeliveryOwnerBusyUnavailable({
                botKey: current.deliveryBotKey,
                sessionID,
                message: "The assigned Telegram delivery bot is unavailable while this session still has active work",
              })
            }
          }
          if (eligible.length === 0) {
            return yield* new NoDeliveryBotAvailable({
              chatId,
              message: "No Telegram delivery bot can send to this group",
            })
          }
          const loads = yield* currentLoad(snapshot)
          const selected = selectLeastLoaded(eligible, loads, snapshot.cursor)
          if (selected === undefined) {
            return yield* new NoDeliveryBotAvailable({
              chatId,
              message: "No Telegram delivery bot can send to this group",
            })
          }
          const now = yield* Clock.currentTimeMillis
          const assignment: Schema.Schema.Type<typeof PersistedAssignmentSchema> = {
            conversationId: conversation,
            sessionID,
            deliveryBotKey: selected.botKey,
            generation: (current?.generation ?? 0) + 1,
            assignedAt: now,
            updatedAt: now,
            legacy: false,
          }
          const next: PersistedState = {
            ...snapshot,
            cursor: snapshot.cursor + 1,
            assignments: [
              ...snapshot.assignments.filter((entry) => entry.conversationId !== conversation),
              assignment,
            ],
          }
          yield* persist(next)
          yield* Effect.annotateLogs({
            controllerBotKey: TELEGRAM_CONTROLLER_BOT_KEY,
            deliveryBotKey: selected.botKey,
            deliveryBotUsername: selected.username,
            conversationId: conversation,
            chatId,
            sessionID,
            assignmentGeneration: assignment.generation,
            deliveryBotHealth: "healthy",
            legacyOwnership: false,
          })(Effect.logInfo("selected Telegram delivery assignment"))
          return toAssignment(assignment)
        }))
      })

    return {
      resolve,
      get: (conversation, sessionID) => Ref.get(state).pipe(
        Effect.map((snapshot) => Option.fromNullishOr(snapshot.assignments.find((assignment) =>
          assignment.conversationId === conversation && assignment.sessionID === sessionID
        )).pipe(Option.map(toAssignment))),
      ),
      clear: (conversation) => lock.withPermit(Effect.gen(function* () {
        const snapshot = yield* Ref.get(state)
        if (!snapshot.assignments.some((assignment) => assignment.conversationId === conversation)) return
        yield* persist({
          ...snapshot,
          assignments: snapshot.assignments.filter((assignment) => assignment.conversationId !== conversation),
        })
      })),
      list: Ref.get(state).pipe(Effect.map((snapshot) => snapshot.assignments.map(toAssignment))),
    }
  })

export const TelegramDeliveryAssignmentsLive: Layer.Layer<
  TelegramDeliveryAssignments,
  InteractionStoreError | DeliveryAssignmentStateError,
  InteractionStore | Store | DurableExecutorStore | TelegramBotPool
> = Layer.effect(
  TelegramDeliveryAssignments,
  Effect.gen(function* () {
    const interaction = yield* InteractionStore
    const store = yield* Store
    const jobs = yield* DurableExecutorStore
    const pool = yield* TelegramBotPool
    return yield* makeTelegramDeliveryAssignments(interaction, store, jobs, pool)
  }),
)

export const TelegramDeliveryStatusLive = Layer.effect(
  TelegramDeliveryStatus,
  Effect.gen(function* () {
    const assignments = yield* TelegramDeliveryAssignments
    const pool = yield* TelegramBotPool
    return {
      clear: assignments.clear,
      get: ({ conversationId: conversation, sessionID, chatId }) => Effect.gen(function* () {
        const members = yield* pool.status(chatId)
        let assignment: Option.Option<Pick<TelegramDeliveryAssignment, "deliveryBotKey" | "legacy">>
        if (chatId >= 0) {
          assignment = Option.some({ deliveryBotKey: pool.controllerBotKey, legacy: false })
        } else if (sessionID === undefined) {
          assignment = Option.none()
        } else {
          assignment = yield* assignments.get(conversation, sessionID)
        }
        return Option.some({ assignment, members })
      }),
    }
  }),
)

/** Read the chat id only for persisted assignment migrations and diagnostics. */
export const assignmentChatId = (assignment: Pick<TelegramDeliveryAssignment, "conversationId">): Option.Option<number> =>
  chatIdFromConversation(assignment.conversationId)
