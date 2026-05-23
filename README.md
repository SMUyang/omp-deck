# omp-deck

A cockpit web UI for the [oh-my-pi](https://github.com/can1357/oh-my-pi)
(`omp`) coding agent. Multi-session chat with full tool-call rendering, a
kanban backed by SQLite, cron routines, an inbox with one-click promote, a
plugin marketplace, themable settings, and a Telegram bridge — all in a single
Bun process, designed to run loopback-only behind Tailscale or an SSH tunnel.

> Status: **v0.2 release — KB Cockpit + Maintenance Gate.**
> See [CHANGELOG.md](./CHANGELOG.md) for the full feature inventory.

![omp-deck chat surface — live tool calls + orientation summary](./docs/screenshots/00-hero-chat-paper.png)

<details>
<summary>More screenshots</summary>

| | |
|---|---|
| ![Kanban](./docs/screenshots/01-kanban-paper.png) | ![Marketplace](./docs/screenshots/03-marketplace-slate.png) |
| Kanban with `T-N` display IDs (paper theme) | Marketplace browser populated with `anthropics/claude-plugins-official` (slate theme) |
| ![Appearance settings](./docs/screenshots/04-settings-appearance-slate.png) | ![Messaging settings](./docs/screenshots/05-settings-messaging-slate.png) |
| Settings → Appearance theme cards | Settings → Messaging with the Telegram bridge supervisor |
| ![Routines builder](./docs/screenshots/06-routines-builder-paper.png) | ![Routines canvas](./docs/screenshots/06-routines-canvas-paper.png) |
| V1 routines builder editing `daily-briefing` in form mode | The same routine in canvas mode — every step is a node |

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
- **Knowledge base** — `/kb` view over your local Karpathy-style llm-wiki at
  `~/kb` (override via `OMP_DECK_KB_ROOT`). Lazy tree, markdown viewer with
  `[[wikilink]]` resolution + create-on-click, in-pane editor, Obsidian-
  style force-directed graph view (`?view=graph`) with click-to-isolate per
  source directory, full-text search + Ctrl-P quick-open palette, inspector
  with outbound links + backlinks + tag chips + orphan badge. Empty kb
  surfaces a one-click setup flow. Hide subtrees with
  `OMP_DECK_KB_EXCLUDE_DIRS=<csv>`.
- **Skills** — `/skills` surfaces every skill omp loads across all providers
  (`native`, `claude-plugins`, `claude`, `codex`, …), not just marketplace
  plugins. Native (`~/.omp/agent/skills/`) sorts first. Ships an omp-native
  `create-skill` starter — first-party authoring loop with no Claude-Code
  dependencies.
- **Maintenance gate** — bundled omp SDK extension (installed to
  `~/.omp/agent/extensions/` on boot) that nudges the agent at turn-end
  (~every 10 turns) to capture reusable output into the canonical org
  folders (`inbox/`, `tasks/`, `knowledge/`, `queries/`, `context/`, …)
  or state "No maintenance needed" to release. Structural org-root sniff
  only activates for cwds with the canonical layout. Universal across
  deck, omp TUI, and ACP sessions (the deck wires `ExtensionRunner` into
  `InProcessAgentBridge`).
- **Kanban** with Jira-style display IDs (`T-1`, `T-2`, ...), drag-and-drop,
  configurable columns, and live WebSocket broadcasts — agent or external
  scripts mutating tasks refresh every open kanban without polling.
- **Routines V1** — multi-step pipelines, not single-action cron jobs. A
  routine is a typed YAML spec with `run` / `agent` / `http` / `write` / `deck`
  / `mcp` / `transform` / `wait` / `set_state` steps plus four trigger kinds
  (`cron`, `webhook`, `manual`, `event`). Author them visually in the new
  **canvas builder** (drag, drop, wire branches with `if`-flavored nodes),
  in form mode, or directly as YAML — all three round-trip the same spec.
  Live run observability paints per-step status rings, durations, and model
  / cost badges on the canvas; node-click opens the captured `stdout` /
  `stderr` / structured JSON. Ships with a `daily-briefing` template that
  hits the deck's own kanban + inbox and writes a morning summary back via
  the `deck` action steps.
- **Inbox** — quick capture surface with promote-to-task.
- **Settings** — masked secret store with atomic `.env` writes + audit log,
  hot-applied env updates where possible, a one-click server restart for the
  rest. Paper / Slate / Horizon themes with FOUC-free pre-paint.
- **Marketplace** — browse and install plugins/skills/MCPs over the SDK's
  `MarketplaceManager`. Empty state seeds with
  `anthropics/claude-plugins-official`.
- **Model picker** — chat-header modal listing every model the SDK knows
  about, default-filtered to ones with configured auth, provider-grouped.
- **Telegram bridge** — standalone Bun process supervised by the deck; DM the
  agent from your phone with allowlist gating and streaming `editMessageText`
  replies.

## How it compares

omp-deck only makes sense as a pair with the
[`omp`](https://github.com/can1357/oh-my-pi) coding agent — omp is the agent
loop, omp-deck is the cockpit you drive it from. Compared against the closest
neighbors in the agentic-coding space:

|                                | **omp + omp-deck**                                                                | **[Claude Code](https://github.com/anthropics/claude-code)** | **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** | **[OpenClaw](https://github.com/openclaw/openclaw)**                       |
|--------------------------------|-----------------------------------------------------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------|----------------------------------------------------------------------------|
| Form factor                    | Terminal TUI (omp) + web cockpit (omp-deck)                                       | Terminal CLI / IDE plugin                                    | Terminal TUI + multi-channel gateway                             | Daemon + multi-channel gateway                                             |
| Underlying agent               | omp, in-process via `@oh-my-pi/pi-coding-agent` SDK                               | Anthropic-built CLI                                          | Hermes core (Nous Research)                                      | OpenClaw Gateway                                                           |
| Model support                  | Anthropic, OpenAI, Google AI / Vertex, OpenRouter, Ollama, llama.cpp, LM Studio, any OpenAI-compatible | Anthropic Claude only                                        | Model-agnostic (Nous Portal, OpenRouter, NIM, …)                 | Model-agnostic (profiles in `openclaw.json`, w/ fallback chain)            |
| Hosting                        | Self-hosted Bun process, loopback-only by default                                 | Anthropic-hosted CLI                                         | Local / Docker / SSH / Modal / Daytona / Vercel Sandbox          | Self-hosted on owned host (Mac mini, VPS)                                  |
| Auth                           | OAuth, API key, or provider key — shared with the omp CLI                         | Anthropic OAuth / API key                                    | Per-provider keys                                                | Per-provider keys + profile rotation                                       |
| Multi-session chat             | First-class sidebar in the deck                                                   | Single session at a time                                     | Single agent across channels                                     | Per-channel sessions                                                       |
| Kanban / task board            | Built-in, WS-synced, `T-N` display IDs                                            | —                                                            | —                                                                | —                                                                          |
| Routines / scheduled work      | V1 multi-step pipelines (`run`/`agent`/`http`/`write`/`deck`/`mcp`/`transform`/`wait`/`set_state`); cron / webhook / manual / event triggers | — | — | Heartbeat scheduler (~30 min)  |
| Visual builder & observability | React Flow canvas: graph authoring with branch compilation, drag-position persistence, per-step run status rings + duration / model / cost badges, click-to-output preview | — | — | — |
| Knowledge base                 | `/kb` cockpit over local `~/kb` markdown wiki: tree + viewer + editor, `[[wikilink]]` resolution + backlinks, force-directed graph, full-text + Ctrl-P search | —                                                            | "Deepening user model" (internal, not a markdown wiki)           | —                                                                          |
| Inbox + promote-to-task        | Built-in                                                                          | —                                                            | —                                                                | —                                                                          |
| Plugins / skills               | SDK loader + in-app marketplace (Anthropic plugin format)                         | `claude plugins` registry                                    | Skills with autonomous creation + refinement                     | Skills installed from ClawHub; skills can write skills                     |
| Self-improving over time       | Maintenance-gate extension nudges the agent to capture reusable output into `knowledge/` / `tasks/` / `inbox/` each turn; skills themselves are user/marketplace-authored | — | ✅ learning loop, deepening user model | Skills can self-install |
| Messenger bridges              | Telegram (Slack / Discord / Matrix on the roadmap)                                | —                                                            | Telegram, Discord, Slack, WhatsApp, Signal                       | 20+ (WhatsApp, Telegram, Slack, Discord, iMessage, Matrix, Teams, …)       |
| License                        | MIT                                                                               | Proprietary (Anthropic Commercial Terms)                     | Open source (Nous Research)                                      | Open source                                                                |

The short version: **Claude Code** is the polished, vendor-supported terminal
experience for Claude. **Hermes** is the self-improving agent that compounds
skills over time and supports serverless backends. **OpenClaw** is the
multi-channel personal assistant that lives wherever you message from.
**omp + omp-deck** is the cockpit shape — a model-agnostic coding agent in
your terminal *plus* a kanban / multi-step routines with a visual builder /
inbox / knowledge-base cockpit / marketplace / Telegram-bridge web surface
to drive it.

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

On Windows, you can also double-click `Start-OMP-Deck.cmd` from the repo root.
It starts the background API server on <http://127.0.0.1:8787>, starts the
Vite web app on <http://127.0.0.1:5173>, opens the deck in your browser, and
writes process logs under `.logs/`.

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
- [Skills](./docs/skills.md) — `/skills` view, plugin→skill hierarchy, scope
  semantics, live refresh, REST surface.
- [Telegram bridge](./docs/telegram.md) — DM-driven agent from your phone.
- [Themes](./docs/themes.md) — Paper / Slate / Horizon / adding more.
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

**v0.2 shipped:**

- KB Cockpit (tree / viewer / editor / graph / search / inspector) over
  `~/kb` with live updates.
- Skills cockpit pivoted to omp-native (`loadCapability` over all providers).
- Bundled `create-skill` and `maintenance-gate` starters; deck installs
  them on boot and `InProcessAgentBridge` now wires `ExtensionRunner` so
  extensions actually fire in deck sessions.
- Horizon theme (ported from
  [opus-extensions/omp-themes/horizon.json](https://github.com/vincitamore/misc/tree/main/opus-extensions/omp-themes)).
- External links open in a new tab across every markdown surface.
- CRLF-tolerant frontmatter parsing fixes Windows-saved YAML.

**Still deferred:**

- Permission prompts (`ask` tool) via bidirectional WS UI bridge.
- Plan-mode UI (banner + plan file viewer).
- File browser in the inspector.
- Subprocess-per-session bridge impl for crash isolation.
- Slack / Discord / Matrix bridges (same supervisor pattern as Telegram).
- `bunx omp-deck` install path / Docker image build verified.

## License

MIT. See [LICENSE](./LICENSE).
