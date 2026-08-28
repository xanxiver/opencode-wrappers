import { Schema } from "effect"

/** Amount of in-progress run content shown in the Telegram working message. */
export const StreamVerbositySchema = Schema.Literals(["quiet", "normal", "detailed"])

export type StreamVerbosity = Schema.Schema.Type<typeof StreamVerbositySchema>

/** Existing conversations use normal streaming until a user selects another level. */
export const DEFAULT_STREAM_VERBOSITY: StreamVerbosity = "normal"
