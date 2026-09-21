import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Ref, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import type { HttpMethod } from "effect/unstable/http/HttpMethod"

export class AppViewModelError extends Data.TaggedError("AppViewModelError")<{
  readonly operation: string
  readonly message: string
  readonly cause: unknown
}> {
  constructor(operation: string, cause: unknown) {
    super({
      operation,
      cause,
      message: cause instanceof Error ? `${operation} failed: ${cause.message}` : `${operation} failed`,
    })
  }
}

const API_REQUEST_TIMEOUT_MS = 90_000
const ApiErrorBody = Schema.Struct({ error: Schema.optional(Schema.String) })

class ApiRequestTimeoutError extends Error {
  constructor() {
    super("API request timed out after 90 seconds")
    this.name = "ApiRequestTimeoutError"
  }
}

type RefreshGate =
  | { readonly _tag: "Owner"; readonly gate: Deferred.Deferred<boolean> }
  | { readonly _tag: "Waiter"; readonly gate: Deferred.Deferred<boolean> }

interface WebApiClientService {
  readonly request: (url: string, init?: RequestInit) => Effect.Effect<HttpClientResponse.HttpClientResponse, AppViewModelError>
  readonly refreshAccessToken: Effect.Effect<boolean>
}

interface WebAppRuntimeService {
  readonly preferenceWrites: Semaphore.Semaphore
}

export class WebApiClient extends Context.Service<WebApiClient, WebApiClientService>()(
  "opencode2-uis/WebApiClient",
) {}

export class WebAppRuntime extends Context.Service<WebAppRuntime, WebAppRuntimeService>()(
  "opencode2-uis/WebAppRuntime",
) {}

const callerCancellation = (signal: AbortSignal): Effect.Effect<never, AppViewModelError> =>
  Effect.callback((resume) => {
    const abort = () => resume(Effect.fail(new AppViewModelError("api request", new Error("caller aborted"))))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })

export const WebApiClientLive: Layer.Layer<WebApiClient> = Layer.effect(
  WebApiClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const fetch = yield* FetchHttpClient.Fetch
    const refreshInFlight = yield* Ref.make<Option.Option<Deferred.Deferred<boolean>>>(Option.none())
    const request = (url: string, init: RequestInit = {}): Effect.Effect<HttpClientResponse.HttpClientResponse, AppViewModelError> => Effect.gen(function* () {
      const absoluteUrl = yield* Effect.try({
        try: () => new URL(url, globalThis.location?.href ?? "http://localhost/"),
        catch: (cause) => new AppViewModelError("build API request URL", cause),
      })
      // SAFETY: RequestInit methods are normalized to the HTTP method union accepted by HttpClientRequest.
      let httpRequest = HttpClientRequest.make((init.method ?? "GET").toUpperCase() as HttpMethod)(absoluteUrl, {
        headers: init.headers,
      })
      if (init.body !== undefined && init.body !== null) httpRequest = HttpClientRequest.setBody(httpRequest, HttpBody.raw(init.body))
      const execute = client.execute(httpRequest).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
      )
      const cancellable = init.signal === undefined || init.signal === null
        ? execute
        : Effect.raceFirst(execute, callerCancellation(init.signal))
      return yield* cancellable.pipe(
        Effect.timeout(`${API_REQUEST_TIMEOUT_MS} millis`),
        Effect.mapError((cause) => new AppViewModelError(
          "api request",
          cause instanceof Cause.TimeoutError ? new ApiRequestTimeoutError() : cause,
        )),
      )
    })
    const refreshAccessToken: Effect.Effect<boolean> = Effect.gen(function* () {
      const candidate = yield* Deferred.make<boolean>()
      const selected = yield* Ref.modify(refreshInFlight, (current): readonly [RefreshGate, Option.Option<Deferred.Deferred<boolean>>] =>
        Option.match(current, {
          onNone: () => [{ _tag: "Owner", gate: candidate }, Option.some(candidate)],
          onSome: (gate) => [{ _tag: "Waiter", gate }, current],
        }))
      if (selected._tag === "Waiter") return yield* Deferred.await(selected.gate)

      return yield* request("/api/auth/refresh", { method: "POST" }).pipe(
        Effect.map((response) => response.status >= 200 && response.status < 300),
        Effect.catchCause((cause) => Effect.logWarning("web access token refresh failed", Cause.pretty(cause)).pipe(
          Effect.as(false),
        )),
        Effect.onExit((exit) => Deferred.succeed(selected.gate, Exit.isSuccess(exit) ? exit.value : false)),
        Effect.ensuring(Ref.update(refreshInFlight, (current) =>
          Option.filter(current, (gate) => gate !== selected.gate))),
      )
    })
    return WebApiClient.of({ request, refreshAccessToken })
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

const WebAppRuntimeLive: Layer.Layer<WebAppRuntime> = Layer.effect(
  WebAppRuntime,
  Effect.map(Semaphore.make(1), (preferenceWrites) => WebAppRuntime.of({ preferenceWrites })),
)

export const refreshAccessToken: Effect.Effect<boolean, never, WebApiClient> =
  Effect.flatMap(WebApiClient, (client) => client.refreshAccessToken)

const decodeResponse = <A>(response: HttpClientResponse.HttpClientResponse, schema: Schema.ConstraintDecoder<A, never>, operation: string): Effect.Effect<A, AppViewModelError> =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new AppViewModelError(operation, cause)),
  )

export const json = <A>(
  url: string,
  schema: Schema.ConstraintDecoder<A, never>,
  init?: RequestInit,
): Effect.Effect<A, AppViewModelError, WebApiClient> =>
  Effect.gen(function* () {
    const client = yield* WebApiClient
    let response = yield* client.request(url, init)
    if (response.status === 401 && url !== "/api/auth/refresh" && (yield* refreshAccessToken)) {
      response = yield* client.request(url, init)
    }
    if (response.status < 200 || response.status >= 300) {
      const body = yield* decodeResponse(response, ApiErrorBody, "decode API error response").pipe(
        Effect.catchCause((cause) => Effect.logWarning("API error response could not be decoded", Cause.pretty(cause)).pipe(
          Effect.as({ error: undefined }),
        )),
      )
      const detail = body.error
      return yield* Effect.fail(new AppViewModelError(
        "api request",
        new Error(detail ?? `HTTP ${response.status}`),
      ))
    }
    return yield* decodeResponse(response, schema, `decode API response from ${url}`)
  })

export const loadWebSession: Effect.Effect<boolean, AppViewModelError, WebApiClient> = Effect.gen(function* () {
  const client = yield* WebApiClient
  let response = yield* client.request("/api/auth/session")
  if (response.status === 401 && (yield* refreshAccessToken)) {
    response = yield* client.request("/api/auth/session")
  }
  return response.status >= 200 && response.status < 300
})

export const loginWeb = (username: string, password: string): Effect.Effect<void, AppViewModelError, WebApiClient> =>
  Effect.gen(function* () {
    const client = yield* WebApiClient
    const response = yield* client.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
    if (response.status >= 200 && response.status < 300) return
    const body = yield* decodeResponse(response, ApiErrorBody, "decode sign-in response").pipe(
      Effect.catchCause((cause) => Effect.logWarning("sign-in error response could not be decoded", Cause.pretty(cause)).pipe(
        Effect.as(undefined),
      )),
    )
    const detail = body?.error
    return yield* Effect.fail(new AppViewModelError(
      "sign in",
      new Error(detail ?? "Sign-in failed"),
    ))
  })

type WebAppServices = WebApiClient | WebAppRuntime

export interface AppEffectRunner {
  readonly fork: <A, E extends AppViewModelError>(effect: Effect.Effect<A, E, WebAppServices>) => Fiber.Fiber<A, E>
  readonly run: <A>(
    effect: Effect.Effect<A, AppViewModelError, WebAppServices>,
    fail: (error: AppViewModelError) => void,
    succeed?: (value: A) => void,
  ) => Fiber.Fiber<void>
  readonly close: () => void
}

export const makeAppEffectRunner = (): AppEffectRunner => {
  const runtime = ManagedRuntime.make(Layer.merge(WebApiClientLive, WebAppRuntimeLive))
  const fork: AppEffectRunner["fork"] = (effect) => runtime.runFork(effect)
  return {
    fork,
    run: <A>(
      effect: Effect.Effect<A, AppViewModelError, WebAppServices>,
      fail: (error: AppViewModelError) => void,
      succeed?: (value: A) => void,
    ): Fiber.Fiber<void> => fork(effect.pipe(
        Effect.tap((value) => succeed === undefined ? Effect.void : Effect.sync(() => succeed(value))),
        Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("web client effect failed", Cause.pretty(cause)).pipe(
              Effect.andThen(Effect.sync(() => {
                const error = Cause.findErrorOption(cause)
                if (Option.isSome(error)) fail(error.value)
              })),
            )),
        Effect.asVoid,
      )),
    close: (): void => {
      Effect.runFork(runtime.disposeEffect)
    },
  }
}
