import { Buffer } from "node:buffer"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Crypto, Data, Effect, FileSystem } from "effect"
import { Command, Flag } from "effect/unstable/cli"

const DEFAULT_BYTES = 32
const MIN_BYTES = 32
const MAX_BYTES = 128

class JwtSecretCliError extends Data.TaggedError("JwtSecretCliError")<{ readonly message: string }> {}

export const generateJwtSecret = (bytes = DEFAULT_BYTES): Effect.Effect<string, JwtSecretCliError, Crypto.Crypto> => Effect.gen(function* () {
  if (!Number.isInteger(bytes) || bytes < MIN_BYTES || bytes > MAX_BYTES) {
    return yield* new JwtSecretCliError({ message: `secret size must be an integer from ${MIN_BYTES} to ${MAX_BYTES} bytes` })
  }
  const crypto = yield* Crypto.Crypto
  const randomBytes = yield* crypto.randomBytes(bytes).pipe(
    Effect.mapError(() => new JwtSecretCliError({ message: "secret generation failed" })),
  )
  return Buffer.from(randomBytes).toString("base64url")
})

const appendSecretToEnv = (path: string, secret: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const existing = yield* fs.readFileString(path).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed("")),
  )
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  yield* fs.writeFileString(path, `${separator}WEB_JWT_SECRET="${secret}"\n`, { flag: "a" })
})

const jwtSecretCommand = Command.make("jwt-secret", {
  bytes: Flag.integer("bytes").pipe(
    Flag.withAlias("b"),
    Flag.withDefault(DEFAULT_BYTES),
    Flag.withDescription(`Secret size from ${MIN_BYTES} to ${MAX_BYTES} bytes`),
  ),
  writeEnv: Flag.boolean("write-env").pipe(Flag.withDescription("Append the secret to an env file")),
  envFile: Flag.file("env-file").pipe(Flag.withDefault(".env"), Flag.withDescription("Env file used with --write-env")),
}, Effect.fn("jwtSecretCommand")(function* ({ bytes, writeEnv, envFile }) {
  const secret = yield* generateJwtSecret(bytes)
  if (!writeEnv) {
    yield* Console.log(`WEB_JWT_SECRET=${secret}`)
    yield* Console.log("Keep this secret private and stable while tokens are active.")
    return
  }

  yield* appendSecretToEnv(envFile, secret)
  yield* Console.log(`Appended WEB_JWT_SECRET to ${envFile}.`)
}))

BunRuntime.runMain(Command.run(jwtSecretCommand, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
