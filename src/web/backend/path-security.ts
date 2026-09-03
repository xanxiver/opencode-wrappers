import { isAbsolute, relative } from "node:path"

/** Return true when a resolved path is the root itself or a descendant. */
export const isPathInsideRoots = (candidate: string, roots: readonly string[]): boolean =>
  roots.some((root) => {
    const rest = relative(root, candidate)
    return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest))
  })
