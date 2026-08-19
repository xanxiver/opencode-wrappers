import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"
import {
  GitChanges,
  GitChangesLive,
  parseNumstat,
  parsePorcelainStatus,
  type ChangesSummary,
  type ChangesSummaryResult,
} from "../src/core/git-changes.js"

const created: string[] = []

const git = (directory: string, args: readonly string[]): string => {
  const result = spawnSync("git", [...args], { cwd: directory, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`)
  }
  return result.stdout.trim()
}

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-git-changes-"))
  created.push(directory)
  return directory
}

const makeRepo = (): string => {
  const directory = makeDirectory()
  git(directory, ["init", "-q"])
  git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"])
  git(directory, ["config", "user.email", "test@example.com"])
  git(directory, ["config", "user.name", "Test"])
  writeFileSync(join(directory, "a.txt"), "one\n")
  writeFileSync(join(directory, "b.txt"), "two\n")
  git(directory, ["add", "."])
  git(directory, ["commit", "-qm", "initial"])
  return directory
}

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true })
})

const summarize = async (directory: string): Promise<ChangesSummaryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const gitChanges = yield* GitChanges
      return yield* gitChanges.summarize(directory)
    }).pipe(
      Effect.provide(GitChangesLive),
      Effect.provide(BunChildProcessSpawner.layer),
      Effect.provide(BunFileSystem.layer),
      Effect.provide(BunPath.layer),
    ),
  )

const expectSummary = (result: ChangesSummaryResult): ChangesSummary => {
  if (result.kind !== "summary") throw new Error(`expected a summary, got kind ${result.kind}`)
  return result.summary
}

describe("GitChanges.summarize", () => {
  test("reports a clean repository", async () => {
    const summary = expectSummary(await summarize(makeRepo()))
    expect(summary.files).toEqual([])
    expect(summary.branch).toEqual(Option.some("main"))
    expect(Option.isSome(summary.commit)).toBe(true)
    expect(summary.insertions).toEqual(Option.some(0))
    expect(summary.deletions).toEqual(Option.some(0))
    expect(summary.binaryFiles).toBe(0)
  })

  test("reports an unstaged modification with line totals", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "a.txt"), "one\nchanged\n")
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "a.txt", status: " M" }])
    expect(summary.insertions).toEqual(Option.some(1))
    expect(summary.deletions).toEqual(Option.some(0))
  })

  test("reports a staged modification", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "a.txt"), "one\nchanged\n")
    git(directory, ["add", "a.txt"])
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "a.txt", status: "M " }])
  })

  test("reports combined staged and unstaged state", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "a.txt"), "one\n\n")
    git(directory, ["add", "a.txt"])
    writeFileSync(join(directory, "a.txt"), "one\n\n\n")
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "a.txt", status: "MM" }])
  })

  test("reports untracked files", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "new.txt"), "hello\n")
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "new.txt", status: "??" }])
  })

  test("reports staged and unstaged deletions", async () => {
    const directory = makeRepo()
    git(directory, ["rm", "-q", "b.txt"])
    rmSync(join(directory, "a.txt"))
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toContainEqual({ path: "a.txt", status: " D" })
    expect(summary.files).toContainEqual({ path: "b.txt", status: "D " })
  })

  test("reports a renamed file without duplicating the source path", async () => {
    const directory = makeRepo()
    git(directory, ["mv", "a.txt", "renamed.txt"])
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "renamed.txt", status: "R " }])
  })

  test("counts tracked binary files", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "logo.png"), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    git(directory, ["add", "logo.png"])
    git(directory, ["commit", "-qm", "add binary"])
    writeFileSync(join(directory, "logo.png"), Buffer.from([0x00, 0x09, 0x09, 0x08]))
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "logo.png", status: " M" }])
    expect(summary.binaryFiles).toBe(1)
    expect(summary.insertions).toEqual(Option.some(0))
    expect(summary.deletions).toEqual(Option.some(0))
  })

  test("preserves filenames with spaces", async () => {
    const directory = makeRepo()
    writeFileSync(join(directory, "my file.txt"), "hello\n")
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "my file.txt", status: "??" }])
  })

  test("reports a detached HEAD without a branch", async () => {
    const directory = makeRepo()
    git(directory, ["checkout", "-q", "--detach"])
    const summary = expectSummary(await summarize(directory))
    expect(summary.branch).toEqual(Option.none())
    expect(Option.isSome(summary.commit)).toBe(true)
  })

  test("returns none outside a git repository", async () => {
    const result = await summarize(makeDirectory())
    expect(result.kind).toBe("none")
  })

  test("lists untracked files in an unborn repository without line statistics", async () => {
    const directory = makeDirectory()
    git(directory, ["init", "-q"])
    git(directory, ["symbolic-ref", "HEAD", "refs/heads/main"])
    writeFileSync(join(directory, "first.txt"), "hello\n")
    const summary = expectSummary(await summarize(directory))
    expect(summary.files).toEqual([{ path: "first.txt", status: "??" }])
    expect(summary.commit).toEqual(Option.none())
    expect(summary.insertions).toEqual(Option.none())
    expect(summary.deletions).toEqual(Option.none())
  })
})

describe("Git status and diff parsing", () => {
  test("parsePorcelainStatus handles staged, untracked, and renamed records", () => {
    const files = parsePorcelainStatus("M  src/a.ts\0?? new.txt\0R  dest.ts\0source.ts\0")
    expect(files).toEqual([
      { path: "src/a.ts", status: "M " },
      { path: "new.txt", status: "??" },
      { path: "dest.ts", status: "R " },
    ])
  })

  test("parseNumstat sums tracked lines and counts binary entries", () => {
    const totals = parseNumstat("1\t0\tsrc/a.ts\x00-\t-\tlogo.png\x002\t3\tsrc/b.ts\x00")
    expect(totals).toEqual({ insertions: 3, deletions: 3, binaryFiles: 1 })
  })
})
