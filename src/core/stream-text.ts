export interface StreamTextState {
  readonly text: string
  readonly startsNewPart: boolean
  readonly activePartIdentity: StreamTextPartIdentity | undefined
}

export interface StreamTextPartIdentity {
  readonly assistantMessageID: string
  readonly ordinal: number
}

export interface StreamTextPartSnapshot extends StreamTextPartIdentity {
  readonly text: string
}

export interface StreamTextRecoveryPart {
  readonly key: string
  readonly identity: StreamTextPartIdentity | undefined
  readonly text: string
  readonly startsAtBeginning: boolean
  readonly baseline: string | undefined
}

export interface StreamTextRecoveryState {
  readonly parts: readonly StreamTextRecoveryPart[]
  readonly activeKey: string | undefined
  readonly nextAnonymousPart: number
}

export interface StreamTextRecoveryResult {
  readonly stream: StreamTextState
  readonly recovery: StreamTextRecoveryState
}

export const makeStreamTextRecoveryState = (): StreamTextRecoveryState => ({
  parts: [],
  activeKey: undefined,
  nextAnonymousPart: 0,
})

export const joinTextParts = (parts: readonly string[]): string =>
  parts.filter((part) => part.length > 0).join("\n\n")

const samePartIdentity = (
  left: StreamTextPartIdentity | undefined,
  right: StreamTextPartIdentity,
): boolean => left?.assistantMessageID === right.assistantMessageID && left.ordinal === right.ordinal

export const beginStreamTextPart = (
  state: StreamTextState,
  identity: StreamTextPartIdentity | undefined = undefined,
): StreamTextState => {
  if (identity !== undefined && samePartIdentity(state.activePartIdentity, identity)) return state
  if (state.startsNewPart && state.activePartIdentity === identity) return state
  return { ...state, startsNewPart: true, activePartIdentity: identity }
}

export const appendStreamTextDelta = (
  state: StreamTextState,
  delta: string,
  identity: StreamTextPartIdentity | undefined = undefined,
): StreamTextState => {
  let identified = state
  if (identity !== undefined && !samePartIdentity(state.activePartIdentity, identity)) {
    identified = state.activePartIdentity === undefined
      ? { ...state, activePartIdentity: identity }
      : beginStreamTextPart(state, identity)
  }
  if (delta.length === 0) return identified
  const separator = identified.startsNewPart && identified.text.length > 0 ? "\n\n" : ""
  return {
    text: `${identified.text}${separator}${delta}`,
    startsNewPart: false,
    activePartIdentity: identified.activePartIdentity,
  }
}

const identifiedPartKey = (identity: StreamTextPartIdentity): string =>
  `${identity.assistantMessageID.length}:${identity.assistantMessageID}:${identity.ordinal}`

const recoveryPart = (
  key: string,
  identity: StreamTextPartIdentity | undefined,
  startsAtBeginning: boolean,
): StreamTextRecoveryPart => ({ key, identity, text: "", startsAtBeginning, baseline: undefined })

export const restartStreamTextRecovery = (state: StreamTextRecoveryState): StreamTextRecoveryState => {
  if (state.activeKey === undefined) return state
  return {
    ...state,
    parts: state.parts.map((part) =>
      part.key === state.activeKey && part.baseline === undefined
        ? { ...part, baseline: part.text }
        : part
    ),
  }
}

export const beginStreamTextRecoveryPart = (
  state: StreamTextRecoveryState,
  identity: StreamTextPartIdentity | undefined,
): StreamTextRecoveryState => {
  if (identity !== undefined) {
    const key = identifiedPartKey(identity)
    const existing = state.parts.find((part) => part.key === key)
    if (existing !== undefined) return state.activeKey === key ? state : { ...state, activeKey: key }
    return { ...state, parts: [...state.parts, recoveryPart(key, identity, true)], activeKey: key }
  }
  const active = state.parts.find((part) => part.key === state.activeKey)
  if (active !== undefined && active.identity === undefined && active.text.length === 0) return state
  const key = `anonymous:${state.nextAnonymousPart}`
  return {
    parts: [...state.parts, recoveryPart(key, undefined, true)],
    activeKey: key,
    nextAnonymousPart: state.nextAnonymousPart + 1,
  }
}

export const appendStreamTextRecoveryDelta = (
  state: StreamTextRecoveryState,
  delta: string,
  identity: StreamTextPartIdentity | undefined,
): StreamTextRecoveryState => {
  if (delta.length === 0) return state
  const identifiedKey = identity === undefined ? undefined : identifiedPartKey(identity)
  const key = identifiedKey ?? state.activeKey ?? `anonymous:${state.nextAnonymousPart}`
  const existing = state.parts.find((part) => part.key === key)
  const parts = existing === undefined
    ? [...state.parts, { ...recoveryPart(key, identity, false), text: delta }]
    : state.parts.map((part) => part.key === key ? { ...part, text: part.text + delta } : part)
  return {
    parts,
    activeKey: key,
    nextAnonymousPart: existing === undefined && identifiedKey === undefined
      ? state.nextAnonymousPart + 1
      : state.nextAnonymousPart,
  }
}

const mergeCompletePart = (recovered: string, live: string): string => {
  if (recovered.startsWith(live)) return recovered
  if (live.startsWith(recovered)) return live
  return live.length > 0 ? live : recovered
}

const suffixOverlap = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length)
  for (let size = limit; size > 0; size -= 1) {
    if (left.endsWith(right.slice(0, size))) return size
  }
  return 0
}

const mergeSuffixPart = (recovered: string, live: string): string => {
  if (live.length === 0 || recovered.endsWith(live)) return recovered
  return recovered + live.slice(suffixOverlap(recovered, live))
}

const mergeAnchoredPart = (recovered: string, baseline: string, live: string): string => {
  const suffix = live.slice(baseline.length)
  if (baseline.startsWith(recovered)) return live
  if (!recovered.startsWith(baseline)) return mergeSuffixPart(recovered, suffix)
  const recoveredSuffix = recovered.slice(baseline.length)
  if (recoveredSuffix.startsWith(suffix)) return recovered
  if (suffix.startsWith(recoveredSuffix)) return baseline + suffix
  return recovered + suffix.slice(suffixOverlap(recoveredSuffix, suffix))
}

const insertRecoveredPart = (
  parts: readonly StreamTextRecoveryPart[],
  snapshot: StreamTextPartSnapshot,
): readonly StreamTextRecoveryPart[] => {
  const key = identifiedPartKey(snapshot)
  const existing = parts.find((part) => part.key === key)
  if (existing !== undefined) {
    let text = mergeSuffixPart(snapshot.text, existing.text)
    if (existing.baseline !== undefined) text = mergeAnchoredPart(snapshot.text, existing.baseline, existing.text)
    else if (existing.startsAtBeginning) text = mergeCompletePart(snapshot.text, existing.text)
    return parts.map((part) => part.key === key
      ? { ...part, text, startsAtBeginning: true, baseline: undefined }
      : part)
  }
  const identity = { assistantMessageID: snapshot.assistantMessageID, ordinal: snapshot.ordinal }
  const part = { ...recoveryPart(key, identity, true), text: snapshot.text }
  const nextIndex = parts.findIndex((candidate) =>
    candidate.identity?.assistantMessageID === snapshot.assistantMessageID &&
    candidate.identity.ordinal > snapshot.ordinal
  )
  if (nextIndex >= 0) return [...parts.slice(0, nextIndex), part, ...parts.slice(nextIndex)]
  const previousIndex = parts.findLastIndex((candidate) =>
    candidate.identity?.assistantMessageID === snapshot.assistantMessageID
  )
  if (previousIndex < 0) return [...parts, part]
  return [...parts.slice(0, previousIndex + 1), part, ...parts.slice(previousIndex + 1)]
}

export const recoverStreamText = (
  stream: StreamTextState,
  recovery: StreamTextRecoveryState,
  recoveredText: string,
  recoveredParts: readonly StreamTextPartSnapshot[],
): StreamTextRecoveryResult => {
  if (recoveredParts.length === 0) {
    return {
      stream: { ...stream, text: stream.text.startsWith(recoveredText) ? stream.text : recoveredText },
      recovery,
    }
  }
  const latestRecoveredPart = recoveredParts.at(-1)
  if (latestRecoveredPart === undefined) return { stream, recovery }
  const parts = recoveredParts.reduce(insertRecoveredPart, recovery.parts)
  const recoveredActiveKey = identifiedPartKey(latestRecoveredPart)
  const currentActiveIndex = parts.findIndex((part) => part.key === recovery.activeKey)
  const recoveredActiveIndex = parts.findIndex((part) => part.key === recoveredActiveKey)
  const activeKey = currentActiveIndex > recoveredActiveIndex ? recovery.activeKey : recoveredActiveKey
  const active = parts.find((part) => part.key === activeKey)
  return {
    stream: {
      text: joinTextParts(parts.map((part) => part.text)),
      startsNewPart: active?.text.length === 0,
      activePartIdentity: active === undefined ? stream.activePartIdentity : active.identity,
    },
    recovery: { ...recovery, parts, activeKey },
  }
}
