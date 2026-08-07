import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Message } from "../api.js"

export interface QueuedRun {
  readonly message: Message
  readonly text: string
}

interface RunState {
  readonly busy: ReadonlySet<number>
  readonly queues: ReadonlyMap<number, readonly QueuedRun[]>
}

export interface RunCoordinatorShape {
  /** Claim an idle chat without adding work, as used by `/resume`. */
  readonly claim: (chatId: number) => Effect.Effect<boolean, never>
  /** Claim an idle chat, or atomically append work when it is already busy. */
  readonly submit: (chatId: number, item: QueuedRun) => Effect.Effect<boolean, never>
  /** Take the next item, or atomically release the chat when the queue is empty. */
  readonly nextOrRelease: (chatId: number) => Effect.Effect<Option.Option<QueuedRun>, never>
}

export class RunCoordinator extends Context.Service<RunCoordinator, RunCoordinatorShape>()(
  "opencode2-uis/RunCoordinator",
) {}

export const RunCoordinatorLive: Layer.Layer<RunCoordinator> = Layer.effect(
  RunCoordinator,
  Effect.gen(function* () {
    const ref = yield* Ref.make<RunState>({ busy: new Set(), queues: new Map() })
    return {
      claim: (chatId) =>
        Ref.modify(ref, (state) => {
          if (state.busy.has(chatId)) return [false, state]
          const busy = new Set(state.busy)
          busy.add(chatId)
          return [true, { ...state, busy }]
        }),
      submit: (chatId, item) =>
        Ref.modify(ref, (state) => {
          if (!state.busy.has(chatId)) {
            const busy = new Set(state.busy)
            busy.add(chatId)
            return [true, { ...state, busy }]
          }
          const queue = state.queues.get(chatId) ?? []
          const queues = new Map(state.queues).set(chatId, [...queue, item])
          return [false, { ...state, queues }]
        }),
      nextOrRelease: (chatId) =>
        Ref.modify(ref, (state) => {
          const queue = state.queues.get(chatId) ?? []
          const [next, ...rest] = queue
          if (next !== undefined) {
            const queues = new Map(state.queues)
            if (rest.length === 0) queues.delete(chatId)
            else queues.set(chatId, rest)
            return [Option.some(next), { ...state, queues }]
          }
          const busy = new Set(state.busy)
          busy.delete(chatId)
          const queues = new Map(state.queues)
          queues.delete(chatId)
          return [Option.none(), { busy, queues }]
        }),
    }
  }),
)
