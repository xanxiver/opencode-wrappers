import { Clock, Context, Effect, Layer, Option, Ref } from "effect"

export const AGENT_PICKER_TTL_MS = 60 * 60 * 1000
export const AGENT_PICKER_MAX_ENTRIES = 1_000

export interface SelectableAgent {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AgentPickerEntry {
  readonly sessionID: string
  readonly directory: string
  readonly agents: readonly SelectableAgent[]
  readonly chatId: number
  readonly threadId?: number
  readonly messageId: number
  readonly timeCreated: number
}

export interface AgentRegistryService {
  readonly register: (input: Omit<AgentPickerEntry, "messageId" | "timeCreated">) => Effect.Effect<number>
  readonly attachMessageId: (token: number, messageId: number) => Effect.Effect<void>
  readonly take: (token: number, chatId: number, messageId: number) => Effect.Effect<Option.Option<AgentPickerEntry>>
  readonly cancel: (token: number, chatId: number, messageId: number) => Effect.Effect<Option.Option<AgentPickerEntry>>
}

export class AgentRegistry extends Context.Service<AgentRegistry, AgentRegistryService>()(
  "opencode2-uis/AgentRegistry",
) {}

interface RegistryState {
  readonly next: number
  readonly entries: ReadonlyMap<number, AgentPickerEntry>
}

const cleanEntries = (entries: ReadonlyMap<number, AgentPickerEntry>, now: number): Map<number, AgentPickerEntry> => {
  const current = [...entries].filter(([, entry]) => now - entry.timeCreated <= AGENT_PICKER_TTL_MS)
  return new Map(current.slice(-AGENT_PICKER_MAX_ENTRIES + 1))
}

export const Live: Layer.Layer<AgentRegistry> = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const ref = yield* Ref.make<RegistryState>({ next: 1, entries: new Map() })
    const removeMatching = (token: number, chatId: number, messageId: number) =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.modify(ref, (state) => {
        const entry = state.entries.get(token)
        if (entry === undefined || entry.chatId !== chatId || entry.messageId !== messageId) {
          return [Option.none(), state]
        }
        const entries = new Map(state.entries)
        entries.delete(token)
        if (now - entry.timeCreated > AGENT_PICKER_TTL_MS) {
          return [Option.none(), { ...state, entries }]
        }
        return [Option.some(entry), { ...state, entries }]
      })))
    return {
      register: (input) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.modify(ref, (state) => {
        const token = state.next
        const entries = cleanEntries(state.entries, now)
        entries.set(token, { ...input, messageId: 0, timeCreated: now })
        return [token, { next: token + 1, entries }]
      }))),
      attachMessageId: (token, messageId) => Ref.update(ref, (state) => {
        const entry = state.entries.get(token)
        if (entry === undefined) return state
        return { ...state, entries: new Map(state.entries).set(token, { ...entry, messageId }) }
      }),
      take: removeMatching,
      cancel: removeMatching,
    }
  }),
)
