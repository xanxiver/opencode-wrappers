import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Crypto, Data, Effect, FileSystem } from "effect"
import { Command, Flag } from "effect/unstable/cli"

const DEFAULT_LENGTH = 24
const MIN_LENGTH = 16
const MAX_LENGTH = 128
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-"

class PasswordCliError extends Data.TaggedError("PasswordCliError")<{ readonly message: string }> {}

export const generatePassword = (length = DEFAULT_LENGTH): Effect.Effect<string, PasswordCliError, Crypto.Crypto> => Effect.gen(function* () {
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    return yield* new PasswordCliError({ message: `password length must be an integer from ${MIN_LENGTH} to ${MAX_LENGTH}` })
  }
  const crypto = yield* Crypto.Crypto
  const characters = yield* Effect.forEach(Array.from({ length }), () => crypto.randomIntBetween(0, PASSWORD_ALPHABET.length - 1).pipe(
    Effect.map((index) => PASSWORD_ALPHABET[index] ?? ""),
  ))
  return characters.join("")
})

const appendHashToEnv = (path: string, password: string, hash: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const existing = yield* fs.readFileString(path).pipe(
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed("")),
  )
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  // Escape `$` because Bun's dotenv loader expands it inside quoted values.
  const dotenvHash = hash.replaceAll("$", "\\$")
  yield* fs.writeFileString(path, `${separator}# WEB_PASSWORD=${password}\nWEB_PASSWORD_HASH="${dotenvHash}"\n`, { flag: "a" })
})

const passwordCommand = Command.make("password", {
  length: Flag.integer("length").pipe(
    Flag.withAlias("l"),
    Flag.withDefault(DEFAULT_LENGTH),
    Flag.withDescription(`Password length from ${MIN_LENGTH} to ${MAX_LENGTH}`),
  ),
  writeEnv: Flag.boolean("write-env").pipe(Flag.withDescription("Append the hash to an env file")),
  envFile: Flag.file("env-file").pipe(Flag.withDefault(".env"), Flag.withDescription("Env file used with --write-env")),
}, Effect.fn("passwordCommand")(function* ({ length, writeEnv, envFile }) {
  const password = yield* generatePassword(length)
  const hash = yield* Effect.tryPromise({
    try: () => Bun.password.hash(password),
    catch: () => new PasswordCliError({ message: "password hashing failed" }),
  })

  if (!writeEnv) {
    yield* Console.log(`Password (${length} characters): ${password}`)
    yield* Console.log(`WEB_PASSWORD_HASH=${hash}`)
    yield* Console.log("\nCopy WEB_PASSWORD_HASH into your .env file. Keep the password private.")
    return
  }

  yield* appendHashToEnv(envFile, password, hash)
  yield* Console.log(`Appended WEB_PASSWORD_HASH to ${envFile}.`)
  yield* Console.log(`Password (${length} characters): ${password}`)
  yield* Console.log("Keep the password private.")
}))

BunRuntime.runMain(Command.run(passwordCommand, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
