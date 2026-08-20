# Telegram UI for OpenCode2

The bot lives in `src/` and `test/` at the repository root. The core
(`src/core/*`) is UI-agnostic, so more UIs (web, etc.) can reuse it later.

## Features

- Prompt an OpenCode2 session from Telegram, one session per directory.
- Attach files to prompts: pdf, png, jpg, gif, webp, csv, xlsx, docx, md, mdx.
  Extension AND magic bytes are validated. Reply to a message to use its
  attachments. Each file has a 10 MB limit. One prompt has a 10-file and 50 MB
  total limit.
- Tool permission approvals via inline keyboard (once / always / reject).
- Agent questions: option buttons, multi-select with Confirm, skip, or reply
  with text (when the question allows custom answers).
- Subagent requests are surfaced too: when a primary agent spawns subagents
  (child sessions), their permission and question prompts are delivered in the
  parent run's chat and topic, and answers reply to the child session.
- Live progress: text, reasoning, and tool activity update one message.
- Token usage and cost in the final message.
- Working-tree changes summary in the final message (branch, changed files, and
  tracked diff line totals) when the project directory is inside a Git
  repository. The summary is a snapshot of the current tree, not an attribution
  of the listed changes to one run.
- `/model`: paginated model picker (10 per page, Previous/Next).
- `/agents`: list and select a primary agent for the current session.
- `/pwa <agent> <prompt>`: run a prompt with an exact agent ID or name.
- `/compact`: compact the current session.
- `/reconnect`: report automatic recovery or durably attach to an active
  OpenCode run that has no worker.
- `/forceReconnect`: replace the worker lease when the current worker stopped.
- `/review [focus]`: review the current repository changes.
- `/reviews`: list redacted evidence for ambiguous jobs and Telegram prompt sends.
- `/resolve_review <review-id>`: resolve a job review or explicitly retry an
  uncertain prompt send.
- Forum topics: replies land in the thread the user is in.
- `/queue`: show the durable run pipeline for the current session (starting,
  running, finishing, and queued runs with their prompts), read-only.
- Commands: `/start`, `/help`, `/prompt`, `/new`, `/stop`, `/reconnect`, `/forceReconnect`,
  `/compact`, `/review`, `/model`, `/agents`, `/pwa <agent> <prompt>`, `/status`, `/whoami`, `/projects`, `/project <path>`,
  `/sessions`, `/queue`.
- User whitelist via `TELEGRAM_ALLOWED_USERS` (empty = deny all).

## Reliability

- Idempotent Telegram API operations retry with exponential backoff (max 5
  retries, 30s cap). Message creation does not retry at the transport layer.
- Message edits rate-limited to 1/sec per chat.
- Event stream reconnect with backoff.
- Run timeout: 10 minutes, then interrupt the session.
- Permission and question state is stored in SQLite. Tokens expire after 30
  minutes or 1 hour. Pending requests remain available after a restart. A
  generation-fenced reply claim prevents a replay while OpenCode processes the
  reply. A renewable lease keeps the claim active across overlapping bot
  processes. A stopped process releases the claim when its lease expires.
- Permission and question delivery is fenced before the Telegram send. An
  uncertain send is not repeated automatically because Telegram has no
  idempotency key for message creation. `/reviews` shows the uncertain send.
  The operator can inspect the chat before an explicit retry. A definitive
  Telegram rejection also stays fenced for operator review, which prevents a
  permanent rejection from creating a retry loop.
- Prompts and accepted attachment bytes remain in SQLite from acceptance to a
  terminal job state. Completion and permanent failure remove the prompt,
  attachment bytes, and terminal response from the job row. A manual-review
  state retains redacted diagnostic evidence until the review is explicitly
  resolved. Unresolved evidence is removed after 7 days.
- Failed Telegram updates are logged and quarantined so one poison update does
  not block later updates. Duplicate prompt messages still resolve to the same
  durable job.
- One renewable, generation-fenced lease controls each running job.
- Waiting prompts run in FIFO order for each OpenCode session.
- Generated media uses container validation and a 10-file, 50 MB total limit.

## Stack

- Bun (package manager, runner, tests)
- TypeScript 7 (tsgo via `@typescript/native-preview`)
- Effect 4.0.0-beta.101 (pinned to match `@opencode-ai/client` peer)
- `@opencode-ai/client@next` (Effect entrypoint)

## Setup

```sh
bun install
cp .env.example .env
# TELEGRAM_BOT_TOKEN from @BotFather
# TELEGRAM_ALLOWED_USERS = your Telegram user id (empty = deny all)
# PROJECT_DIRECTORY = where OpenCode sessions run
# OPENCODE_BASE_URL = optional; empty = discover the local opencode2 service
```

## Run

```sh
bun run telegram    # run the Telegram UI
bun run dev         # watch mode (Telegram UI)
bun run typecheck   # tsgo
bun run test:bot    # bun test, bot tests only
bun run opencode    # spawn the opencode2 background service (serve --service)
bun run opencode:status    # show the service URL
bun run opencode:restart   # restart the background service
```

Each UI has its own entry and script: `src/telegram/main.ts` + `bun run
telegram`. Future UIs get their own `src/<ui>/main.ts` and script. Env keys
are prefixed per UI (`TELEGRAM_*`).

## Architecture

- `src/core/opencode.ts` — OpenCode client service (sessions, prompt,
  permissions, questions, models, wait, compact, listings). Auth: Basic
  `opencode:<password>` from the local service registration, or env vars.
- `src/core/store.ts` — sessions keyed by directory + per-chat directory
  overrides + per-directory model memory, persisted as JSON (migrates the
  legacy chat->session format).
- `src/core/sessions.ts` — get-or-create session with a lock; chats in the
  same directory share the session.
- `src/core/attachments.ts` — attachment -> data-URI conversion.
- `src/core/durable-executor.ts` — durable jobs, state transitions, and
  generation-fenced worker leases.
- `src/telegram/api.ts` — Telegram Bot API client with retry/backoff and
  per-chat edit rate limiting.
- `src/telegram/files.ts` — extension + magic byte validation, downloads.
- `src/telegram/run.ts` — one prompt run: live message edits, permissions,
  questions, reasoning, usage, reconnect, timeout, auto-compact, model
  re-apply.
- `src/telegram/durable-executor.ts` — supervised Telegram workers and restart
  recovery.
- `src/telegram/interaction-store.ts` — durable permission and question state.
- `src/telegram/handlers/*` — message/command handling, split by concern:
  `update`, `message`, `run`, `callbacks`, `permission`, `model`, `question`,
  `picker`, `shared`, with an `index` barrel.
- `src/telegram/{permissions,questions,models,pickers}.ts` — token
  registries for inline keyboard actions.
- `src/telegram/resurface.ts` — re-surfaces pending requests after restart.
- `src/telegram/bot.ts` — long-polling loop.
- `src/telegram/main.ts` — wiring. Note: `Effect.provide` adds layer
  requirements back, so dependency layers must be provided after their users.

## Notes

- The OpenCode2 API is beta; method names may change.
- See `backlog.md` for planned improvements and unused API features.
