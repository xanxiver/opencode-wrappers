import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { collectPrimarySessionPage, moveSessionPage, primarySessions } from "../src/telegram/handlers/picker.js"
import { Option } from "effect"

describe("Telegram session picker", () => {
  test("hides subagent sessions", () => {
    expect(primarySessions([
      { id: "main" },
      { id: "child", parentID: "main" },
      { id: "another" },
    ])).toEqual([{ id: "main" }, { id: "another" }])
  })

  test("starts cursor navigation at the selected cursor", async () => {
    const cursors: Array<string | undefined> = []
    const page = await Effect.runPromise(collectPrimarySessionPage((cursor) => {
      cursors.push(cursor)
      return Effect.succeed({ data: [{ id: "next-page" }] })
    }, "next-cursor"))

    expect(cursors).toEqual(["next-cursor"])
    expect(page.data.map((session) => session.id)).toEqual(["next-page"])
  })

  test("does not skip sessions while filling a page across child sessions", async () => {
    const sessions = [
      { id: "child", parentID: "parent" },
      { id: "one" },
      { id: "two" },
      { id: "three" },
      { id: "four" },
      { id: "five" },
      { id: "six" },
    ]
    const fetchPage = (cursor: string | undefined, limit: number) => {
      const start = cursor === undefined ? 0 : Number(cursor)
      const data = sessions.slice(start, start + limit)
      const next = start + data.length < sessions.length ? String(start + data.length) : undefined
      return Effect.succeed({ data, next })
    }

    const first = await Effect.runPromise(collectPrimarySessionPage(fetchPage))
    const second = await Effect.runPromise(collectPrimarySessionPage(fetchPage, first.next))

    expect(first.data.map((session) => session.id)).toEqual(["one", "two", "three", "four", "five"])
    expect(second.data.map((session) => session.id)).toEqual(["six"])
  })

  test("returns to the exact logical page after crossing child-only API pages", async () => {
    const sessions = [
      { id: "one" }, { id: "two" }, { id: "three" }, { id: "four" }, { id: "five" },
      { id: "child-a", parentID: "one" }, { id: "child-b", parentID: "one" },
      { id: "six" }, { id: "seven" }, { id: "eight" }, { id: "nine" }, { id: "ten" },
      { id: "eleven" },
    ]
    const fetchPage = (cursor: string | undefined, limit: number) => {
      const start = cursor === undefined ? 0 : Number(cursor)
      const data = sessions.slice(start, start + limit)
      const next = start + data.length < sessions.length ? String(start + data.length) : undefined
      return Effect.succeed({ data, next })
    }

    const first = await Effect.runPromise(collectPrimarySessionPage(fetchPage))
    const secondTarget = Option.getOrThrow(moveSessionPage(
      { current: {}, history: [], next: first.next },
      "next",
    ))
    const second = await Effect.runPromise(collectPrimarySessionPage(fetchPage, secondTarget.current.cursor))
    const thirdTarget = Option.getOrThrow(moveSessionPage(
      { ...secondTarget, next: second.next },
      "next",
    ))
    const backTarget = Option.getOrThrow(moveSessionPage(
      { ...thirdTarget, next: undefined },
      "previous",
    ))
    const returned = await Effect.runPromise(collectPrimarySessionPage(fetchPage, backTarget.current.cursor))

    expect(second.data.map((session) => session.id)).toEqual(["six", "seven", "eight", "nine", "ten"])
    expect(returned.data).toEqual(second.data)
  })
})
