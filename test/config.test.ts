import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { expandHome } from "../src/config.js"

describe("expandHome", () => {
  test("expands a leading tilde", () => {
    expect(expandHome("~/Projects")).toBe(`${homedir()}/Projects`)
    expect(expandHome("~/x/y")).toBe(`${homedir()}/x/y`)
  })

  test("keeps absolute paths", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x")
  })

  test("resolves relative paths against the cwd", () => {
    expect(expandHome("data/state.json")).toBe(`${process.cwd()}/data/state.json`)
  })

  test("leaves plain tilde-expansion untouched for non-tilde values", () => {
    expect(expandHome(".")).toBe(process.cwd())
  })
})
