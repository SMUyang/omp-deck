# omp-deck

A cockpit web UI for the [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) coding agent. Multi-session chat with full tool-call rendering, a
kanban backed by SQLite, cron routines, an inbox with one-click promote, a
plugin marketplace, themable settings, and a Telegram bridge — all in a single
Bun process, designed to run loopback-only behind Tailscale or an SSH tunnel.

> Status: **v0.1 public release.** End-to-end verified against live omp turns.
> See [CHANGELOG.md](./CHANGELOG.md) for the full feature inventory.

![omp-deck chat surface — live tool calls + orientation summary](./docs/screenshots/00-hero-chat-paper.png)

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Kanban — paper](./docs/screenshots/01-kanban-paper.png) | ![Kanban — slate](./docs/screenshots/02-kanban-slate.png) |
| Kanban with `T-N` display IDs, paper theme | Same view in the slate theme |
| ![Marketplace](./docs/screenshots/03-marketplace-slate.png) | ![Appearance settings](./docs/screenshots/04-settings-appearance-slate.png) |
| Marketplace browser populated with `anthropics/claude-plugins-official` (202 plugins) | Settings → Appearance theme cards |
| ![Messaging settings](./docs/screenshots/05-settings-messaging-slate.png) | ![Routines](./docs/screenshots/06-routines-paper.png) |
| Settings → Messaging with the Telegram bridge supervisor | Routines (cron scheduler) |

</details>

## Why

The omp TUI is excellent at what it does, but a terminal isn't always where
you want to drive an agent — you might want a kanban to track its work, a
phone bridge to ask it things from the couch, a marketplace to install
plugins without hand-editing JSON, or just a calmer surface for long
sessions. omp-deck gives you all of that while reusing the SDK in-process so
the chat itself stays at parity with the TUI.

omp-deck is **not** a replacement for `omp`. It embeds the same SDK and
shares its session + auth store. Run both; they coexist.

## Highlights

- **Chat** with multi-session sidebar, per-tool renderers (`read` / `write` /
  `edit` / `bash` / `search` / `lsp` / `task` / `eval` / `web_search` /
  `todo_write` / `generate_image` / `browser`), thinking blocks, hashline
  diff coloring, cost rollup, image paste/drop/attach, compaction +
  auto-retry indicators.
- **Slash commands** with four scopes (`deck` / `builtin` / `user` /
  `project`) and in-process dispatch — `/task add`, `/context`, `/compact`,
  `/usage` run instantly with no model round-trip.
- **Kanban** with Jira-style display IDs (`T-1`, `T-2`, ...), drag-and-drop,
  configurable columns, and live WebSocket broadcasts — agent or external
  scripts mutating tasks refresh every open kanban without polling.
- **Routines** — cron scheduler for `bash` / `prompt` / `script` actions with
  run history.
- **Inbox** — quick capture surface with promote-to-task.
- **Settings** — masked secret store with atomic `.env` writes + audit log,
  hot-applied env updates where possible, a one-click server restart for the
  rest. Paper / Slate themes with FOUC-free pre-paint.
- **Marketplace** — browse and install plugins/skills/MCPs over the SDK's
  `MarketplaceManager`. Empty state seeds with
  `anthropics/claude-plugins-official`.
- **Model picker** — chat-header modal listing every model the SDK knows
  about, default-filtered to ones with configured auth, provider-grouped.
- **Telegram bridge** — standalone Bun process supervised by the deck; DM the
  agent from your phone with allowlist gating and streaming `editMessageText`
  replies.

## Quickstart

### If you already use omp on this machine

```sh
git clone https://github.com/bjb2/omp-deck.git
cd omp-deck
bun install
bun run dev
```

Open <http://127.0.0.1:5173>. Your existing `~/.omp/agent` is picked up
automatically — no re-auth.

### If you don't have omp yet

See [docs/install.md](./docs/install.md). The short version:

```sh
# 1. Install Bun (https://bun.sh)
# 2. Install the omp CLI globally so you can authenticate
bun add -g @oh-my-pi/pi-coding-agent
omp                                          # interactive auth (browser OAuth or API key)
# 3. Clone and run the deck
git clone https://github.com/bjb2/omp-deck.git
cd omp-deck
bun install
bun run dev
```

Or skip the CLI entirely and paste your provider API key into Settings →
Env after the deck is up.

## Architecture in two lines

A Bun + Hono backend embeds `@oh-my-pi/pi-coding-agent`. The Vite + React
frontend is a pure consumer of a WebSocket event stream. The contract layer
(`packages/protocol`) is dep-free shared types.

```
Browser (Vite :5173 or built bundle on :8787)
   │  WS frames + REST control plane
   ▼
Bun server  (apps/server)
   ├─ AgentBridge → InProcessAgentBridge → omp SDK
   ├─ Hono routes  /api/{sessions, tasks, routines, inbox, settings,
   │                     models, marketplace, bridges, slash-commands, fs}
   ├─ WebSocket hub  /ws  (session events + tasks_changed broadcasts)
   ├─ Routines runner (croner)
   ├─ BridgeSupervisor (telegram bridge, future Slack/Discord)
   └─ MarketplaceService (SDK MarketplaceManager wrapper)
```

Full diagram in [docs/architecture.md](./docs/architecture.md).

## Docs

- [Install](./docs/install.md) — fresh vs existing-omp install paths.
- [Configuration](./docs/configuration.md) — full env reference + restart
  semantics.
- [Deployment](./docs/deployment.md) — Tailscale, Docker, SSH-tunnel,
  hardening checklist.
- [Slash commands](./docs/slash-commands.md) — deck `/task` family, SDK
  builtins, user/project markdown commands.
- [Marketplaces](./docs/marketplaces.md) — catalog seeding, install
  semantics, capability badges.
- [Telegram bridge](./docs/telegram.md) — DM-driven agent from your phone.
- [Themes](./docs/themes.md) — Paper / Slate / adding more.
- [Start command template](./docs/start-command-template.md) — define
  `/start` for an auto-orientation greeting.
- [Architecture](./docs/architecture.md) — workspace layout, frame model,
  synthetic events, theming.
- [TUI parity](./docs/tui-parity.md) — feature matrix vs the omp TUI.
- [Contributing](./CONTRIBUTING.md) — dev loop, code quality, style.

## Security

The deck ships **without an auth layer**. Bind it loopback-only (the default)
and front it with Tailscale Serve / SSH tunnel / a reverse proxy. The
hardening checklist in [docs/deployment.md](./docs/deployment.md#hardening-checklist)
covers what to verify before exposing the deck to a network anyone else can
reach.

Provider API keys live in env vars (your shell, or the deck-managed `.env`).
The Settings UI masks them by default; revealing a secret requires a loopback
request. The deck never logs values, only redacted forms.

## Status & roadmap

v0.1 ships the surfaces above end-to-end. Notable items deferred to v0.2:

- Permission prompts (`ask` tool) via bidirectional WS UI bridge.
- Plan-mode UI (banner + plan file viewer).
- File browser in the inspector.
- Subprocess-per-session bridge impl for crash isolation.
- Slack / Discord / Matrix bridges (same supervisor pattern as Telegram).
- Skill management UI (filed; see backlog).
- `bunx omp-deck` install path / Docker image build verified.

## License

MIT. See [LICENSE](./LICENSE).
