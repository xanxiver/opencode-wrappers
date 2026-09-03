import { Cause, Effect, References } from "effect"

export type LogAnnotations = Readonly<Record<string, string | number | boolean | undefined>>

/**
 * Log the complete Cause of an unexpected failure at a runtime boundary.
 * The original failure is preserved by the caller after logging.
 */
export const logBoundary = (component: string, boundary: string, message: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.annotateLogs({ component, boundary })(Effect.logError(message, Cause.pretty(cause)))

/** Emit one targeted debug event when the related diagnostic switch is enabled. */
export const logDebugEvent = (
  enabled: boolean,
  component: string,
  boundary: string,
  message: string,
  annotations: LogAnnotations = {},
): Effect.Effect<void> => enabled
  ? Effect.annotateLogs({ component, boundary, ...annotations })(Effect.logDebug(message)).pipe(
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    )
  : Effect.void
