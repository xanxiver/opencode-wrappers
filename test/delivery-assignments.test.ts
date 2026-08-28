import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Ref } from "effect"
import type { DurableJob } from "../src/core/durable-executor.js"
import type { TelegramDeliveryMember } from "../src/telegram/bot-pool.js"
import {
  makeTelegramDeliveryAssignments,
} from "../src/telegram/delivery-assignments.js"
import type {
  InteractionStateStore,
  JsonValue,
} from "../src/telegram/interaction-store.js"

const member = (botKey: string, controller = false): TelegramDeliveryMember => ({
  botKey,
  controller,
})

const activeJob = (
  sessionID: string,
  botKey: string,
  conversationId: string,
  state: DurableJob["state"] = "running",
  jobID = `job-${sessionID}`,
): DurableJob => ({
  id: jobID,
  sourceKey: `source-${sessionID}`,
  channel: "telegram",
  owner: `session:${sessionID}`,
  payload: JSON.stringify({
    chatId: -100,
    sessionID,
    conversationId,
    runDeliveryRoute: { botKey, chatId: -100, threadId: 1 },
  }),
  state,
  attempt: 1,
  availableAt: 0,
  deliveredMediaCount: 0,
  createdAt: 0,
  updatedAt: 0,
  queueOrder: 1,
})

const makeInteractionStore = (
  values: Ref.Ref<ReadonlyMap<string, JsonValue>>,
): InteractionStateStore => ({
  get: (key) => Ref.get(values).pipe(
    Effect.map((current) => Option.fromNullishOr(current.get(key))),
  ),
  set: (key, value) => Ref.update(values, (current) => new Map(current).set(key, value)),
  modify: (key, change) => Ref.modify(values, (current) => {
    const [result, value] = change(Option.fromNullishOr(current.get(key)))
    return [result, new Map(current).set(key, value)]
  }),
})

const makeHarness = (
  initialSelected: ReadonlyMap<string, string> = new Map(),
  initialMembers: readonly TelegramDeliveryMember[] = [member("controller", true)],
) => Effect.gen(function* () {
  const selected = yield* Ref.make(initialSelected)
  const activeJobs = yield* Ref.make<readonly DurableJob[]>([])
  const eligible = yield* Ref.make(initialMembers)
  const interactionValues = yield* Ref.make<ReadonlyMap<string, JsonValue>>(new Map())
  const interaction = makeInteractionStore(interactionValues)
  const store = {
    listConversationSessions: () => Ref.get(selected).pipe(
      Effect.map((current) => [...current].map(([conversationId, sessionID]) => ({
        conversationId,
        sessionID,
      }))),
    ),
  }
  const jobs = {
    listNonTerminal: (_channel: string) => Ref.get(activeJobs).pipe(
      Effect.map((current) => current.filter((job) =>
        job.state === "pending" || job.state === "dispatching" || job.state === "running" || job.state === "finalizing"
      )),
    ),
    listOwner: (_channel: string, owner: string) => Ref.get(activeJobs).pipe(
      Effect.map((current) => current.filter((job) => job.owner === owner)),
    ),
  }
  const pool = {
    eligibleMembers: (_chatId: number) => Ref.get(eligible),
  }
  const assignments = yield* makeTelegramDeliveryAssignments(interaction, store, jobs, pool)
  return { assignments, selected, activeJobs, eligible, interaction, store, jobs, pool }
})

const selectSession = (
  selected: Ref.Ref<ReadonlyMap<string, string>>,
  conversationId: string,
  sessionID: string,
): Effect.Effect<void> => Ref.update(selected, (current) => new Map(current).set(conversationId, sessionID))

describe("Telegram delivery assignments", () => {
  test("migrates existing group sessions to controller compatibility ownership", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const harness = yield* makeHarness(new Map([
        ["tg:-100:thread:1", "ses_group"],
        ["tg:7", "ses_private"],
      ]))
      return yield* harness.assignments.list
    }))

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      conversationId: "tg:-100:thread:1",
      sessionID: "ses_group",
      deliveryBotKey: "controller",
      generation: 0,
      legacy: true,
    })
  })

  test("does not move a legacy controller assignment before the session changes", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(
        new Map([[conversation, "ses_legacy"]]),
        [member("delivery-1")],
      )
      return yield* Effect.exit(harness.assignments.resolve(conversation, "ses_legacy", -100))
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("LegacyDeliveryOwnerUnavailable")
  })

  test("spreads ten active sessions across ten equally loaded members and reuses the selected owner", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const members = [member("controller", true), ...Array.from({ length: 9 }, (_, index) => member(`delivery-${index + 1}`))]
      const harness = yield* makeHarness(new Map(), members)
      const firstTen = []
      for (let index = 0; index < 10; index += 1) {
        const conversation = `tg:-100:thread:${index + 1}`
        const sessionID = `ses_${index + 1}`
        yield* selectSession(harness.selected, conversation, sessionID)
        firstTen.push(yield* harness.assignments.resolve(conversation, sessionID, -100))
      }
      const eleventhConversation = "tg:-100:thread:11"
      yield* selectSession(harness.selected, eleventhConversation, "ses_11")
      const eleventh = yield* harness.assignments.resolve(eleventhConversation, "ses_11", -100)
      const repeated = yield* harness.assignments.resolve(eleventhConversation, "ses_11", -100)
      return { firstTen, eleventh, repeated }
    }))

    expect(new Set(result.firstTen.map((assignment) => assignment.deliveryBotKey)).size).toBe(10)
    expect(result.firstTen.some((assignment) => assignment.deliveryBotKey === "controller")).toBe(true)
    expect(result.eleventh.deliveryBotKey).toBe(result.repeated.deliveryBotKey)
    expect(result.eleventh.generation).toBe(result.repeated.generation)
  })

  test("counts a detached old run while assigning a switched session", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map([[conversation, "ses_old"]]), [
        member("controller", true),
        member("delivery-1"),
      ])
      const oldAssignment = yield* harness.assignments.resolve(conversation, "ses_old", -100)
      yield* Ref.set(harness.activeJobs, [activeJob("ses_old", oldAssignment.deliveryBotKey, conversation)])
      yield* selectSession(harness.selected, conversation, "ses_new")
      const nextAssignment = yield* harness.assignments.resolve(conversation, "ses_new", -100)
      return { oldAssignment, nextAssignment }
    }))

    expect(result.oldAssignment.deliveryBotKey).toBe("controller")
    expect(result.nextAssignment.deliveryBotKey).toBe("delivery-1")
  })

  test("counts controller-owned private work when balancing a group session", async () => {
    const assignment = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [
        member("controller", true),
        member("delivery-1"),
      ])
      yield* Ref.set(harness.activeJobs, [activeJob("ses_private", "controller", "tg:7")])
      yield* selectSession(harness.selected, conversation, "ses_group")
      return yield* harness.assignments.resolve(conversation, "ses_group", -100)
    }))

    expect(assignment.deliveryBotKey).toBe("delivery-1")
  })

  test("counts each detached non-terminal run instead of collapsing a session", async () => {
    const assignment = await Effect.runPromise(Effect.gen(function* () {
      const harness = yield* makeHarness(new Map(), [member("delivery-1")])
      const activeConversation = "tg:-100:thread:1"
      yield* selectSession(harness.selected, activeConversation, "ses_active_1")
      yield* harness.assignments.resolve(activeConversation, "ses_active_1", -100)
      yield* selectSession(harness.selected, activeConversation, "ses_active_2")
      yield* harness.assignments.resolve(activeConversation, "ses_active_2", -100)
      yield* Ref.set(harness.eligible, [member("controller", true), member("delivery-1")])
      yield* Ref.set(harness.activeJobs, [
        activeJob("ses_detached", "controller", "tg:-100:thread:9", "pending", "job-detached-1"),
        activeJob("ses_detached", "controller", "tg:-100:thread:9", "running", "job-detached-2"),
      ])
      const nextConversation = "tg:-100:thread:2"
      yield* selectSession(harness.selected, nextConversation, "ses_next")
      return yield* harness.assignments.resolve(nextConversation, "ses_next", -100)
    }))

    expect(assignment.deliveryBotKey).toBe("delivery-1")
  })

  test("does not move an unavailable matching owner until its work is terminal", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [
        member("controller", true),
        member("delivery-1"),
      ])
      yield* selectSession(harness.selected, conversation, "ses_1")
      const original = yield* harness.assignments.resolve(conversation, "ses_1", -100)
      yield* Ref.set(harness.eligible, [member("delivery-1")])
      yield* Ref.set(harness.activeJobs, [activeJob("ses_1", original.deliveryBotKey, conversation)])
      const busy = yield* Effect.exit(harness.assignments.resolve(conversation, "ses_1", -100))
      yield* Ref.set(harness.activeJobs, [])
      const moved = yield* harness.assignments.resolve(conversation, "ses_1", -100)
      return { original, busy, moved }
    }))

    expect(result.original.deliveryBotKey).toBe("controller")
    expect(Exit.isFailure(result.busy)).toBe(true)
    if (Exit.isFailure(result.busy)) {
      expect(Cause.pretty(result.busy.cause)).toContain("DeliveryOwnerBusyUnavailable")
    }
    expect(result.moved.deliveryBotKey).toBe("delivery-1")
    expect(result.moved.generation).toBe(result.original.generation + 1)
  })

  test("does not let another topic's delivery bot over-fence a shared session", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [
        member("controller", true),
        member("delivery-1"),
      ])
      yield* selectSession(harness.selected, conversation, "ses_shared")
      const original = yield* harness.assignments.resolve(conversation, "ses_shared", -100)
      yield* Ref.set(harness.eligible, [member("delivery-1")])
      yield* Ref.set(harness.activeJobs, [
        activeJob("ses_shared", "delivery-1", "tg:-100:thread:2"),
      ])
      const moved = yield* harness.assignments.resolve(conversation, "ses_shared", -100)
      return { original, moved }
    }))

    expect(result.original.deliveryBotKey).toBe("controller")
    expect(result.moved.deliveryBotKey).toBe("delivery-1")
  })

  test("treats a legacy non-terminal payload as controller-owned when fencing", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const sessionID = "ses_legacy_job"
      const harness = yield* makeHarness(new Map(), [
        member("controller", true),
        member("delivery-1"),
      ])
      yield* selectSession(harness.selected, conversation, sessionID)
      yield* harness.assignments.resolve(conversation, sessionID, -100)
      yield* Ref.set(harness.eligible, [member("delivery-1")])
      yield* Ref.set(harness.activeJobs, [{
        ...activeJob(sessionID, "controller", conversation),
        payload: JSON.stringify({
          chatId: -100,
          threadId: 1,
          sessionID,
          conversationId: conversation,
        }),
      }])
      return yield* Effect.exit(harness.assignments.resolve(conversation, sessionID, -100))
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("DeliveryOwnerBusyUnavailable")
  })

  test("fences conservatively when a non-terminal owner payload cannot decode", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const sessionID = "ses_invalid_job"
      const harness = yield* makeHarness(new Map(), [
        member("controller", true),
        member("delivery-1"),
      ])
      yield* selectSession(harness.selected, conversation, sessionID)
      yield* harness.assignments.resolve(conversation, sessionID, -100)
      yield* Ref.set(harness.eligible, [member("delivery-1")])
      yield* Ref.set(harness.activeJobs, [{
        ...activeJob(sessionID, "controller", conversation),
        payload: "{invalid-json",
      }])
      return yield* Effect.exit(harness.assignments.resolve(conversation, sessionID, -100))
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("DeliveryOwnerBusyUnavailable")
  })

  test("rejects when no member can serve the target group", async () => {
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [])
      yield* selectSession(harness.selected, conversation, "ses_1")
      return yield* Effect.exit(harness.assignments.resolve(conversation, "ses_1", -100))
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("NoDeliveryBotAvailable")
  })

  test("reloads a worker assignment by stable key", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [member("delivery-1")])
      yield* selectSession(harness.selected, conversation, "ses_1")
      const assigned = yield* harness.assignments.resolve(conversation, "ses_1", -100)
      const reloaded = yield* makeTelegramDeliveryAssignments(
        harness.interaction,
        harness.store,
        harness.jobs,
        harness.pool,
      )
      return { assigned, persisted: yield* reloaded.get(conversation, "ses_1") }
    }))

    expect(result.assigned.deliveryBotKey).toBe("delivery-1")
    expect(Option.getOrUndefined(result.persisted)?.deliveryBotKey).toBe("delivery-1")
  })

  test("clears the active assignment when a session resets or changes directory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const conversation = "tg:-100:thread:1"
      const harness = yield* makeHarness(new Map(), [member("controller", true)])
      yield* selectSession(harness.selected, conversation, "ses_1")
      yield* harness.assignments.resolve(conversation, "ses_1", -100)
      const before = yield* harness.assignments.get(conversation, "ses_1")
      yield* harness.assignments.clear(conversation)
      const after = yield* harness.assignments.get(conversation, "ses_1")
      return { before, after }
    }))

    expect(Option.isSome(result.before)).toBe(true)
    expect(Option.isNone(result.after)).toBe(true)
  })
})
