# omp-deck

**A calmer place to drive your coding agent.**

The [`omp`](https://github.com/can1357/oh-my-pi) terminal agent is excellent at the actual coding. But terminals weren't built for everything that comes with running an agent for hours a day — keeping track of what it's working on, glancing at it from another room, picking up where it left off tomorrow, deciding whether to let it execute the thing it just proposed.

omp-deck is the cockpit you drive omp from when the terminal isn't enough. Same agent, same authentication, same models. Different surface — one that gives the work a place to live.

> **Status:** v0.3.0 — plan mode, queued-prompt editing, todo live-sync, KB cockpit. See [CHANGELOG.md](./CHANGELOG.md).

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

## Who this is for

You're already running an agent. You've felt the friction of trying to:

- **Track what it's actually doing for you** as a body of work, not a scroll of terminal output that ends at `Ctrl+L`.
- **Ask it something from somewhere that isn't your laptop** — the couch, a walk, bed.
- **Decide carefully** when it's about to do something big, instead of trusting it on the first try.
- **Capture an idea or a bug** without breaking your current focus.
- **Have it remember things** across sessions without you stuffing context windows by hand.

omp-deck is the cockpit that holds all of that. The chat surface stays at parity with the terminal — but everything *around* the chat is built for the rest of the work.

## What you get

**A kanban that's actually yours.** Backlog → Active → Done columns with drag-and-drop. Tasks get `T-N` display IDs you can refer to in conversation (`/task done T-32`). The agent can mutate the board too — its work becomes visible without you doing the bookkeeping.

**Plan mode** — Shift+Tab in the composer (or `/plan`) flips the active session into read-only-with-resolve mode. The agent investigates, drafts a plan, and surfaces it for your approval. Edit before approving, reject if it's wrong, or hit Approve and watch it execute with full tools restored. Borrowed verbatim from the TUI; brought to where the rest of your workflow lives.

**An inbox you can dump into.** Scratch ideas, bug reports, decisions to revisit. One-click promote to task when the dust settles. No mental context-switch from current work.

**A knowledge base over your own markdown.** Point `/kb` at a `~/kb` directory you already keep (or accept the default), and the deck gives you a tree, viewer, editor, Obsidian-style force-directed graph, full-text search, `[[wikilink]]` resolution + create-on-click. Long-term memory that's plaintext-portable and outlives any agent session.

**Routines.** Multi-step pipelines on a cron, webhook, manual, or event trigger — author them visually on a node canvas, or in YAML if you're that kind of person. Ships with a `daily-briefing` template that wakes up, reads your kanban + inbox, and writes you a one-card morning summary back to the inbox. Build your own from there.

**A messaging bridge to your phone.** Telegram now (Slack / Discord / Matrix on the roadmap). DM the agent from anywhere; replies stream live via `editMessageText`. Allowlist-gated so only you (and whoever you invite) can drive it.

**Multi-session.** The chat sidebar lists every session you have open, plus the persisted ones you can resume. Each gets its own kanban scope, its own model, its own queued prompts. Switch between them without losing place.

**A marketplace.** Browse, install, and uninstall skills/plugins/MCPs over the SDK's plugin format. Empty state seeds with `anthropics/claude-plugins-official` so you're never staring at an empty page.

**Settings that respect your `.env`.** Provider API keys, host/port, data dirs — all manageable from a UI with masked secrets, an audit log, and atomic writes. Hot-applied where possible.

**Three themes.** Paper (warm cream + rust accent, engineer's-notebook aesthetic), Slate (dark), Horizon (purple-ink dark). FOUC-free swap — pick one and refresh-proof it.

## Quickstart

If `omp` already works in a terminal on this machine:

```sh
git clone https://github.com/bjb2/omp-deck.git
cd omp-deck
bun install
bun run dev
```

Open <http://127.0.0.1:5173>. Your existing `~/.omp/agent` is picked up automatically — no re-auth.

On Windows, you can also double-click `Start-OMP-Deck.cmd` from the repo root — it boots the server on `:8787`, starts the Vite app on `:5173`, opens the deck in your browser, and writes logs under `.logs/`.

If you don't have omp yet, see [docs/install.md](./docs/install.md) for the full path (install Bun → install the omp CLI → authenticate → clone + run). Or skip the CLI entirely and paste a provider API key into Settings → Env after the deck is up.

## How it compares

omp + omp-deck is one slice of a busy space. The neighbors:

|                                | **omp + omp-deck**                                                                | **[Claude Code](https://github.com/anthropics/claude-code)** | **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** | **[OpenClaw](https://github.com/openclaw/openclaw)**                       |
|--------------------------------|-----------------------------------------------------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------|----------------------------------------------------------------------------|
| Form factor                    | Terminal TUI (omp) + web cockpit (omp-deck)                                       | Terminal CLI / IDE plugin                                    | Terminal TUI + multi-channel gateway                             | Daemon + multi-channel gateway                                             |
| Model support                  | Anthropic, OpenAI, Google AI / Vertex, OpenRouter, Ollama, llama.cpp, LM Studio, any OpenAI-compatible | Anthropic Claude only                                        | Model-agnostic (Nous Portal, OpenRouter, NIM, …)                 | Model-agnostic (profiles in `openclaw.json`, w/ fallback chain)            |
| Hosting                        | Self-hosted Bun process, loopback-only by default                                 | Anthropic-hosted CLI                                         | Local / Docker / SSH / Modal / Daytona / Vercel Sandbox          | Self-hosted on owned host (Mac mini, VPS)                                  |
| Kanban / task board            | Built-in, WS-synced, `T-N` display IDs                                            | —                                                            | —                                                                | —                                                                          |
| Plan mode                      | Shift+Tab / `/plan` → propose → approve/edit/reject before execution              | TUI plan-mode equivalent                                     | —                                                                | —                                                                          |
| Routines / scheduled work      | Multi-step pipelines + visual canvas + per-step observability                     | —                                                            | —                                                                | Heartbeat scheduler (~30 min)                                              |
| Knowledge base                 | `/kb` cockpit over local markdown wiki + graph + backlinks                        | —                                                            | "Deepening user model" (internal, not a markdown wiki)           | —                                                                          |
| Inbox + promote-to-task        | Built-in                                                                          | —                                                            | —                                                                | —                                                                          |
| Messenger bridges              | Telegram (Slack / Discord / Matrix on the roadmap)                                | —                                                            | Telegram, Discord, Slack, WhatsApp, Signal                       | 20+ (WhatsApp, Telegram, Slack, Discord, iMessage, Matrix, Teams, …)       |
| License                        | MIT                                                                               | Proprietary                                                  | Open source                                                      | Open source                                                                |

The short version: **Claude Code** is the polished vendor experience for Claude. **Hermes** is the self-improving agent with serverless backends. **OpenClaw** lives wherever you message from. **omp + omp-deck** is the cockpit shape — a model-agnostic coding agent with a web surface for the work *around* the chat (kanban, routines, KB, inbox, plan-mode approval, messaging bridge).

## A few notes on running it

**It's not a hosted product.** You run it yourself, on your machine or in a VM you own. Defaults are loopback-only — to reach it from your phone, front it with Tailscale Serve, an SSH tunnel, or a reverse proxy with its own auth. See [docs/deployment.md](./docs/deployment.md) for the hardening checklist.

**It's not a replacement for `omp`.** It embeds the same SDK in-process and shares the same `~/.omp/agent` session + auth store. Run both — they coexist. The terminal is still where you'll do quick one-shots; the deck is where work sticks around.

**State is yours.** Tasks, inbox, routines, KB — all SQLite + plain markdown on disk. No telemetry. The deck never logs secret values, only redacted forms.

## Docs

- [Install](./docs/install.md) — fresh vs existing-omp install paths.
- [Configuration](./docs/configuration.md) — full env reference + restart semantics.
- [Deployment](./docs/deployment.md) — Tailscale, Docker, SSH-tunnel, hardening checklist.
- [Slash commands](./docs/slash-commands.md) — deck `/task` + `/plan`, SDK builtins, user/project markdown commands.
- [Marketplaces](./docs/marketplaces.md) — catalog seeding, install semantics, capability badges.
- [Skills](./docs/skills.md) — `/skills` view, plugin → skill hierarchy, scope semantics, REST surface.
- [Telegram bridge](./docs/telegram.md) — DM-driven agent from your phone.
- [Themes](./docs/themes.md) — Paper / Slate / Horizon / adding more.
- [Start command template](./docs/start-command-template.md) — define `/start` for auto-orientation.
- [Architecture](./docs/architecture.md) — workspace layout, frame model, synthetic events, theming.
- [TUI parity](./docs/tui-parity.md) — feature matrix vs the omp TUI.
- [Contributing](./CONTRIBUTING.md) — dev loop, code quality, style.

## License

MIT. See [LICENSE](./LICENSE).
