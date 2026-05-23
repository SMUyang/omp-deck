# TUI parity

This is the long-form reference for which omp TUI features omp-deck reaches
parity on. Updated alongside SDK upgrades.

| Surface | Status | Notes |
|---|---|---|
| Streaming text | ✓ | Live deltas with blinking caret while in-flight. |
| Thinking blocks | ✓ | Collapsible; auto-open while streaming. |
| Tool calls | ✓ | Per-tool specialized renderers + generic fallback. Lifecycle (running → done/error) shown with status badge + duration. |
| Hashline diffs | ✓ | `edit` tool renders the patch with op-coloring (`@@` / `+` / `-` / `=` / `<` / `~`). |
| Todos panel | ✓ | Live from `todo_reminder` / `todo_auto_clear`; phase + per-task status icons. |
| Cost / usage | ✓ | Inspector strip rolls up input/output/cache/reasoning tokens + USD cost across turns. |
| TTSR injection | ✓ | Inline banner in chat + chrome badge. |
| Compaction | ✓ | Status badge during compaction; archived summary inline. |
| Auto-retry | ✓ | Retry attempt counter in status bar. |
| Notice events | ✓ | Inline info/warning/error cards. |
| Pasted text | ✓ | Native textarea behavior, no surprises. |
| Pasted / dragged images | ✓ | Encoded to base64, thumbnail strip in composer, `[Image #N]` placeholder inserted at cursor — same UX as the TUI. |
| Image attach button | ✓ | Paperclip; multi-select; accepts `image/*`. |
| Multi-session sidebar | ✓ | Lists active (live badge) and persisted sessions, with workspace filter. |
| Workspace switcher | ✓ | Pulled from `~/.omp/agent/sessions/*` grouped by cwd plus configured roots. |
| Session resume | ✓ | Clicking a persisted session rehydrates via `SessionManager.open`. |
| Abort while streaming | ✓ | Composer flips to red Abort button. |
| Context-window indicator | ✓ | Header pill with manual-compact popover. |
| Slash command picker | ✓ | Four scopes (deck / builtin / user / project). Fuzzy filter, subcommand flattening. |
| Built-in slash command dispatch | ✓ | Text-mode SDK commands dispatch in-process. No model round-trip for `/context`, `/compact`, `/usage`, `/tools`, `/dump`, `/memory *`, `/mcp *`. |
| Deck-native slash commands | ✓ | `/task add`, `/task list`, `/task done`, `/task move` operate directly on the kanban. |
| `@filepath` mention autocomplete | ✓ | Fuzzy match against the active workspace; respects gitignore. |
| Copy buttons on code blocks | ✓ | Every `<pre>` gets a hover-revealed Copy button. |
| Model picker | ✓ | Chat-header modal with available/all toggle, provider grouping, active marker. |
| Marketplace browser | ✓ | Three-panel view over the SDK's `MarketplaceManager`. Suggested seed: `anthropics/claude-plugins-official`. |
| Themes | ✓ | Paper / Slate with system-preference following and FOUC-free pre-paint. |
| Permission prompts (`ask` tool) | — | Future. Needs WS round-trip extension for `extension_ui_request`. |
| Plan-mode UI | — | Future. State surface ready (`session.mode`). |
| Model fallback chain editing | — | Future. The SDK handles it; the deck just shows the active primary. |
| Skill management UI | — | Future. Backlog ticket exists. See `docs/slash-commands.md` for current discovery surface. |
| `/marketplace` slash command | — | TUI-only in the SDK; deck filters it out and exposes the same functionality via the Marketplace nav entry instead. |
| `/model` slash command | — | TUI-only in the SDK; deck filters it out and exposes the same functionality via the chat-header model picker. |
| `/copy` family (clipboard) | — | TUI-only in the SDK. The deck's per-codeblock Copy buttons cover the most-common case. |

## What "TUI-only" means

The omp SDK's slash-command registry tags each command with which handler
it ships. Some commands have a `handle` for text/ACP mode — these work
anywhere, including the deck. Others have only `handleTui`, which expects a
live `InteractiveModeContext` (editor selectors, status line, fuzzy carousel
widgets) that doesn't translate to web UI.

The deck filters its picker to the ACP-enabled set. Commands with
TUI-equivalent web UIs (model picker, marketplace) get first-class deck
features instead of being shoehorned through a chat-side selector. See
[docs/slash-commands.md](./slash-commands.md) for the dispatch matrix.

## What omp-deck adds on top of the TUI

These are deck-only — the TUI doesn't have them:

- **Kanban** with display IDs, drag-and-drop, configurable columns.
- **Routines V1** — multi-step pipelines (`run` / `agent` / `http` / `write` / `deck` / `mcp` / `transform` / `wait` / `set_state`) with `cron` / `webhook` / `manual` / `event` triggers, a visual canvas builder, and per-step run observability.
- **Inbox** quick-capture with promote-to-task.
- **Settings → Env** with masked secret store and audit log.
- **Messaging bridges** (Telegram now; Slack/Discord-shaped to come).
- **Live kanban broadcasts** — agent or external scripts mutating
  `/api/tasks` cause every open kanban to refresh instantly without polling.
- **Themes** with full runtime swap.
- **Multi-session sidebar** with workspace grouping.
