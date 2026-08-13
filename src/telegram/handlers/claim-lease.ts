import { Data, Effect, Schedule } from "effect"

export class InteractionClaimLost extends Data.TaggedError("InteractionClaimLost")<{
  readonly token: number
}> {}

/** Validate ownership before the external operation, then renew it periodically. */
export const withClaimLease = <A, E, R, E2, R2>(
  token: number,
  effect: Effect.Effect<A, E, R>,
  renew: Effect.Effect<boolean, E2, R2>,
): Effect.Effect<A, E | E2 | InteractionClaimLost, R | R2> => renew.pipe(
  Effect.flatMap((active) => {
    if (!active) return Effect.fail(new InteractionClaimLost({ token }))
    const heartbeat = Effect.sleep("30 seconds").pipe(
      Effect.andThen(renew),
      Effect.flatMap((stillActive) => stillActive
        ? Effect.void
        : Effect.fail(new InteractionClaimLost({ token }))),
      Effect.repeat(Schedule.forever),
      Effect.andThen(Effect.never),
    )
    return Effect.raceFirst(effect, heartbeat)
  }),
)
