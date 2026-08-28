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
- Live progress updates one working message. `/verbosity quiet` keeps the
  working message unchanged until the final result. `/verbosity normal`
  streams response text and tool activity. `/verbosity detailed` also streams
  reasoning. Existing conversations default to `normal`.
- Finished runs reply `done`, `fail`, `interrupted`, or `timeout` under the
  run message so the chat notifies on completion.
- Token usage and cost in the final message.
- Working-tree changes summary in the final message (branch, changed files, and
  tracked diff line totals) when the project directory is inside a Git
  repository. The summary is a snapshot of the current tree, not an attribution
  of the listed changes to one run.
- `/models`: paginated model picker (10 per page, Previous/Next). A model
  choice is saved for the active session and agent.
- `/model <exact-model>`: switch directly to an exact model. The choice uses
  the same active session-agent preference as the picker.
- `/agents`: list and select a primary agent for the current session. The bot
  restores the model saved for that session-agent pair. If the pair has no
  saved model, the bot uses the agent model, the session model, or the old
  directory fallback, in that order.
- `/pwa <agent> <prompt>`: run a prompt with an exact agent ID or name. The
  durable job stores that agent and its effective model when the bot accepts
  the prompt.
- `/status`: show grouped workspace, session, agent model, and automation
  details. The status shows the effective model for each selectable agent and
  marks the active agent in that list. This command uses Telegram HTML
  formatting. Other bot messages remain plain text.
- `/compact`: compact the current session.
- `/reconnect`: report automatic recovery or durably attach to an active
  OpenCode run that has no worker.
- `/forceReconnect`: replace the worker lease when the current worker stopped.
- `/review [focus]`: review the current repository changes.
- `/reviews`: list redacted evidence for ambiguous jobs and Telegram prompt sends.
- `/resolve_review <review-id>`: resolve a job review or explicitly retry an
  uncertain prompt send.
- Forum topics: replies land in the thread the user is in.
- Optional delivery bot pool: one controller receives all updates. The
  controller and configured outbound-only workers can deliver run output in
  different topics at the same time.
- `/queue`: show the durable run pipeline for the current session (starting,
  running, finishing, and queued runs with their prompts), read-only.
- `/move <from> <to>`: reorder queued tasks using the positions shown by
  `/queue`. The running task cannot be moved.
- `/queue_delete <pos>`: remove one queued task by its `/queue` position.
- `/queue_clear`: remove every queued task for the current session.
- `/loose on|off`: when on, a plain message starts a run without `/prompt`.
  When exactly one custom-answer question is waiting in the same topic, plain
  text answers that question instead. Use `/prompt` to start a separate task.
  Slash commands still run first. The setting is stored per conversation.
- `/new` starts a fresh session only after the current session has no running
  or queued durable tasks. This keeps executable work visible to `/queue`.
- `/continue on|off`: when on, a failed, errored, or timed-out run sends a
  `continue` prompt into the same session automatically. Max 5 consecutive
  continues with jittered exponential backoff (30s up to 8m); any success
  resets the count. After giving up at the cap the count clears, so a later
  failure starts a fresh cycle. Stored per conversation.
- `/verbosity quiet|normal|detailed`: set how much live run content appears in
  the working message. The setting is stored per conversation. Each durable
  job keeps the level that was active when the bot accepted that job.
- Commands: `/start`, `/help`, `/prompt`, `/new`, `/stop`, `/reconnect`, `/forceReconnect`,
  `/compact`, `/review`, `/models`, `/model`, `/agents`, `/pwa <agent> <prompt>`, `/status`, `/whoami`, `/projects`, `/project <path>`,
  `/sessions`, `/queue`, `/move <from> <to>`, `/queue_delete <pos>`, `/queue_clear`,
  `/loose on|off`, `/continue on|off`, `/verbosity quiet|normal|detailed`.
- User whitelist via `TELEGRAM_ALLOWED_USERS` (empty = deny all).

## Reliability

- Retry-safe Telegram API operations use exponential backoff (max 5 retries,
  30s cap). The bot logs each retry, including the operation, status code,
  retry number, and wait time. Message creation does not retry at the transport
  layer. Callback acknowledgements and live progress edits use one attempt.
- Message edits pass through one scheduler per chat. Direct chats start at 1
  second between edits. Group chats start at 6 seconds. Each delivery bot has
  independent chat throttle state. A Telegram 429 response for one bot does not
  delay another bot. A Telegram 429 response can increase that bot's interval
  to 20 seconds. Interactive and final edits run before queued live progress
  edits. Queued progress collapses to the newest update for each Telegram
  message. Progress failures do not block urgent feedback with retries. One
  shared semaphore limits the process to 16 concurrent edit requests.
- Model and question buttons wait no more than 2 seconds for callback
  acknowledgement before the action continues. Their cosmetic message edits
  run in the background after in-memory enqueueing.
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
- A queued prompt keeps the agent, model, and stream verbosity that the bot
  selected when it accepted the prompt. Later setting changes do not change
  that queued prompt.
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
# TELEGRAM_BOT_POOL = optional JSON array of outbound-only delivery bots
# TELEGRAM_ALLOWED_USERS = your Telegram user id (empty = deny all)
# PROJECT_DIRECTORY = where OpenCode sessions run
# OPENCODE_BASE_URL = optional; empty = discover the local opencode2 service
```

### Controller and delivery workers

`TELEGRAM_BOT_TOKEN` is always the controller token. Only this bot calls
`getUpdates`. It receives commands, private messages, replies, files, and
callbacks. It also sends all pickers, permission requests, question requests,
validation errors, and queue notices.

Set `TELEGRAM_BOT_POOL` to a JSON array when you need more run-delivery
capacity:

```env
TELEGRAM_BOT_POOL=[{"id":"delivery-1","token":"123456:replace-me"},{"id":"delivery-2","token":"234567:replace-me"}]
```

Each worker id must be stable, lowercase, and unique. It can contain numbers
and hyphens. The id `controller` is reserved. A worker token cannot match the
controller token or another worker token. Keep an id unchanged when you rotate
its token because durable assignments store the id, not the token.

Configure Telegram as follows:

1. Make the controller a group administrator, or disable its privacy mode.
2. Add each worker to every group that it can serve.
3. Give each worker permission to send messages and media in the required
   topics.
4. Do not configure a webhook or another poller for a worker.

Workers never receive private chats or callbacks. The controller is an equal
delivery candidate, so ten total delivery bots means one controller and nine
workers. With no worker configuration, the wrapper uses the controller only.

For a new group session, the wrapper selects the healthy group member with the
lowest active load. It keeps that assignment for the selected session. A
session switch can select another delivery bot. An older active run keeps its
original bot and message anchor until it finishes.

Existing group session and topic pairs start with controller compatibility
ownership. They keep that owner until the selected session changes or resets.
Old durable payloads also normalize to controller ownership. Do not remove a
worker configuration while a durable run or message anchor still refers to its
id.

The `/status` response shows the selected delivery bot, the available and
configured member counts, unavailable-owner warnings, and legacy controller
ownership. Tokens and token-bearing Bot API URLs are not stored in assignments
or durable payloads.

### Pool rollout and rollback

Use a staged rollout:

1. Start with the controller only. Confirm that polling has no `409` conflict.
2. Add one worker with a stable id, then restart the wrapper.
3. In a disposable group topic, start a new session and check `/status`.
4. Confirm that the controller sends commands and pickers. Confirm that the
   selected delivery bot sends only run output.
5. Check startup and delivery logs for `401`, `403`, and repeated `429` errors.
6. Add workers one at a time. Stop at nine workers for ten total delivery
   members.

Do not remove or rename a worker while a non-terminal job or a Telegram message
anchor refers to its id. A missing owner makes the durable job wait. To roll
back safely, restore the same worker id and token, or wait for its runs to end
and switch or reset its selected sessions. You can then remove that worker from
`TELEGRAM_BOT_POOL` and restart the wrapper. To return to controller-only mode,
complete this process for every worker before you clear `TELEGRAM_BOT_POOL`.
Keep `TELEGRAM_BOT_TOKEN` unchanged so the controller keeps its polling and
interaction ownership.

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
- `src/core/store.ts` — session mappings, chat directory overrides, stream
  verbosity, and model preferences for each session-agent pair. The JSON state
  keeps old per-directory models as compatibility fallbacks.
- `src/core/sessions.ts` — get-or-create session with a lock; chats in the
  same directory share the session.
- `src/core/attachments.ts` — attachment -> data-URI conversion.
- `src/core/durable-executor.ts` — durable jobs, state transitions, and
  generation-fenced worker leases.
- `src/telegram/api.ts` — Telegram Bot API client with retry/backoff and
  per-chat edit rate limiting.
- `src/telegram/bot-pool.ts` - controller and outbound-worker clients, health
  probes, group eligibility, and the shared edit-request limit.
- `src/telegram/delivery-assignments.ts` - durable active-session assignments,
  least-load selection, and controller compatibility migration.
- `src/telegram/files.ts` — extension + magic byte validation, downloads.
- `src/telegram/run.ts` — one prompt run: live message edits, permissions,
  questions, reasoning, usage, reconnect, timeout, auto-compact, and agent and
  model snapshot application.
- `src/telegram/session-selection.ts` - per-session coordination for agent and
  model changes during picker actions and prompt acceptance.
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
