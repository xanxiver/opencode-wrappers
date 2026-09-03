export const originFromReferer = (referer: string | undefined): string | undefined => {
  if (referer === undefined) return undefined
  try {
    return new URL(referer).origin
  } catch {
    return undefined
  }
}

/** Check an exact request origin for cookie-authenticated mutations. */
export const isTrustedOrigin = (
  origin: string | undefined,
  host: string | undefined,
  trustedOrigins: readonly string[],
): boolean => {
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    return parsed.host === host || trustedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}
