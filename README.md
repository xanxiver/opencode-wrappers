# OpenCode2 Wrappers

This project provides user interfaces for OpenCode2.

## Current wrappers

| Wrapper | Status | Start command |
| --- | --- | --- |
| Telegram | Available | `bun run telegram` |

## First setup

### Requirements

Install these tools:

- [Bun](https://bun.sh/)
- [OpenCode2](https://opencode.ai/v2/docs/) installed and available as `opencode2`
- A token for each wrapper that you use

### 1. Install the project

Run these commands from the project directory:

```sh
bun install
```

### 2. Configure OpenCode2

Copy the environment template:

```sh
cp .env.example .env
```

Set `PROJECT_DIRECTORY` to the directory where OpenCode2 must run. Use an
absolute path when possible.

If `OPENCODE_BASE_URL` is empty, the project starts the local `opencode2`
service when needed. To use a remote service, set `OPENCODE_BASE_URL` and its
credentials.

### 3. Configure a wrapper

Follow the setup guide for the wrapper that you want to use:

- [Telegram wrapper](docs/telegram-bot.md)

### 4. Start a wrapper

```sh
bun run telegram
```

The wrapper now accepts commands from allowed users.

## Configuration

See `.env.example` for the complete list.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | For Telegram | None | Token from `@BotFather`. |
| `TELEGRAM_BOT_POOL` | No | Empty | JSON array of outbound-only delivery bots, for example `[{"id":"delivery-1","token":"..."}]`. The controller remains a delivery candidate. |
| `TELEGRAM_ALLOWED_USERS` | No | Empty | Comma-separated Telegram user IDs. Empty denies all except `/whoami`. |
| `TELEGRAM_RUN_TIMEOUT` | No | `10 minutes` | Maximum run time. Use `none` for no limit. |
| `PROJECT_DIRECTORY` | No | Current directory | Default OpenCode2 project directory. |
| `STATE_FILE` | No | `data/state.json` | File for session, directory, and model state. |
| `OPENCODE_BASE_URL` | No | Local service | Remote OpenCode2 service URL. |
| `OPENCODE_USERNAME` | No | None | Username for a remote OpenCode2 service. |
| `OPENCODE_PASSWORD` | No | None | Password for a remote OpenCode2 service. |

## Development commands

```sh
bun run telegram          # Start the Telegram wrapper
bun run dev               # Start Telegram in watch mode
bun run typecheck         # Check TypeScript types
bun run test:bot          # Run wrapper tests
bun run opencode          # Start the OpenCode2 service
bun run opencode:status   # Show service status
bun run opencode:restart  # Restart the service
```

## Architecture

Shared services belong in `src/core/`. A wrapper belongs in its own directory.
Each wrapper should provide its own API adapter and user interaction layer.

| Path | Purpose |
| --- | --- |
| `src/core/opencode.ts` | Typed OpenCode2 client service. |
| `src/core/sessions.ts` | Session and directory management. |
| `src/core/store.ts` | Persistent session, directory, and model state. |
| `src/telegram/` | Telegram API, commands, files, and handlers. |
| `test/` | Tests for shared and Telegram code. |

## OpenCode2 API coverage

The shared client currently uses these API features:

| API feature | Status | Current use |
| --- | --- | --- |
| Sessions | Covered | Create, list, select, interrupt, wait, and compact. |
| Prompts | Covered | Run text prompts and file prompts. |
| Models | Covered | List and select models and variants. |
| Projects | Covered | List projects and select directories. |
| Permissions | Covered | Show pending requests and send replies. |
| Questions | Covered | Show questions and send answers. |
| Events | Partial | Show text, reasoning, tools, usage, permissions, questions, and run status. |

These OpenCode2 features are not exposed by the current wrapper:

| API feature | Status | Examples |
| --- | --- | --- |
| Session management | Not exposed | Fork, rename, move, delete, agent switch, revert, and logs. |
| Session tools | Not exposed | Shell, command, skill, synthetic message, and background tools. |
| Providers and agents | Not exposed | List providers, agents, and plugins. |
| MCP | Not exposed | Add, remove, connect, and disconnect MCP servers. |
| Filesystem | Not exposed | Read, list, and find files through the API. |
| Forms | Not exposed | Create, inspect, answer, and cancel forms. |
| Shell and PTY | Not exposed | Run shell commands and manage PTY sessions. |
| VCS | Not exposed | Read VCS information, status, and diffs. |
| Web search | Not exposed | List search providers and run searches. |
| Integrations | Not exposed | Manage providers, credentials, and OAuth connections. |
| Server and debug | Not exposed | Read server data, health, locations, and debug state. |

The OpenCode2 API is in beta. API names and behavior can change.

## License

This project is available under the MIT License. See [LICENSE](LICENSE).
