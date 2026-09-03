import { describe, expect, test } from "bun:test"
import {
  appendStreamTextDelta,
  appendStreamTextRecoveryDelta,
  beginStreamTextPart,
  beginStreamTextRecoveryPart,
  makeStreamTextRecoveryState,
  recoverStreamText,
  restartStreamTextRecovery,
  type StreamTextPartIdentity,
  type StreamTextState,
} from "../src/core/stream-text.js"

describe("stream text", () => {
  test("keeps deltas contiguous and separates new text parts", () => {
    let state = beginStreamTextPart({ text: "", startsNewPart: false, activePartIdentity: undefined })
    state = appendStreamTextDelta(state, "First")
    state = appendStreamTextDelta(state, " paragraph.")
    state = beginStreamTextPart(state)
    state = appendStreamTextDelta(state, "Second paragraph.")

    expect(state).toEqual({
      text: "First paragraph.\n\nSecond paragraph.",
      startsNewPart: false,
      activePartIdentity: undefined,
    })
  })

  test("keeps a part boundary pending after an empty delta", () => {
    let state = beginStreamTextPart({ text: "First paragraph.", startsNewPart: false, activePartIdentity: undefined })
    state = appendStreamTextDelta(state, "")
    state = appendStreamTextDelta(state, "Second paragraph.")

    expect(state.text).toBe("First paragraph.\n\nSecond paragraph.")
  })

  test("uses a delta identity when a part-start event is missing", () => {
    const first = { assistantMessageID: "assistant-1", ordinal: 0 }
    const second = { assistantMessageID: "assistant-1", ordinal: 1 }
    let state = beginStreamTextPart({ text: "", startsNewPart: false, activePartIdentity: undefined }, first)
    state = appendStreamTextDelta(state, "First paragraph.", first)
    state = appendStreamTextDelta(state, "Second paragraph.", second)

    expect(state.text).toBe("First paragraph.\n\nSecond paragraph.")
  })

  test("ignores a repeated part-start event for the active identity", () => {
    const part = { assistantMessageID: "assistant-1", ordinal: 0 }
    let state = beginStreamTextPart({ text: "", startsNewPart: false, activePartIdentity: undefined }, part)
    state = appendStreamTextDelta(state, "First", part)
    state = beginStreamTextPart(state, part)
    state = appendStreamTextDelta(state, " paragraph.", part)

    expect(state.text).toBe("First paragraph.")
  })

  test("keeps live text that arrives after recovery starts", () => {
    const first = { assistantMessageID: "assistant-1", ordinal: 0 }
    const second = { assistantMessageID: "assistant-1", ordinal: 1 }
    let stream: StreamTextState = { text: "", startsNewPart: false, activePartIdentity: undefined }
    let recovery = makeStreamTextRecoveryState()
    const startPart = (identity: StreamTextPartIdentity): void => {
      stream = beginStreamTextPart(stream, identity)
      recovery = beginStreamTextRecoveryPart(recovery, identity)
    }
    const append = (identity: StreamTextPartIdentity, delta: string): void => {
      stream = appendStreamTextDelta(stream, delta, identity)
      recovery = appendStreamTextRecoveryDelta(recovery, delta, identity)
    }
    startPart(first)
    append(first, "First")
    append(first, " paragraph.")
    startPart(second)
    append(second, "Second")

    const result = recoverStreamText(stream, recovery, "First paragraph.", [
      { ...first, text: "First paragraph." },
    ])

    expect(result.stream).toEqual({
      text: "First paragraph.\n\nSecond",
      startsNewPart: false,
      activePartIdentity: second,
    })
  })

  test("does not repeat a recovered partial part", () => {
    const first = { assistantMessageID: "assistant-1", ordinal: 0 }
    const second = { assistantMessageID: "assistant-1", ordinal: 1 }
    let recovery = beginStreamTextRecoveryPart(makeStreamTextRecoveryState(), second)
    recovery = appendStreamTextRecoveryDelta(recovery, "Sec", second)
    recovery = appendStreamTextRecoveryDelta(recovery, "ond paragraph.", second)

    const result = recoverStreamText(
      { text: "Second paragraph.", startsNewPart: false, activePartIdentity: second },
      recovery,
      "First paragraph.\n\nSec",
      [
        { ...first, text: "First paragraph." },
        { ...second, text: "Sec" },
      ],
    )

    expect(result.stream.text).toBe("First paragraph.\n\nSecond paragraph.")
  })

  test("merges a recovered prefix with deltas received after reconnect", () => {
    const part = { assistantMessageID: "assistant-1", ordinal: 0 }
    const recovery = appendStreamTextRecoveryDelta(makeStreamTextRecoveryState(), " paragraph.", part)
    const result = recoverStreamText(
      { text: " paragraph.", startsNewPart: false, activePartIdentity: part },
      recovery,
      "First",
      [{ ...part, text: "First" }],
    )

    expect(result.stream.text).toBe("First paragraph.")
  })

  test("uses a newer recovered empty part as the pending boundary", () => {
    const first = { assistantMessageID: "assistant-1", ordinal: 0 }
    const second = { assistantMessageID: "assistant-1", ordinal: 1 }
    let recovery = beginStreamTextRecoveryPart(makeStreamTextRecoveryState(), first)
    recovery = appendStreamTextRecoveryDelta(recovery, "First paragraph.", first)

    const result = recoverStreamText(
      { text: "First paragraph.", startsNewPart: false, activePartIdentity: first },
      recovery,
      "First paragraph.",
      [
        { ...first, text: "First paragraph." },
        { ...second, text: "" },
      ],
    )

    expect(result.stream).toEqual({ text: "First paragraph.", startsNewPart: true, activePartIdentity: second })
  })

  test("keeps a reconnect baseline when recovery returns an older prefix", () => {
    const part = { assistantMessageID: "assistant-1", ordinal: 0 }
    let recovery = beginStreamTextRecoveryPart(makeStreamTextRecoveryState(), part)
    recovery = appendStreamTextRecoveryDelta(recovery, "Second paragraph.", part)
    recovery = restartStreamTextRecovery(recovery)
    recovery = appendStreamTextRecoveryDelta(recovery, " More text.", part)

    const result = recoverStreamText(
      { text: "Second paragraph. More text.", startsNewPart: false, activePartIdentity: part },
      recovery,
      "Sec",
      [{ ...part, text: "Sec" }],
    )

    expect(result.stream.text).toBe("Second paragraph. More text.")
  })

  test("keeps a reconnect suffix that repeats earlier recovered text", () => {
    const part = { assistantMessageID: "assistant-1", ordinal: 0 }
    let recovery = beginStreamTextRecoveryPart(makeStreamTextRecoveryState(), part)
    recovery = appendStreamTextRecoveryDelta(recovery, "Read the answer and", part)
    recovery = restartStreamTextRecovery(recovery)
    recovery = appendStreamTextRecoveryDelta(recovery, " the", part)

    const result = recoverStreamText(
      { text: "Read the answer and the", startsNewPart: false, activePartIdentity: part },
      recovery,
      "Read the answer and",
      [{ ...part, text: "Read the answer and" }],
    )

    expect(result.stream.text).toBe("Read the answer and the")
  })
})
