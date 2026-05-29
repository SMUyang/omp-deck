# Slash commands

Type `/` in any composer to open the picker. Commands come from four scopes:

| Scope | Source | Dispatch | Example |
|---|---|---|---|
| **deck** | Built into omp-deck. | In-process. No model round-trip. | `/task add <title>`, `/plan` |
| **builtin** | omp SDK. Filtered to commands with text-mode handlers. | In-process via SDK dispatcher. No model round-trip. | `/context`, `/usage`, `/tools`, `/compact`, `/dump`, `/memory view`, `/mcp add ...` |
| **user** | Markdown files at `~/.omp/agent/commands/*.md`. | Expanded into the prompt; the model interprets. Costs tokens. | Whatever you write. |
| **project** | Markdown files at `<cwd>/.omp/agent/commands/*.md`. | Same as user, but per-workspace and shadows user with the same name. | Whatever you write. |

Picker filtering is fuzzy across name + description. Subcommands (e.g.
`/mcp add`, `/copy last`) are flattened into top-level entries so typing
`/add` surfaces `/mcp add` and `/task add` side by side.

Some deck commands (`/plan`) are **client-virtual**: they're injected into
the picker by the web client and never sent over the WS as text. Selecting
one — or typing it + Enter — dispatches a typed WS frame directly. Useful
for UI shortcuts that don't need to round-trip through the agent.

## Deck slash commands

Deck-native commands operate directly on the kanban / inbox / routines DB.
They never hit the model and respond instantly. The synthetic assistant
message is marked **SYNTHETIC** in the chat so you can see at a glance it
didn't burn tokens.

### `/task add <title>`

Files a new backlog task in the current workspace. Output: `Created T-32:
Refactor the foo (backlog)`. Broadcasts `tasks_changed` so any open kanban
view refetches instantly.

```
/task add Wire up retry counter on the model picker
```

### `/task list [state]`

Lists tasks. Default: backlog + active for the current `cwd`. Optional
`[state]` filters to a single column (substring-matched against
`task_states.name`).

```
/task list
/task list done
/task list act    # substring matches "active"
```

### `/task done <T-id|ULID>`

Moves a task to the `done` column. Accepts either the display id (`T-32`) or
the underlying ULID. Output: `T-32: active → done`.

```
/task done T-32
```

### `/task move <T-id|ULID> <state>`

Moves a task to any column. State match is case-insensitive substring.

```
/task move T-32 blocked
/task move T-32 active
```

### `/plan [on|off]`

Toggles plan mode on the active session. Bare `/plan` flips the current
state; `/plan on` and `/plan off` are explicit. Equivalent to **Shift+Tab**
in the composer.

While plan mode is on, the agent gets the SDK's plan-mode system prompt +
the `resolve` tool added to its active tool set, so writes are gated until
the user approves. When the agent submits a plan via `resolve apply`, the
chat surfaces an inline `PlanApproval` card with **Reject**, **Approve**,
and **Edit & approve**. State indicators: header pill, composer border
tint, sidebar badge on the active session row.

Client-virtual — the command is intercepted by the composer and dispatched
as a `set_plan_mode` WS frame; it never enters the chat as text and costs
zero tokens.

```
/plan          # toggle
/plan on       # explicit enter
/plan off      # explicit exit
```

## SDK builtins (text-mode subset)

The deck filters the SDK's full registry to only commands that ship a
text-mode handler — anything that needs a TUI selector (`/model`,
`/agents`, `/login`, `/settings`, `/marketplace`) is hidden from the picker
because it can't drive an interactive selector through the chat. Use the
deck's native UI surfaces for those (model picker in the chat header,
marketplace nav entry).

The commands that **do** work:

- `/context` — render context-window utilization.
- `/usage` — render token/cost rollup.
- `/tools` — list available tools.
- `/compact [focus]` — manual compaction with optional focus instructions.
- `/dump` — emit the full transcript as plain text.
- `/rename <title>` — rename the current session.
- `/memory view`, `/memory clear`, `/memory enqueue` — manipulate the SDK
  memory subsystem.
- `/mcp add`, `/mcp list`, `/mcp remove`, `/mcp smithery-search <q>`,
  `/mcp install <id>` — MCP server registry operations.
- `/changelog` — show the SDK changelog inline.
- `/browser headless`, `/browser visible` — toggle browser tool mode.
- `/todo add`, `/todo list`, `/todo complete` — manipulate the **agent's
  session-local** todo plan (NOT the deck kanban — see below).

The full set: hover any picker entry's `BUILTIN` badge for the tooltip.

## Difference between `/todo` and `/task`

| | `/todo` (SDK builtin) | `/task` (deck) |
|---|---|---|
| Storage | In-memory on the active agent session | Persistent SQLite (`deck.db`) |
| Lifetime | Dies with the session | Persistent across sessions / restarts |
| Surface | Chat todos panel (right inspector) | Kanban (`/tasks`) |
| Owner | The LLM, for mid-turn planning | You, for durable work tracking |

`/todo` is the agent's scratchpad for "I'm going to do these five steps".
`/task` is your kanban for "this project needs these features built".

## User and project commands

Drop a markdown file in `~/.omp/agent/commands/<name>.md` (user-global) or
`<cwd>/.omp/agent/commands/<name>.md` (project-local). The deck picker
discovers them on every session create.

Example: `~/.omp/agent/commands/recap.md`

```md
---
description: Summarize what was just discussed
---

Recap the last 10 messages of this conversation in 3 sentences.
Emphasize any decisions made.
```

Picker shows `/recap · Summarize what was just discussed · USER`.

Project commands shadow user commands with the same basename. A `recap.md`
in `<cwd>/.omp/agent/commands/` overrides the user-global one for sessions
opened in that workspace.

## Dispatching from non-chat code

The deck's REST surface exposes the same commands you'd type in the chat:

- `POST /api/tasks { title, stateId? }` — equivalent to `/task add`.
- `PATCH /api/tasks/:id { stateId }` — equivalent to `/task move`.
- `DELETE /api/tasks/:id`.

So a routine, a webhook, or another script can drive the kanban from
outside the chat — and the WS broadcast still fires, keeping every open
kanban view live.
