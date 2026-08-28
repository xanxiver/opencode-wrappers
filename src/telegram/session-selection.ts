import { Context, Effect, Layer, Ref, Semaphore } from "effect"

export interface SessionSelectionService {
  /** Serialize agent and model selection changes for one OpenCode session. */
  readonly withSession: <A, E, R>(
    sessionID: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class SessionSelection extends Context.Service<SessionSelection, SessionSelectionService>()(
  "opencode2-uis/SessionSelection",
) {}

export const Live: Layer.Layer<SessionSelection> = Layer.effect(
  SessionSelection,
  Effect.gen(function* () {
    const locks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
    const lockFor = (sessionID: string): Effect.Effect<Semaphore.Semaphore> =>
      Ref.modify(locks, (current) => {
        const existing = current.get(sessionID)
        if (existing !== undefined) return [existing, current]
        const lock = Semaphore.makeUnsafe(1)
        return [lock, new Map(current).set(sessionID, lock)]
      })
    const withSession: SessionSelectionService["withSession"] = (sessionID, effect) =>
      lockFor(sessionID).pipe(Effect.flatMap((lock) => lock.withPermit(effect)))

    return { withSession }
  }),
)
