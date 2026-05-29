# Contributing to omp-deck

Thanks for your interest. omp-deck is a small enough project that there is no
heavyweight process — but a few conventions keep the codebase tidy.

## Repo layout

```
apps/
  server/          # Bun + Hono backend that embeds @oh-my-pi/pi-coding-agent
  web/             # Vite + React + Tailwind frontend
  bridges/
    telegram/      # Standalone Bun process — long-poll Telegram bridge
packages/
  protocol/        # Dep-free shared types (REST + WS frames)
docs/              # Markdown documentation site
```

Workspaces are wired through Bun's `workspaces` field in the root `package.json`.

## Dev loop

```sh
bun install
bun run dev          # spawns server (8787) + vite (5173) in parallel
```

If you want them in separate terminals:

```sh
bun run dev:server
bun run dev:web
```

The telegram bridge only runs on demand (Settings → Messaging → Start, or `bun run dev:telegram`).

## Developing without disrupting your daily-driver deck

`bun --hot` re-evaluates `apps/server/src/index.ts` on every save and Vite
hot-reloads `apps/web/src/**` in place. That's great for the inner loop but
it also means a single working tree can't host a "production" deck you're
using and a "dev" deck you're iterating on simultaneously — every edit
bounces the deck you're chatting in.

The fix is a parallel checkout via `git worktree`, env-isolated:

```sh
# from the existing checkout
git worktree add ../omp-deck-dev -b dev/<feature>
cd ../omp-deck-dev
bun install
cat > .env <<'EOF'
OMP_DECK_PORT=8889
OMP_DECK_WEB_PORT=5273
OMP_DECK_DB_PATH=$PWD/apps/server/data/deck.dev.db
OMP_DECK_DATA_DIR=$PWD/.deck-data
EOF
bun run dev      # dev deck lives at http://127.0.0.1:5273
```

The two instances now share **history only**. Five env vars give you full
state separation:

| Concern                  | prod tree            | dev worktree                     |
| ------------------------ | -------------------- | -------------------------------- |
| Server port              | `OMP_DECK_PORT=8787` | `OMP_DECK_PORT=8889`             |
| Web (Vite) port          | `5173`               | `OMP_DECK_WEB_PORT=5273`         |
| Kanban / inbox / routines| `deck.db`            | `deck.dev.db`                    |
| Managed `.env`, audit log| default `DATA_DIR`   | `OMP_DECK_DATA_DIR=.deck-data`   |
| OAuth credentials + sessions | `~/.omp/agent/`  | same by default; set `OMP_AGENT_DIR` to isolate when testing the OAuth flow itself |

Leave `OMP_AGENT_DIR` unset for routine dev so you don't re-login to Claude /
Codex on every dev iteration. Set it to a fresh dir only when the change
under test touches `auth.db` and you need to repeatedly clear the
no-credentials state.

Merge the branch back when ready; `git worktree remove ../omp-deck-dev`
tears down the tree but keeps the branch and its commits.

### What survives vs. dies on restart

Survives on disk: tasks, inbox, routines, run history, session transcripts,
auth credentials, settings.

Dies on server restart: in-flight WS streams, in-progress agent turns,
in-memory session caches, half-completed OAuth flows (the SDK's loopback
listener is the recipient — losing the process loses the listener).

That's exactly why the worktree pattern matters: your "I'm using it right
now" deck only restarts when **you** decide to merge and bounce it.

## Code quality

- `bun run typecheck` must pass before opening a PR.
- `bun run --filter '@omp-deck/web' build` must build clean.
- New REST routes go through `packages/protocol` types — no `any` at the wire.
- New SDK touchpoints go through `apps/server/src/bridge` — the route layer
  must not import `@oh-my-pi/pi-coding-agent` directly.
- WS broadcast frames go through `apps/server/src/broadcast-bus.ts`.
- Deck slash commands live in `apps/server/src/deck-slash-commands.ts`.

## Testing changes

Bun test runs across server + web + protocol workspaces:

```sh
bun test                  # all workspaces
cd apps/server && bun test
cd apps/web && bun test
```

Coverage is partial — heavy on the bridge layer (plan-mode, queue shadow,
todo synthesis, ext-ui dialogs, reducer event handling) and DB layer
(tasks, routines, notifications, deck-action steps). UI components +
routes are still primarily verified end-to-end via:

1. `bun run typecheck` across every workspace.
2. Manual browser smoke against `http://127.0.0.1:5173`.
3. API smokes — small PowerShell or curl scripts under `.logs/` (gitignored).

When you add a feature with non-trivial state, ship at least the
bridge-side test alongside it. Reducer cases want a unit test apiece —
look at `apps/web/src/lib/reducer.test.ts` for the pattern.

## Style

- TypeScript strict mode is on. No `// @ts-ignore` without a justification comment.
- Tailwind tokens through the theme system (`rgb(var(--token) / <alpha-value>)`).
  Do not introduce raw hex colors outside `apps/web/src/styles.css`.
- React: function components, hooks. No class components, no HOCs.
- Server: Hono + Bun. No Express.

## Commits

Conventional Commits welcome but not enforced. Keep messages descriptive —
"fix bug" is not enough; "fix: kanban refetch missed broadcast on inbox-promote"
is.

## Filing issues

If you hit a bug, a minimal repro plus your `bun --version`, OS, and
`@oh-my-pi/pi-coding-agent` version is all we need.

## License

By contributing you agree that your contributions are licensed under the MIT
license (see [LICENSE](./LICENSE)).
