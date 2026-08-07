import { Cause, Effect } from "effect"

/**
 * Log the complete Cause of an unexpected failure at a runtime boundary.
 * The original failure is preserved by the caller after logging.
 */
export const logBoundary = (component: string, boundary: string, message: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.annotateLogs({ component, boundary })(Effect.logError(message, Cause.pretty(cause)))
