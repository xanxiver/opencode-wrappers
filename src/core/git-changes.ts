import { Context, Data, Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { logBoundary } from "./logging.js"

/**
 * One changed path in the working tree, with Git's two-character porcelain
 * status column: index (staged) status first, worktree (unstaged) status
 * second. Untracked files use the pair "??".
 */
export interface ChangeFile {
  readonly path: string
  readonly status: string
}

/** Read-only snapshot of the current working-tree changes. */
export interface ChangesSummary {
  /** Current branch name; none while HEAD is detached. */
  readonly branch: Option.Option<string>
  /** Short HEAD commit; none in an unborn repository. */
  readonly commit: Option.Option<string>
  readonly files: readonly ChangeFile[]
  /** Tracked line insertions; none when HEAD cannot be read. */
  readonly insertions: Option.Option<number>
  /** Tracked line deletions; none when HEAD cannot be read. */
  readonly deletions: Option.Option<number>
  /** Number of tracked binary files in the diff. */
  readonly binaryFiles: number
}

/**
 * Whether a changes summary should be shown to the user, and how:
 * - "none" — the directory is not inside a Git repository; show nothing.
 * - "unavailable" — collecting the summary failed. Callers that handle
 *   `GitChangesError` produce this value; the service never returns it.
 * - "summary" — the snapshot collected successfully.
 */
export type ChangesSummaryResult =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "summary"; readonly summary: ChangesSummary }

export class GitChangesError extends Data.TaggedError("GitChangesError")<{
  readonly operation: string
  readonly directory: string
  readonly cause: unknown
}> {}

export interface GitChangesService {
  readonly summarize: (
    directory: string,
  ) => Effect.Effect<ChangesSummaryResult, GitChangesError>
}

export class GitChanges extends Context.Service<GitChanges, GitChangesService>()(
  "opencode2-uis/GitChanges",
) {}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z` output into change
 * files. Rename and copy records carry the source path as the following
 * NUL-delimited token; it is skipped because the destination is the path
 * users act on.
 */
export const parsePorcelainStatus = (output: string): readonly ChangeFile[] => {
  const tokens = output.split("\0")
  const files: ChangeFile[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token.length < 4) continue
    // A porcelain record is two status characters, a space, then the path.
    const status = token.slice(0, 2)
    files.push({ path: token.slice(3), status })
    const statusHasRenameOrCopy = status.charAt(0) === "R" || status.charAt(1) === "R"
      || status.charAt(0) === "C" || status.charAt(1) === "C"
    if (statusHasRenameOrCopy) index += 1
  }
  return files
}

/** Parsed `git diff --numstat -z HEAD --` line totals. */
export interface NumstatTotals {
  readonly insertions: number
  readonly deletions: number
  readonly binaryFiles: number
}

/**
 * Parse NUL-delimited numstat output into tracked line totals. Binary
 * entries report "-" for both counts and are counted separately. Rename
 * records contain extra NUL-delimited path tokens; only the two leading
 * count fields of each record are read.
 */
export const parseNumstat = (output: string): NumstatTotals => {
  let insertions = 0
  let deletions = 0
  let binaryFiles = 0
  for (const token of output.split("\0")) {
    if (token.length === 0) continue
    const fields = token.split("\t")
    const added = fields[0]
    const removed = fields[1]
    if (added === undefined || removed === undefined) continue
    if (added === "-" || removed === "-") {
      binaryFiles += 1
      continue
    }
    const addedCount = Number(added)
    const removedCount = Number(removed)
    if (Number.isSafeInteger(addedCount)) insertions += addedCount
    if (Number.isSafeInteger(removedCount)) deletions += removedCount
  }
  return { insertions, deletions, binaryFiles }
}

/**
 * Read-only working-tree snapshot backed by the `git` CLI. Commands run in
 * the selected directory with no shell; arguments are passed directly and
 * file contents are never read or transmitted.
 */
export const GitChangesLive: Layer.Layer<GitChanges, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    GitChanges,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const gitString = (directory: string, args: readonly string[]): Effect.Effect<string, GitChangesError> =>
        spawner.string(
          ChildProcess.make("git", [...args], { cwd: directory, extendEnv: true, stdin: "ignore" }),
        ).pipe(
          Effect.mapError((cause) => new GitChangesError({ operation: args[0] ?? "git", directory, cause })),
        )

      const insideWorkTree = (directory: string): Effect.Effect<boolean, GitChangesError> =>
        spawner.exitCode(
          ChildProcess.make("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: directory,
            extendEnv: true,
            stdin: "ignore",
          }),
        ).pipe(
          Effect.map((code) => code === ChildProcessSpawner.ExitCode(0)),
          Effect.mapError((cause) => new GitChangesError({ operation: "rev-parse", directory, cause })),
        )

      const summarize = Effect.fn("GitChanges.summarize")((directory: string) =>
        Effect.gen(function* () {
          const inside = yield* insideWorkTree(directory)
          if (!inside) return { kind: "none" } as const
          const statusOutput = yield* gitString(directory, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ])
          // Branch and commit are cosmetic; treat their failures as missing
          // values instead of failing the whole summary.
          const branch = yield* gitString(directory, ["branch", "--show-current"]).pipe(
            Effect.map((name) => {
              const trimmed = name.trim()
              return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed)
            }),
            Effect.catchCause(() => Effect.succeed(Option.none<string>())),
          )
          const commit = yield* gitString(directory, ["rev-parse", "--short", "HEAD"]).pipe(
            Effect.map((value) => {
              const trimmed = value.trim()
              return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed)
            }),
            Effect.catchCause(() => Effect.succeed(Option.none<string>())),
          )
          // Line statistics need a HEAD commit. An unborn repository has no
          // HEAD; a failed read produces the same "no statistics" result.
          const stats = yield* Option.match(commit, {
            onNone: () => Effect.succeed(Option.none<NumstatTotals>()),
            onSome: () =>
              gitString(directory, ["diff", "--numstat", "-z", "HEAD", "--"]).pipe(
                Effect.map((value) => Option.some(parseNumstat(value))),
                Effect.catchCause((cause) =>
                  logBoundary("core/git-changes", "git", "tracked diff statistics unavailable")(cause).pipe(
                    Effect.as(Option.none<NumstatTotals>()),
                  ),
                ),
              ),
          })
          return {
            kind: "summary",
            summary: {
              branch,
              commit,
              files: parsePorcelainStatus(statusOutput),
              insertions: Option.map(stats, (value) => value.insertions),
              deletions: Option.map(stats, (value) => value.deletions),
              binaryFiles: Option.match(stats, { onNone: () => 0, onSome: (value) => value.binaryFiles }),
            },
          } as const
        }),
      )

      return GitChanges.of({ summarize })
    }),
  )
