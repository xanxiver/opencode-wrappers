# Backlog

Improvements and OpenCode2 API features. Priorities:
P0 = needed for reliable daily use, P1 = high value, P2 = nice to have.

## API features

- [x] `session.wait` / `session.pending` — wait for a session to become idle
  before prompting (wired into run start).
- [x] `session.compact` — auto-compact sessions when input tokens exceed
  200k (`session.usage.updated` trigger).
- [ ] P2 `session.fork` / `session.revert` — fork a session on demand, revert
  bad runs. Useful for an "undo" command.
- [ ] P2 `form` API — the agent can send structured forms. Question flow covers
  most needs, but forms carry typed fields.
- [ ] P2 `shell` / `pty` API — run shell commands in the project and stream
  output. Enables a terminal view in the UI.
- [ ] P2 `filesystem` API (`/api/fs/*`) — browse project files from the chat.
- [ ] P2 `vcs` API — show git status / diff from the chat.
- [ ] P2 `session.move` — move a session to another project directory.
- [ ] P2 `generate` — one-shot text generation without a session.
- [ ] P3 `integration` OAuth flow — connect provider accounts from the chat.
- [ ] P3 `mcp` management — add/remove MCP servers from the chat.

## Improvements

### P0 — reliability (done)

- [x] Reconnect the event stream: when `/api/event` drops, retry the
      subscription with backoff (5 retries, 30s cap).
- [x] Permission/question tokens expire after 30 min / 1 hour; expired
      callbacks answer "Expired." cleanly. On startup, pending requests are
      re-surfaced to the affected chats.
- [x] Timeout for runs: 10 minutes, then interrupt the session and report
      "Timed out."

### P1 — UX (done)

- [x] Per-chat project directory: `/projects` picker and `/project <path>`.
      Chats in the same directory share the session.
- [x] `/sessions` command: list sessions in the directory, switch the active
      one.
- [x] Token usage and cost shown in the final message.
- [x] Busy queue: messages are queued per chat and run when the current task
      finishes.
- [x] Short answers (<= 600 chars) are sent as their own message; the working
      message becomes "Done."
- [x] Multi-select questions: options toggle, Confirm submits.
- [x] Custom text replies: allowed when the question allows it; the hint is
      shown in the question text.
- [x] Edit rate limit: at most one message edit per second per chat.

### P2 — platform

- [ ] Web UI: reuse `src/core/*` and add `src/web/*` (SSE via `/api/event`).
- [ ] Webhook mode for the bot instead of long polling (needs HTTPS).
- [ ] Docker image for the bot.
- [ ] Structured logging to file (JSON lines) with component/boundary tags.
- [ ] Health endpoint for the bot process.

## Testing

- [ ] Integration test for the Telegram Bot API against a mock server.
- [ ] Integration test for the OpenCode client against a mock server.
- [ ] Property tests for `truncate` and magic-byte detection.
