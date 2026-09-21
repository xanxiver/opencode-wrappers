import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import type { FormInfo, OpenCodeEvent, PermissionRequest } from "@opencode/client"
import { AppConfig, AppConfigTag } from "../src/config.js"
import {
  Live as OpenCodeLive,
  normalizeBaseUrl,
  OpenCode,
  projectDirectories,
  questionFormAnswer,
  questionRequestFromEvent,
  questionRequestFromForm,
  shouldDiscoverOpenCodeService,
} from "../src/core/opencode.js"
import { makeSessionInfo } from "./opencode-fixtures.js"

const questionForm = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "hidden-string",
      type: "string",
      hidden: true,
      default: "server-default",
    },
    {
      key: "q0",
      title: "Choice",
      description: "Choose one",
      type: "string",
      options: [
        { value: "alpha-value", label: "Alpha", description: "Choose alpha" },
        { value: "beta-value", label: "Beta" },
      ],
      custom: true,
    },
    {
      key: "hidden-tags",
      type: "multiselect",
      hidden: true,
      options: [{ value: "internal", label: "Internal" }],
      default: ["internal"],
    },
    {
      key: "q1",
      title: "Tags",
      description: "Choose several",
      type: "multiselect",
      options: [
        { value: "one-value", label: "One" },
        { value: "two-value", label: "Two" },
      ],
      custom: false,
      hidden: false,
    },
  ],
} satisfies FormInfo

describe("normalizeBaseUrl", () => {
  test("adds HTTP to a discovered host and port", async () => {
    const result = await Effect.runPromise(normalizeBaseUrl("127.0.0.1:49374"))
    expect(result).toBe("http://127.0.0.1:49374")
  })

  test("keeps explicit HTTP and HTTPS URLs", async () => {
    expect(await Effect.runPromise(normalizeBaseUrl("http://localhost:4096"))).toBe(
      "http://localhost:4096",
    )
    expect(await Effect.runPromise(normalizeBaseUrl("https://opencode.example.com"))).toBe(
      "https://opencode.example.com",
    )
  })

  test("rejects unsupported URL protocols", async () => {
    await expect(Effect.runPromise(normalizeBaseUrl("file:///tmp/opencode"))).rejects.toMatchObject({
      operation: "endpoint.url",
    })
  })
})

describe("shouldDiscoverOpenCodeService", () => {
  test("does not discover when an explicit endpoint is configured", () => {
    expect(shouldDiscoverOpenCodeService("https://opencode.example.com")).toBe(false)
  })

  test("discovers when no endpoint is configured", () => {
    expect(shouldDiscoverOpenCodeService(undefined)).toBe(true)
  })
})

describe("projectDirectories", () => {
  test("uses the canonical checkout and sandboxes from the V2 project payload", () => {
    expect(projectDirectories({
      canonical: "/workspace/project",
      sandboxes: ["/workspace/project-a", "/workspace/project-b"],
    })).toEqual([
      { directory: "/workspace/project", strategy: "canonical" },
      { directory: "/workspace/project-a", strategy: "sandbox" },
      { directory: "/workspace/project-b", strategy: "sandbox" },
    ])
  })
})

describe("question form compatibility", () => {
  test("normalizes only visible V2 question fields for existing clients", () => {
    expect(questionRequestFromForm(questionForm)).toEqual({
      id: "frm_1",
      sessionID: "ses_1",
      questions: [
        {
          header: "Choice",
          question: "Choose one",
          options: [
            { label: "Alpha", description: "Choose alpha" },
            { label: "Beta", description: "" },
          ],
          custom: true,
          multiple: false,
        },
        {
          header: "Tags",
          question: "Choose several",
          options: [
            { label: "One", description: "" },
            { label: "Two", description: "" },
          ],
          custom: false,
          multiple: true,
        },
      ],
    })
  })

  test("ignores forms that were not created by the question tool", () => {
    expect(questionRequestFromForm({ ...questionForm, metadata: { kind: "other" } })).toBeUndefined()
  })

  test("ignores forms with no visible questions", () => {
    expect(questionRequestFromForm({
      ...questionForm,
      fields: [{ key: "hidden", type: "string", hidden: true, default: "internal" }],
    })).toBeUndefined()
  })

  test("normalizes question events like pending forms", () => {
    expect(questionRequestFromEvent({
      id: "evt_1",
      created: 1,
      type: "form.created",
      location: { directory: "/workspace" },
      data: { form: questionForm },
    })).toEqual(questionRequestFromForm(questionForm))
  })

  test("maps visible answers to form keys without overriding hidden defaults", () => {
    expect(questionFormAnswer(questionForm, [["Beta"], ["One", "custom"]])).toEqual({
      q0: "beta-value",
      q1: ["one-value", "custom"],
    })
  })
})

describe("OpenCode client compatibility", () => {
  test("uses V2 form and permission contracts and interrupts an idle event stream", async () => {
    const session = makeSessionInfo({ id: "ses_1", location: { directory: "/workspace" } })
    const permission: PermissionRequest = {
      id: "per_1",
      sessionID: "ses_1",
      action: "shell",
      resources: ["bun test"],
    }
    const replies: { path: string; body: unknown }[] = []
    const requestLocations: (string | null)[] = []
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.headers.get("authorization") !== "Basic dXNlcjpwYXNz") {
          return Response.json({ message: "Authentication is required." }, { status: 401 })
        }
        const url = new URL(request.url)
        const path = url.pathname
        if (path === "/api/session/ses_1") return Response.json({ data: session })
        if (request.method === "GET" && (path === "/api/form" || path === "/api/permission/request")) {
          requestLocations.push(url.searchParams.get("location[directory]"))
          return Response.json({
            location: { directory: "/workspace" },
            data: path === "/api/form" ? [questionForm] : [permission],
          })
        }
        if (request.method === "GET" && path === "/api/session/ses_1/form/frm_1") {
          return Response.json({ data: { ...questionForm, state: { status: "pending" } } })
        }
        if (request.method === "POST" && (
          path === "/api/session/ses_1/form/frm_1/reply" ||
          path === "/api/session/ses_1/permission/per_1/reply"
        )) {
          replies.push({ path, body: await request.json() })
          return new Response(null, { status: 204 })
        }
        if (path === "/api/event") {
          return new Response(new ReadableStream({
            start: (controller) => {
              controller.enqueue(encoder.encode('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n'))
            },
          }), {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return Response.json({ message: "The test request is not supported." }, { status: 404 })
      },
    })
    try {
      const config = Layer.succeed(AppConfigTag, new AppConfig({
        opencodeBaseUrl: server.url.toString(),
        opencodeUsername: "user",
        opencodePassword: "pass",
        projectDirectory: "/workspace",
        stateFile: "/tmp/opencode/client-test-state.json",
        webDatabaseFile: "/tmp/opencode/client-test-web.sqlite",
        telegramRunTimeout: "10 minutes",
        webPort: 3001,
      }))
      const result = await Effect.runPromise(Effect.gen(function* () {
        const opencode = yield* OpenCode
        const received = yield* Deferred.make<OpenCodeEvent>()
        const eventFiber = yield* opencode.events().pipe(
          Stream.tap((event) => Deferred.succeed(received, event)),
          Stream.runDrain,
          Effect.forkChild,
        )
        const event = yield* Deferred.await(received)
        yield* Fiber.interrupt(eventFiber).pipe(Effect.timeout("1 second"))
        const questions = yield* opencode.listPendingQuestions("/workspace")
        const permissions = yield* opencode.listPendingPermissions("/workspace")
        yield* opencode.replyQuestion({
          sessionID: "ses_1",
          requestID: "frm_1",
          answers: [["Beta"], ["One", "custom"]],
        })
        yield* opencode.replyPermission({ sessionID: "ses_1", requestID: "per_1", reply: "once" })
        return {
          session: yield* opencode.getSession("ses_1"),
          event,
          questions,
          permissions,
        }
      }).pipe(
        Effect.provide(OpenCodeLive.pipe(Layer.provide(config))),
      ))

      expect(result.session).toEqual(session)
      expect(result.questions).toMatchObject([{
        id: "frm_1",
        sessionID: "ses_1",
        questions: [{ question: "Choose one" }, { question: "Choose several" }],
      }])
      expect(result.permissions).toEqual([permission])
      expect(requestLocations).toEqual(["/workspace", "/workspace"])
      expect(replies).toEqual([
        {
          path: "/api/session/ses_1/form/frm_1/reply",
          body: { answer: { q0: "beta-value", q1: ["one-value", "custom"] } },
        },
        { path: "/api/session/ses_1/permission/per_1/reply", body: { decision: "once" } },
      ])
      expect(result.event).toEqual({
        id: "evt_1",
        type: "server.connected",
        data: {},
      })
    } finally {
      await server.stop(true)
    }
  })
})
