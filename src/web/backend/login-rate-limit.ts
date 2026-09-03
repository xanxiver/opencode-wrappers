import { Clock, Context, Effect, Layer, Ref } from "effect"

export type LoginRateLimitScope = "login" | "refresh"

export interface LoginRateLimiterService {
  readonly retryAfter: (scope: LoginRateLimitScope, key: string, now?: number) => Effect.Effect<number | undefined>
  readonly recordFailure: (scope: LoginRateLimitScope, key: string, now?: number) => Effect.Effect<void>
  readonly clear: (scope: LoginRateLimitScope, key: string) => Effect.Effect<void>
}

export class LoginRateLimiter extends Context.Service<LoginRateLimiter, LoginRateLimiterService>()(
  "opencode2-uis/LoginRateLimiter",
) {}

interface Entry {
  readonly count: number
  readonly resetAt: number
}

type Entries = ReadonlyMap<LoginRateLimitScope, ReadonlyMap<string, Entry>>

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5
const MAX_ENTRIES = 10_000

const currentTime = (now: number | undefined): Effect.Effect<number> =>
  now === undefined ? Clock.currentTimeMillis : Effect.succeed(now)

const clean = (entries: ReadonlyMap<string, Entry>, now: number): Map<string, Entry> => {
  const active = new Map([...entries].filter(([, entry]) => entry.resetAt > now))
  while (active.size >= MAX_ENTRIES) {
    const oldest = active.keys().next().value
    if (oldest === undefined) break
    active.delete(oldest)
  }
  return active
}

/** A bounded fixed-window limiter whose state belongs to the providing layer. */
export const LoginRateLimiterLive: Layer.Layer<LoginRateLimiter> = Layer.effect(
  LoginRateLimiter,
  Effect.gen(function* () {
    const entries = yield* Ref.make<Entries>(new Map())
    return {
      retryAfter: (scope, key, now) => currentTime(now).pipe(
        Effect.flatMap((time) => Ref.modify(entries, (all) => {
          const scoped = clean(all.get(scope) ?? new Map(), time)
          const entry = scoped.get(key)
          const retryAfter = entry === undefined || entry.count < MAX_FAILURES
            ? undefined
            : Math.ceil((entry.resetAt - time) / 1000)
          return [retryAfter, new Map(all).set(scope, scoped)]
        })),
      ),
      recordFailure: (scope, key, now) => currentTime(now).pipe(
        Effect.flatMap((time) => Ref.update(entries, (all) => {
          const scoped = clean(all.get(scope) ?? new Map(), time)
          const current = scoped.get(key)
          scoped.set(key, current === undefined
            ? { count: 1, resetAt: time + WINDOW_MS }
            : { count: current.count + 1, resetAt: current.resetAt })
          return new Map(all).set(scope, scoped)
        })),
      ),
      clear: (scope, key) => Ref.update(entries, (all) => {
        const scoped = new Map(all.get(scope) ?? new Map())
        scoped.delete(key)
        return new Map(all).set(scope, scoped)
      }),
    }
  }),
)
