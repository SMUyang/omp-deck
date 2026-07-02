# Changelog

All notable changes to omp-deck. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.7.0] — 2026-07-02 — CPA usage status and image lightbox

This fork release ships the current web cockpit state used by the RPC deck: unified image previews, RPC session-title/history fixes, and CLIProxyAPI/CPA actual request usage in the Status panel.

### Added

- **CPA usage Status panel** backed by `GET /api/status/cpa-usage`. The server reads `CPA_USAGE_BASE_URL`, `CPA_USAGE_USERNAME`, `CPA_USAGE_PASSWORD`, and optional `CPA_USAGE_TIMEOUT_MS`, calls the external collector with Basic Auth, and returns sanitized `1h` / `24h` / `7d` request usage windows. The UI labels this clearly as `CLIProxyAPI request usage, not remaining quota.`
- **Unified image lightbox** for pasted images and tool-generated screenshots/images. Images render inline first, then open in an accessible in-deck preview with keyboard/backdrop close, focus restoration, scroll lock, and multi-image navigation.
- **Next-roadmap plan** at `docs/superpowers/plans/2026-07-02-next-roadmap.md` covering subagent invocation visibility, session topology memory/auto-compact, workspace/session lifecycle, image-rendering diagnosis, and future release hygiene.

### Fixed

- RPC session discovery now handles OMP 16 title-slot JSONL files and syncs auto-generated session titles into the web sidebar/history without a refresh.
- RPC session resume uses the session file's actual cwd instead of treating the session path as cwd.

### Security

- CPA collector credentials stay server-side. The password is marked sensitive in env schema, is never sent to the browser, and is not written into launcher command lines or generated scripts.

## [0.6.1] — 2026-05-29 — In-app update notification

Small follow-up to v0.6.0. Adds a passive update-check pill in the StatusBar so future releases (this one and onward) become discoverable from inside the deck instead of requiring users to run `npm outdated -g`.

### Added

- **`↑ X.Y.Z available` pill** at the bottom-right of the deck chrome whenever the running version is behind what's published on npm. Click → opens the GitHub release notes in a new tab. The user runs `npm install -g omp-deck@latest` themselves; the deck never auto-updates. (#10)
- **`GET /api/version`** returns `{ current, latest, updateAvailable, lastCheckedAt, releaseUrl, packageUrl, disabled }`. The pill is just a thin renderer over this.
- **24-hour cached version check** against `https://registry.npmjs.org/omp-deck`. Same destination as `npm install`; no version-as-fingerprint, no analytics, no extra outbound traffic beyond one ~1 KB request per day.
- **Kill switch:** `OMP_DECK_DISABLE_UPDATE_CHECK=1` short-circuits the entire feature (no cache read, no network, no pill). Set it in your managed `.env` if you're on a locked-down network or just don't want the chrome.
- Cache lives at `<dataDir>/update-check.json` and is graceful on every failure mode (registry down, parse error, env disabled, malformed cache, version-compare failure) — the pill simply doesn't render.
- Semver-aware comparison via `Bun.semver.order` (so `0.10.0 > 0.9.0`, prereleases handled correctly).
- New protocol type: `VersionInfo`.
- 10 new tests on the update-check module (33 assertions): disabled-flag handling, cache hits at newer / same / older versions, semver edge cases, registry-error state, first-call empty-state + background refresh, response-shape sanity.

## [0.6.0] — 2026-05-29 — First-run onboarding + provider clarity + reliability fixes

Quality-of-life release driven by three live-demo reports plus a deliberate first-run-experience rewrite.

**For existing users:** see [docs/upgrading.md](./docs/upgrading.md) — the onboarding wizard does NOT trigger for installs with existing sessions or a moved welcome task. Everything you have keeps working.

### Onboarding wizard (#9)

- **Five-step first-run flow** at `/onboarding`, gated by a server-detected `needsOnboarding` flag. Brand-new users get walked through: kb scaffold → provider auth (Claude Pro/Max or ChatGPT Plus/Pro OAuth, or OpenRouter API key) → optional `/start` greeting → handoff to chat.
- **Returning-user detection** is silent: any existing session OR a welcome task that's not in backlog marks onboarding settled without ever showing the wizard. Existing installs upgrade cleanly.
- **Welcome task tile** on `SessionPicker` surfaces the seeded `T-1` task even if the user never clicks the Tasks tab.
- **Skip-but-remind toast** appears on the chat view if onboarding was X-ed out, pointing at `/onboarding` for a re-run.
- New server module `apps/server/src/onboarding-state.ts` + routes at `/api/onboarding/{state,complete,seed-kb-system}`. Reuses existing endpoints (`/api/kb/init`, `/api/orientation/start`, `/api/settings/env`, `/api/auth/oauth/*`) for the actual work.
- The wizard's `/start` template is static but the AGENT re-fetches live state on every fire (kb files, `/api/{tasks,routines,inbox}`), so it stays accurate as the deck grows.

### Model-picker clarity (#7)

- **`subscription` badge** in the model picker for genuine consumer-subscription providers (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Cursor, Perplexity Pro/Max, coding plans). Explicit allowlist — not the SDK's broader `getOAuthProviders()` which would have falsely badged Ollama / LM Studio / gateway services as "subscription."
- **Placeholder API keys suppressed.** `OPENAI_API_KEY=sk-your-XXXXhere` (and other `.env.example` leftovers — `your-api-key`, `<your-key>`, `changeme`, length-too-short keys per prefix family) no longer mark API-key providers as authenticated. The picker hides those rows from the default view instead of letting users click them and get back a 401.
- **401-recovery notification.** When a chat call returns auth-shaped error (`401`, `incorrect api key`, `unauthorized`) on an API-key provider AND a subscription provider carries the same model id with a real OAuth credential, the deck fires a `warn` notification suggesting the switch.

### OAuth flow lifecycle (#7)

- **5-minute server-side timeout** per OAuth flow. The SDK's own timeout only fires on the loopback callback listener — flows driven by `onPrompt` (e.g. Ollama endpoint input) could sit pending forever, blocking subsequent attempts with `409 already-in-flight`. Now force-cancelled.
- **Stale-flow eviction** on `POST /:provider/start`. If a duplicate start arrives and the held flow is past the timeout window, evict it inline instead of 409-ing forever.
- **`abortFlow` helper** drains `promptResolvers` too (latent bug — pre-fix `cancel` only rejected `manualCode`, leaving `onPrompt` deferreds hanging).
- **OAuth consent button** now uses `variant="primary"` instead of inheriting the low-contrast default ghost variant.

### Cross-platform reliability (#8)

- **Bun executable resolution** falls back to `Bun.which("bun")` when `process.execPath` points at a dead path. Fixes a macOS-reported `posix_spawn ENOENT '~/.bun/bin/bun'` when the user reinstalled Bun via Homebrew / asdf / mise after deck boot. Affects both telegram-bridge spawn and `scheduleRestart`.

### Added

- `docs/upgrading.md` — version-by-version migration notes.
- README "Global install" section rewritten to explicitly call out: `omp` CLI not required; Bun + Node prereqs; post-boot auth paths (OAuth or API key); and how the deck self-bootstraps `~/.omp/agent/` on first boot.
- `apps/server/src/credential-quality.ts` with `looksLikePlaceholderKey` (44 unit-test assertions).
- `apps/server/src/runtime-bun.ts` with `resolveBunExecutable` (4 tests).
- `apps/server/src/onboarding-state.ts` + `routes-onboarding.ts` (4 tests).
- `apps/server/src/routes-auth-oauth.test.ts` — 6 tests for the new `abortFlow` cleanup helper.
- `ModelInfo.isSubscription` field in `@omp-deck/protocol`.
- `OnboardingState` + `SeedKbSystem*` types in `@omp-deck/protocol`.

## [0.5.0] — 2026-05-28 — Cross-platform CI, Linux container, Mac/Linux launcher

Infrastructure release. v0.4.0 advertised macOS and Linux support but had never been empirically verified — every release was "tested on a Windows box, presumed to work elsewhere." v0.5.0 closes that gap: every push to main now runs the gates on all three platforms under the same Bun version, the Docker image actually boots, and Mac/Linux users get a launcher with parity to the Windows one.

Two real Linux bugs surfaced during the validation work and are fixed in this release.

### Fixed

- **Docker build is now correct end-to-end on Linux.** Two regressions were silently broken before v0.4.0 even though `docs/deployment.md` advertised the path:
  - `Dockerfile` stages now copy `apps/bridges/telegram/package.json` alongside the four other workspace manifests. The lockfile knows about five workspaces; copying only four made `bun install --frozen-lockfile` fail with "lockfile had changes".
  - Base image switched from `oven/bun:1.3.14-alpine` to `oven/bun:1.3.14` (Debian-slim, glibc). `@oh-my-pi/pi-natives` ships prebuilt `.node` binaries linked against glibc's `ld-linux-x86-64.so.2`; Alpine's musl libc fails to load them (no `linux-x64-musl` variant exists). Image is ~40 MB larger; the trade is a runtime that actually boots.

### Added

- **`Start-OMP-Deck.sh`** — bash sibling to the Windows `.cmd` launcher. Same shape (start dev server + Vite, write logs, open browser), plus `start` / `stop` / `status` subcommands. Bare invocation runs foreground equivalent to `bun run dev`.
- **GitHub Actions CI matrix** (`.github/workflows/ci.yml`) — runs `bun install --frozen-lockfile` + `bun run typecheck` + `bun test` + `bun --cwd apps/web run build` on `ubuntu-latest` / `macos-latest` / `windows-latest`. Separate `docker` job builds the image and smoke-tests `/api/health` on every push to `main` and every PR. Catches platform-divergent regressions before release instead of at user-install time.

## [0.4.0] — 2026-05-28 — Plan mode, queued-prompt editing, todo live-sync, docs pass

Mid-cycle release focused on user-visible polish to the chat loop. Plan mode brings TUI parity to the deck so the agent can propose work before it executes. Queued prompts you sent mid-stream can now be edited or cancelled. The Inspector's todo panel updates intra-turn instead of waiting for SDK reminder ticks. Session rename failures surface their error instead of silently reverting. The README was rewritten human-forward and the supporting docs got an accuracy pass.

### Plan mode (T-105)

- **Shift+Tab in the composer** (or **`/plan [on|off]`** from the slash picker) toggles plan mode for the active session. Equivalent to the TUI's `app.plan.toggle`; the slash command is client-virtual — intercepted by the composer and dispatched as a `set_plan_mode` WS frame without round-tripping through the agent.
- **While active**, the agent gets the SDK's plan-mode system prompt + the `resolve` tool spliced into its active tool set. The SDK's `#enforcePlanModeToolDecision` intercept gates writes. The agent investigates with read-only tools and writes the finalized plan to `local://PLAN.md`.
- **When the agent calls `resolve apply`**, the deck surfaces a `PlanApproval` inline card in the chat with **Reject** / **Approve** / **Edit & approve**. Approve renames `local://PLAN.md` to `local://<title>.md` and queues a synthetic execute prompt that runs in a new turn with the full tool set restored. Reject exits plan mode cleanly with no rename.
- **State indicators**: header pill, composer border tint (`accent-plan`), sidebar badge on the active session row.
- **Robust to reconnect**: pending plan proposals are replayed via the bridge's `subscribePlanModeFrames` mechanism so a page reload mid-approval re-renders the card immediately.
- New protocol frames: `set_plan_mode`, `plan_response`, `plan_mode_changed`, `plan_proposed`, `plan_proposal_resolved`.
- New bridge surface: `PlanModeBridge` per-session state machine wrapping `setStandingResolveHandler` from the SDK; composes `resolvePlanTitle` + `renameApprovedPlanFile`.
- Server-side hardening: `sanitizeFinalPath` rejects path-traversal attempts (`local://../escape.md`) and falls back to the SDK-suggested final path.
- 15 unit tests covering enter / idempotent re-enter / exit / approve-happy-path / edit-and-approve / title-override / path-traversal-rejection / reject / double-click CAS / cancel-mid-approval / dispose / snapshot-replay.
- Design doc: `kb://projects/omp-deck/plan-mode-design.md`.

### Queued-prompt edit + cancel

- **Hover any queued bubble** in the chat to reveal Pencil + X buttons. Edit opens an inline textarea (Enter saves, Esc discards, empty save = cancel). Cancel drops the entry without prompting.
- Bridge maintains a `shadowQueue<QueuedPromptWire[]>` mirrored from the SDK's pending-prompt queue. Each entry carries a stable id the client uses to target a specific entry for cancel/edit.
- `cancelQueuedById` / `editQueuedById` rebuild the SDK queue (synchronous `popLastQueuedMessage` loop + parallel re-enqueue) preserving order + ids — edits don't re-key the bubble.
- `queue_state` event re-broadcasts the canonical queue after every mutation; reducer replaces wholesale.
- `prompt_queued` shadow tracking aligns its text against the SDK's post-expansion store so slash-expanded prompts match on drain.
- Session snapshot now carries `queuedPrompts`, so a page-reload subscriber sees the queue immediately instead of waiting for the next mutation.
- Reducer test coverage: queue lifecycle + `queue_state` + snapshot hydration (16 tests in `apps/web/src/lib/reducer.test.ts`).

### Todo panel live-sync (T-106)

- The Inspector's TodoPanel was visibly stale between an agent's `todo_write` call and the SDK's next `todo_reminder` tick (those fire only on reminder cycles, typically at turn boundaries). For long turns with many todo updates the panel showed pre-tick state until the cycle caught up.
- Bridge now extends the existing `session.subscribe` listener in `attach()` to detect `tool_execution_end` with `toolName=todo_write` and emit a synthetic `todo_phases_set` event carrying `session.getTodoPhases()`. Same pattern as the existing `context_usage` synthesis on `turn_end` / `agent_end` / `compaction_complete`.
- Reducer handles `todo_phases_set` by calling `normalizeTodoPhases(event.todoPhases)` directly. New event type avoids reusing `todo_reminder`'s quirky single-phase-wrapped-in-array shape.
- Tests: dedicated `todo-synthesis.test.ts` (5 cases) + 4 reducer cases.

### Session rename — surface failures

- The omp SDK's `setSessionName` performs an atomic-replace on the session journal: write to `.jsonl.tmp`, `fs.rename` over the original. **On Windows** `fs.rename` fails with `EPERM` when the destination is held open — and the live session always holds the journal open. So pressing Enter to rename produced a 500 error the store swallowed via `console.warn`; the input closed; the UI showed the old name with no indication anything had failed.
- Store: stopped swallowing the rename rejection; lets it propagate.
- ChatHeader: keeps the input open on failure, renders an inline danger-toned error span next to the rename input with `role=alert` + `aria-describedby`. Successful renames still close as before.
- Upstream: the underlying Windows EPERM bug is in the SDK's atomic-rename helper — to be raised separately with the omp folks.

### Universal `/plan` slash command discoverability

Removed the composer pill button in favor of the slash-command entry. Plan mode is now discoverable via five surfaces, all keyboard-/touch-friendly:

| Entry point | Where | When useful |
|---|---|---|
| `Shift+Tab` | Composer keyboard | Power users (matches TUI muscle memory) |
| `/plan` | Slash picker | Mouse/touch users; users browsing the picker |
| Header pill | Top of session pane | Visual state at a glance |
| Composer border tint | Around the textarea | Peripheral state cue while typing |
| Sidebar badge | Session row in sidebar | See which session is in plan mode at a glance |

### Fixed

- Fresh-clone `bun run dev` no longer fails on missing `TELEGRAM_BOT_TOKEN`. The root `dev` script was fanning out across every workspace (`--filter='@omp-deck/*'`) and bringing the standalone telegram bridge along with the deck server + web — the bridge's config validator throws if no bot token is set, so first-run users would hit an error before the UI ever came up. The bridge has always been opt-in (Settings → Messaging → Start, or `bun run dev:telegram`); the dev script now restricts itself to `@omp-deck/server` + `@omp-deck/web` to match the documented behavior in `CONTRIBUTING.md`.

### Docs

- README rewritten human-forward — leads with the feeling of using the cockpit (track work as work, ask from anywhere, decide carefully, capture without context-switching, remember across sessions) rather than a feature inventory. Concrete value props as section headers. Tech detail moved to docs links.
- `docs/tui-parity.md`: plan mode + ask-tool moved from Future to ✓ (both shipped). Themes row adds Horizon. New row for queued-prompt edit/cancel. Todos panel mentions the `todo_phases_set` synthesis. KB cockpit added to the deck-only list.
- `docs/slash-commands.md`: `/plan` section + scope row + client-virtual mechanism explanation.
- `docs/architecture.md`: synthetic events expanded (`todo_phases_set`, `prompt_queued` + `queue_state`, plan-mode trio, `ext_ui_dialog` pair). Broadcast frames list updated. Database tables list fleshed out with routines V1 (`routine_step_runs`, `routine_state`), `env_settings`, `bridge_state`. Stale v0.1 build caveat removed.
- `docs/themes.md`: third theme (Horizon) documented.
- `docs/configuration.md`: `OMP_DECK_AUTO_START` default corrected from "empty (disabled)" to `/start` (the actual default — it's opt-OUT, not opt-in).
- `CONTRIBUTING.md`: "No unit-test harness" claim retired — 149+ tests across server, 16+ in web/reducer; coverage is partial but real.

## [0.3.0] — V1 routines, V2 canvas, reliability + notifications, orientation + chat polish

Three big surfaces (V1 routines, V2 canvas builder, reliability + notification stack) land alongside a wave of smaller refinements (kanban polish, ask-tool bridge, starter skills, orientation Settings, queued prompts, kb:// resolution, image paste, app icon).

### Routines V1 — multi-step pipelines

Routines graduate from "single-action cron jobs" to a first-class agent platform: typed step pipelines, multiple trigger sources per routine, shared context across steps, persistent cross-run state, budget caps, and a form-mode visual builder so authoring doesn't require YAML literacy.

- Multi-step pipeline runner at `apps/server/src/routines/v1-runner.ts` dispatching 9 step types: `run`, `agent`, `write`, `http`, `deck`, `mcp` (stubbed for V1.5), `transform`, `wait`, `set_state`. Each step type has its own executor under `apps/server/src/routines/steps/`.
- `RoutineSpec` is a YAML doc persisted in `routines.spec_yaml` (V1 source of truth) with derived columns (`cron`, `concurrency`, `budget_json`, `tags`, `timezone`) mirrored for query speed. V0 single-action routines keep working — the runner branches on `spec_version`.
- Per-step persistence in `routine_step_runs` (status, stdout/stderr excerpts, structured JSON output, error, model, tokens in/out, cost micros, duration, retry attempt).
- Templating engine (`{{ run.id }}`, `{{ run.date }}`, `{{ steps.X.json.field }}`, `{{ steps.X.stdout }}`) at `apps/server/src/routines/template.ts`; value-mode preserves type for single-expression payloads, string-mode for embedded use.
- Sandboxed `when:` + `transform` evaluator at `apps/server/src/routines/sandbox.ts` using `quickjs-emscripten` with a 100ms wall-clock cap. Secrets redacted at marshal time.
- Three trigger sources per routine: `cron` (multi-cron supported), `webhook` (`POST /hooks/*` with `X-Routine-Signature: sha256=...` timing-safe HMAC verify), `manual` (`POST /api/routines/:id/run`). `event:` reserved in schema for V1.5.
- Concurrency policies: `skip` (default), `queue`, `cancel-previous`, `parallel`.
- Budget enforcer: `max_duration_secs`, `max_llm_cost_usd`, `max_llm_tokens_input/output`, `max_steps_executed`. Hard-aborts with `abort_reason: 'budget'`.
- Cross-run persistent state: `routine_state` table keyed by `(routine_id, key)`; `state.*` exposed in template + sandbox context; `set_state` step UPSERTs.
- Per-step `on_failure` (`abort` / `continue` / `retry`) + retry policy (`times`, `backoff: linear | exponential`, `max_delay_secs`, `after_retry`).
- `deck` step type with discriminated `action` for first-party mutations safer than raw `http`: `create_inbox_item`, `create_task`, `move_task`, `promote_inbox_item_to_task`. Single executor, schema validation, builder shows one form per action.
- Curated YAML templates under `apps/server/src/templates/`. `GET /api/routine-templates` lists; `POST /api/routine-templates/:slug` installs in disabled state for review. Ships `daily-briefing` as the V1 proof point (7 steps reading deck tasks + inbox, agent summary, deck inbox capture, state persist).
- Run observability: `/routines/:id/runs/:runId` RunDetailView with polling live updates, step expansion (stdout / stderr / json / error), replay, status pill. `GET /api/routines/:id/metrics` returns total / successCount / successRate30d / p50/p95 duration / mtdCostMicros / last-30 sparkline. WS frames `routine_run_started` / `routine_step_event` / `routine_run_finished`.

### Routines V2 — visual canvas builder

- React Flow surface under `apps/web/src/components/routines/canvas/`. Drag-position persistence into `layout.nodes`; add-step palette; slide-over inspector (inline ≥1100px, drawer <1100px).
- Edge authoring with `kind: success | true | false`; "if"-flavored nodes. Graph importer round-trips `RoutineSpec` ↔ nodes/edges through `stringifySpec` without data loss.
- Graph compiler (T-67/T-69) validates duplicate-id, missing-target, self-loop, cycle. Kahn topo-sort orders steps; AND-merges branch edges into downstream `when:` gates while preserving existing predicates. Compile errors gate Save and stamp red rings + floating message strip.
- Save preview dialog (T-70): modal opens when committing from canvas mode and the compiled YAML differs from the saved spec. LCS line diff with +N / -N summary and per-line gutter. Opt out via `OMP_DECK_CANVAS_SKIP_PREVIEW=1` or `localStorage["omp-deck:canvas-skip-preview"] = "1"`.
- Run overlay (T-71): `useRunOverlay` fetches recent runs + the selected run's step records and subscribes to the routine WS frames for live paint. StepNode renders pulsing status ring while running, duration / model / tokens / cost badges. Floating `RunOverlayPicker` scrubs through run history.
- Output preview + replay (T-72): StepInspector grows a "Last run" section with status pill, duration, tabs over stdout / stderr / json / error. "Open in Run Detail" deep-links to `/routines/:id/runs/:runId#step-<stepId>`; `RunDetailView` reads the hash fragment, auto-expands the matching StepCard, scrolls it into view.
- Form-mode editor (Tier 1) preserved alongside the canvas. Same JSON Schemas Ajv validates against — single source of truth, two renderings. Tabs: Steps / Triggers / Settings / Spec (YAML). Form ↔ YAML round-tripping with line-numbered parse errors on invalid YAML.
- Agent-step sandbox fix: `runV1Pipeline` now takes `agentSandboxRoot` and lazily `mkdir`s `<dataDir>/routine-runs/<runId>/` on the first agent step; `omp -p` runs there instead of `$HOME`, so the embedded coding agent can't latch onto unrelated files in the user's home as briefing material.

### Reliability + notifications (T-85)

- `build-info` module resolves `serverStartedAt`, `pid`, `version`, `buildSha` at boot. `/api/health` enriched with these + `uptimeSecs`.
- `WsHub` broadcasts `heartbeat` ServerFrame every 5s via `broadcastBus`.
- `supervise-deck-server.ps1` wraps the deck server with restart-on-crash, exponential backoff (1s-60s, resets after >30s lifetime), give-up at 10 consecutive quick exits; decisions logged to `.logs/supervisor.log`.
- Web `ConnectionIndicator` dot in header (green / yellow / red by heartbeat gap), tooltip exposes server identity + uptime.
- `NotificationService` with pluggable channel registry; default channel failure does not block siblings; envelope stamped with uuid + timestamp; default sound rules (info silent, warn+ audible) overridable.
- `BrowserNotificationChannel` broadcasts `notification` ServerFrame. Protocol: `notification` + `heartbeat` frames, `NotificationLevel`, `NotificationPayload`.
- `v1-runner` fires `notify()` on failed / aborted / budget run finalize.
- Web: store handlers dedupe by id, cap at 50. `audio.ts` plays Web Audio sine-tone sequences per level (no asset files). `NotificationPermissionBanner` shows on first frame when permission is `default` and not dismissed. `NotificationToast` bottom-right stack, max 4, auto-dismiss info/warn, ARIA roles per level, click-through to `actionUrl`.
- Agent-initiated `move_task` to `s_done` fires a one-shot OS notification ("Agent shipped: <title>"). User-driven and reorder-within-done do not notify.
- Settings → Notifications panel: browser permission state + request CTA, audio toggle + per-level tone preview, permission-banner reset, server identity card (pid / version / build sha / uptime / heartbeat age), recent activity tail with per-row dismiss.

### Orientation — editable session-shaping artifacts (T-89)

Surfaces the three session-shaping artifacts in the deck UI so non-developers can view and tweak them without touching server source.

- **Prelude** (`OMP_DECK_CONTEXT`) lifted out of the `in-process.ts` constant into a deck-managed override file; bridge reads effective value at `createAgentSession`. Effective on next session create — no server restart.
- **`/start` command** body + description editable in place; re-read every fire.
- **Maintenance gate** exposes enable toggle, three numeric knobs (`MIN_OP_MSGS`, `MIN_RELEASE_AGE_MS`, `FIRE_FLOOR_MS`), and the current org-root detection state. The deck server now sets `OMP_DECK_ORG_ROOT` itself so the extension activates regardless of session cwd; honors a `DISABLED` env flag from Settings.
- New: `orientation-store(+test)`, `routes-orientation`, web `orientation-api`, SettingsView Orientation tab. Protocol types: `PreludeResponse`, `StartCommand`, `MaintenanceGateState`. `env-schema` entries for the gate knobs.

### Chat — queued prompts + `kb://` resolution

- WS frames now default `streamingBehavior` to `followUp` instead of throwing `AgentBusyError` when a prompt arrives mid-turn (the user previously just saw the message vanish).
- New `clear_queue` client frame + server handler drains the SDK's pending queue and emits a `queue_cleared` event so the web reconciles. `SessionHandle` exposes `isStreamingNow()` + `queuedMessageCount()`.
- Reducer/store/types track `queuedPrompts` per session; Composer surfaces the queue with a clear affordance; new `QueuedMessage` component renders pending entries inline in the chat.
- New `KbProtocolHandler` registered on the SDK's process-global `InternalUrlRouter` at server boot, so `read kb://…` from any agent session resolves through the same KB root the REST layer serves (`OMP_DECK_KB_ROOT` or `~/kb`). Singleton must register before the first `createAgentSession`.

### Chat — composer prompt history (T-10)

- `useComposerHistory(cwd)` hook backed by a pure store + localStorage, keyed per workspace cwd. Caret rules mirror a shell: ArrowUp recalls only on the first visual line, ArrowDown only on the last. Cap 100 entries; consecutive duplicates and recall-then-send-unmodified do not pollute history.

### Permission prompts — `ask` tool bridge (T-83)

Bridges the SDK `ask` tool to the deck UI so any extension that opens a permission/selection/input dialog renders inline rather than failing silently.

- `ExtensionUIBridge` implements `ExtensionUIContext` per session and publishes `ext_ui_dialog_open` frames to subscribed WS clients; `ext_ui_dialog_response` from the client settles the SDK promise.
- `InProcessAgentBridge` passes `hasUI: true` and wires `setToolUIContext` so the SDK actually registers `AskTool`. Disposing a session cancels all pending dialogs.
- `WsHub` subscribes new connections to UI frames (with replay of pending dialogs for late subscribers) and routes responses.
- Protocol: `ext_ui_dialog_open` + `ext_ui_dialog_cancel` ServerFrames; `ext_ui_dialog_response` ClientFrame. Strict superset covering select / editor / confirm / input. `KNOWN_TOOLS` gains `ask`.
- Web `ExtUiDialog` modal renders select (with Recommended / Other), editor (multiline + Ctrl+Enter), input, and confirm dialogs. Store tracks `pendingDialogs` by `sessionId` and exposes `respondToExtUiDialog`; ChatView mounts the modal at the chat surface.
- Fix: deck initializes the SDK's `theme` global at boot (built-in `dark` JSON via `getThemeByName()` + `setThemeInstance()`). Without this the ask tool dereferenced `undefined` the moment it tried to render any question; symptom was `undefined is not an object (evaluating 'theme.status')` on every invocation.

### Starter skills (T-82)

- Bundles five upstream skills from `mattpocock/skills` (MIT, pinned to `b8be62f`) so they auto-install to `~/.omp/agent/skills/` on first boot via `starter-skills.ts`:
  - `handoff` — compact a session for the next agent
  - `diagnose` — 6-phase debugging discipline centered on building a fast feedback loop first
  - `zoom-out` — go up a layer and map modules/callers in unfamiliar code
  - `prototype` — throwaway code with two branches (logic prototype as terminal app, UI variants behind a route param)
  - `grill-me` — walk the decision tree of a plan one question at a time
- Single adaptation: `diagnose` Phase 6 referenced `/improve-codebase-architecture` (not imported); rewritten in place to "hand off the architectural finding into a task or knowledge article."
- Provenance: every imported `.md` gets a footer pointing at the exact upstream blob (commit-pinned); `hitl-loop.template.sh` gets the same in a comment header. `starter-skills/ATTRIBUTION.md` is the index + re-sync procedure.

### Kanban polish (T-78 / T-79 / T-80)

- Drag-reorder columns via a dedicated `GripVertical` handle on each column header (the column name still triggers rename). Persisted atomically through `POST /api/task-states/reorder` — rejects payloads that aren't a permutation of the current state ids before any UPDATE.
- Per-column recency sort: migration `004-state-entered-at.sql` adds `tasks.state_entered_at` (backfilled to `updated_at`) and an index on `(state_id, state_entered_at DESC)`. `createTask` stamps creation time; `moveTask` bumps only when the move actually changes column; same-column drops and body edits leave the timestamp alone. `listTasks` orders each column by `state_entered_at DESC` with `order_in_state` as tiebreaker.
- Brief date/time stamp on each card top-right (`just now` / `5m` / `5pm` / `MM/DD` / `MM/DD/YY`) via `apps/web/src/lib/time.ts:formatBriefTime`. Anchored by a `<time>` element with the full locale string as tooltip; tracks `updated_at` but does NOT move the card.
- **Heads-up:** manual within-column ordering no longer persists. Columns auto-sort by when each card last entered the column. Cross-column drag-and-drop is unchanged.

### Tasks — image paste + agent-rendered images

- `POST /api/uploads/image` accepts raw `image/*` bodies or `multipart/form-data`. Content-addressed storage at `<dataDir>/uploads/<yyyy>/<mm>/<sha256-prefix>.<ext>` — re-pasting the same screenshot is a no-op on disk. Served back via `/uploads/*` with immutable caching since the path encodes the bytes.
- Validation: whitelist of png/jpeg/gif/webp/svg, 10MB cap, traversal-safe display-name sanitization. Rejects empty / unsupported / oversized with 4xx, never 500.
- `MarkdownEdit` intercepts paste and drop events while editing. Bytes upload asynchronously with a unique placeholder spliced at the caret, rewritten to `![alt](/uploads/...)` on success or pulled on failure. Concurrent pastes don't collide.
- Agent-written task bodies that include image markdown (absolute URLs or relative `/uploads/...` paths) render inline through the same Markdown component. `.markdown img` gets `max-w-full` / rounded / bordered treatment so a 4K screenshot doesn't blow out the modal.

### Web polish

- App icon + favicon. Vector derivative of the user-supplied stack-of-tiles artwork — five isometric rhombi with a pink → purple → blue gradient, single shared linear-gradient in user space. Ships as `apps/web/public/icon.svg` (canonical), `favicon-32.png`, `apple-touch-icon.png` (180×180 iOS), `icon.png` (512×512). SVG linked first so modern engines get crisp scaling.

### Routines — fixes

- `run` step `readClipped()` switched from `reader.cancel()` to drain-and-discard after hitting the 8KB excerpt cap (T-103). Cancelling closed the read end of the pipe; on Windows the child writer then got EPIPE on its next `print(flush=True)`, Python re-raised as `OSError: [Errno 22] Invalid argument`, and the routine step failed after having collected useful output. Drain-and-discard lets the writer see a clean EOF when it finishes naturally. The 8KB cap itself is unchanged — it was the close that broke things, not the size.

### Tests + hygiene

- Routine-template smoke test iterates `listTemplates()` rather than hardcoding slugs, so local-only templates (gitignored personal routines) get validation coverage in dev without failing CI when absent on clean clones. Only `daily-briefing` is `REQUIRED_SHIPPED`; everything else present is validated against the V1 routine spec schema. Catches typos (unknown step type, missing required field, invalid id regex) before they 500 the install endpoint.
- Maintenance-gate redesign: replaces 7 overlapping suppression layers with a single release-cursor invariant + 3 floor thresholds. Fires at most once per release segment; one trivial "continue" no longer re-triggers. Defaults raised to be much calmer for long agentic sessions.
- T-58 cleanup: 5 pre-existing `noUncheckedIndexedAccess` errors fixed in `kb-service.ts` and `KbView.tsx`; both `apps/server` and `apps/web` typecheck clean.
- `*.tsbuildinfo` added to `.gitignore`; `apps/web/tsconfig.tsbuildinfo` removed from index.
- Vite `envPrefix` extended to expose `OMP_DECK_*` to the client.

### What's deferred to V1.5

- DnD step reordering on the form-mode editor (canvas surface already supports drag-position)
- `mcp` step type real implementation (currently stubbed with a clear V1.5 pointer; use `agent` step with `mcp_servers_allowed` for now)
- Smart-reorder warnings when reordering breaks a downstream context reference
- `mcp` step form auto-completes (`server` + `tool` dropdowns from installed MCP servers) once the Integrations page ships
- Workspace MCP integration (Gmail / Calendar / Drive / Docs) for the inbox-triager template
- Skill / MCP-server allowlist enforcement on `agent` steps (the SDK does not yet expose per-invocation surface restriction)
- TUI parity: plan mode, inline `!bash` / `$python` execution in composer

### Dependencies

- `apps/server`: `quickjs-emscripten@^0.31.0`, `yaml@^2.9.0`
- `packages/protocol`: `ajv@^8.17.1`, `ajv-formats@^3.0.1`
- `apps/web`: `yaml@^2.9.0`, `@xyflow/react@^12.10.2` (canvas), `@dnd-kit/sortable@^10.0.0` (kanban column reorder)
- SDK pinned at `15.1.7` (no bump this release)

## [0.2.0] — KB Cockpit + Maintenance Gate

Two big surfaces land alongside several smaller refinements.

### Skills cockpit — omp-native pivot
- `SkillsService` now reads through `loadCapability(skillCapability.id)`, so
  every skill omp loads is surfaced — `native` (`~/.omp/agent/skills/`),
  `claude-plugins` (marketplace), `claude` / `codex` / `opencode` config
  dirs, plus any future provider. The marketplace path is no longer the
  only source. Default sort puts `native` first; source filter rail in the
  sidebar replaces the prior plugin-only filter.
- Detail route switched to opaque server-issued `:id` (base64url of the
  SKILL.md absolute path) — clients pass it back verbatim.
- Watcher widens to `~/.omp/agent/skills/`, `<defaultCwd>/.omp/skills/`,
  and the marketplace cache. Missing roots skipped silently.
- Mobile master/detail nav: tree visible by default, picking a file slides
  to viewer with a back arrow.
- New starter `create-skill` skill bundled in `starter-skills/` and
  installed to `~/.omp/agent/skills/` on deck boot (idempotent). Zero
  Claude-Code dependencies — uses only omp's standard tools.
- Bundled starter installer logs what it copied vs skipped; opt out with
  `OMP_DECK_INSTALL_STARTER_SKILLS=0`.

### KB Cockpit (new feature)
Karpathy-style llm-wiki cockpit over `~/kb`. New `/kb` route between
Skills and Settings (BookOpen icon).

- **Browse**: lazy-loading tree of every markdown file under `OMP_DECK_KB_ROOT`
  (default `~/kb`). Top-level vendor noise (`.venv`, `node_modules`,
  `__pycache__`, `dist`, `build`, etc.) excluded automatically. Custom
  exclusions via `OMP_DECK_KB_EXCLUDE_DIRS=foo,bar,private`.
- **Read**: markdown viewer with wikilink resolution. `[[stem]]` matches
  by filename (deterministic same-dir tiebreaker on collision);
  `[[dir/path]]` is absolute; `[[target|label]]` and `[[target#anchor]]`
  supported. Unresolved wikilinks render with dotted-underline + tooltip.
  Code-block contents preserved verbatim so regex literals like
  `[[:alpha:]]` don't get parsed as wikilinks. URL state `?path=<rel>`
  drives the open file; browser back/forward works.
- **Edit**: in-pane textarea editor with Ctrl-S to save, Esc to discard.
  Atomic write via temp + rename. YAML frontmatter validated on save
  with the `yaml` package — invalid YAML returns 400 with the parser
  message in an inline error.
- **Create**: clicking an unresolved wikilink prompts for a target path
  (defaults to current file's directory) and POSTs a stub with required
  frontmatter.
- **Graph**: Obsidian-style force-directed view (`?view=graph`) via
  `react-force-graph-2d`. Nodes colored by top-level directory
  (`native` rust, `cryptocracy` violet, `tools` emerald, `system` amber,
  `writing` pink, `domains` blue, `music` cyan, `projects` red), sized
  by inbound degree. Click a node to open the file in a 28rem right-pane
  preview while the graph stays mounted. Browser-back collapses the
  preview cleanly. Click-to-isolate per directory in the bottom-left
  legend; orphans toggle; full-text filter.
- **Inspector**: frontmatter as a definition list, tag chips, clickable
  outbound link list, backlinks list with line-bounded snippets, orphan
  badge when 0 backlinks.
- **Search**: `GET /api/kb/search?q=<query>` with hybrid scoring across
  stem (100/80/60), title (60/40/25), tag (50/20), body (10+) with a
  centered 160-char snippet for body hits. Ctrl-P / Cmd-P opens a
  quick-open palette anywhere in /kb with debounced search, arrow-key
  nav, Enter to open. Tree sidebar header gets a clickable Ctrl-P pill
  for non-keyboard users.
- **Setup flow**: a missing or empty kb root surfaces a Welcome panel
  inside `/kb` with a one-click scaffold of a starter `README.md`.
- **Live updates**: WS `kb_changed` debounced 250ms; the viewer + tree
  + graph + inspector all refetch on counter change. Disable with
  `OMP_DECK_WATCH_KB=0`.
- **Cross-platform**: CRLF-tolerant frontmatter parser, atomic-write
  uses `rename` (single-drive assumption documented), wikilink
  resolution normalizes path separators.

### Maintenance gate (new feature)
Ports the calibrated `maintenance-gate` pattern from
[vincitamore/opus-extensions](https://github.com/vincitamore/misc/tree/main/opus-extensions)
as a first-party omp SDK extension, plus the in-bridge wiring that makes
it actually fire in deck sessions.

- **The extension** (`starter-extensions/maintenance-gate/`): installed
  to `~/.omp/agent/extensions/maintenance-gate/` on deck boot. Watches
  `turn_end` events; when ~10+ turns have passed since the last capture
  pass, synthesizes a follow-up user message containing a markdown
  "Maintenance check" prompt with the OMP-native signal table:

  | Signal | Action if present |
  |--------|-------------------|
  | Reusable insight or pattern | → `knowledge/<subfolder>/<topic>.md` |
  | Project status changed | → update `context/current-state.md` |
  | New task identified | → `tasks/<name>.md` |
  | Question worth preserving | → `queries/<question>.md` |
  | Feature idea / future project | → `inbox/ideas/<item>.md` |
  | Decision needed | → `inbox/decisions/<item>.md` |
  | Bug to investigate | → `inbox/investigations/<item>.md` |
  | Quick unsorted capture | → `inbox/captures/<item>.md` |
  | New capability learned | → create a skill |

  Writing into any canonical capture path releases the check
  automatically; stating the literal phrase "No maintenance needed"
  also releases. Cadence + throttle constants are env-overridable
  (`OMP_MAINTENANCE_GATE_TRIVIAL`, `_STALENESS`, `_FIRE_FLOOR_MS`,
  `_ROOTS`).
- **Structural org-root detection**: replaces the upstream's hardcoded
  `documents/opus|materia` substring check with a sniff (`inbox/` +
  `tasks/` + (`knowledge/` or `context/`) present). Walks up ancestors
  so deeply-nested sessions still activate against the right org root.
- **Bridge wiring**: `InProcessAgentBridge` now constructs the session's
  `ExtensionRunner` and calls `initialize()` with 13 session-bound
  action callbacks + 8 context-action callbacks. Mirrors the pattern in
  `modes/acp/acp-agent.ts` and `task/executor.ts`. Without this, the
  SDK loads extensions but their lifecycle handlers never fire. Now
  works universally across deck, TUI, and ACP sessions.

### Web polish
- External links (`http://`, `https://`, `mailto:`) in any markdown
  surface (chat, kb viewer, skill detail) open in a new tab with
  `rel="noopener noreferrer"`. In-app wikilinks and relative paths
  unchanged.
- Mobile master/detail navigation pattern extended from SkillsView to
  KbView — list visible by default at `< lg`, picking a row slides to
  detail with a back arrow.
- **Horizon** theme — third option in Settings → Appearance (pink-on-deep-
  navy with mint + peach + cyan syntax bias). Ported from
  [opus-extensions/omp-themes/horizon.json](https://github.com/vincitamore/misc/tree/main/opus-extensions/omp-themes).
  Pre-paint script recognizes it so first paint never flashes.

### Server polish
- CRLF-tolerant YAML frontmatter parsing across kb and skill loaders —
  fixes "Unexpected scalar at node end" errors on Windows-saved files.
- All new endpoints debounce + cache aggressively; the watcher
  invalidates per-source rather than wholesale.

### Internal
- New top-level dirs: `starter-skills/`, `starter-extensions/`,
  `docs/proposals/`.
- New web deps: `react-force-graph-2d` (graph view), `yaml` (server
  frontmatter).
- Protocol additions: `SkillSummary` extended; `KbTreeEntry`,
  `KbFileResponse`, `KbWikilink`, `KbGraphNode/Edge/Response`,
  `KbBacklink/BacklinksResponse`, `KbSearchResult/Response`,
  `KbStatusResponse`, `KbInitResponse`, plus `kb_changed` /
  `skills_changed` server frames.
- New bundled starter installer pattern: `StarterExtensionsInstaller`
  mirrors `StarterSkillsInstaller` (idempotent, opt-out via
  `OMP_DECK_INSTALL_STARTER_EXTENSIONS=0`).

## [0.1.0] — Initial public release

First release. End-to-end verified against a live omp turn.

### Chat
- Multi-session sidebar with workspace filter.
- Live streaming text, thinking blocks, tool-call lifecycle with per-tool
  renderers (`read` / `write` / `edit` / `bash` / `search` / `lsp` / `task` /
  `web_search` / `eval` / `todo_write` / `generate_image` / `browser` /
  `ast_grep` / `ast_edit`).
- Hashline-diff renderer for the `edit` tool.
- Todos panel from `todo_reminder`.
- Cost/usage rollup (input/output/cache/reasoning, USD).
- Image paste / drag / attach with thumbnail strip and `[Image #N]` placeholder.
- Compaction, retry, and TTSR indicators inline.
- Slash command picker with four scopes — `deck` (kanban operations),
  `builtin` (omp SDK), `user`, `project`.
- Built-in slash command dispatch in-process (no model round-trip) for SDK
  commands with text-mode handlers: `/context`, `/usage`, `/tools`, `/compact`,
  `/rename`, `/dump`, `/memory *`, `/mcp *`, etc.
- Deck-native slash commands: `/task add`, `/task list`, `/task done`,
  `/task move`. Operate directly on the kanban; zero token cost.
- `@filepath` mention autocomplete in the composer.
- Copy buttons on every code block.
- Context-window indicator with manual `/compact` popover.
- Streaming caret, blink-on-idle.

### Tasks (kanban)
- Backlog / Active / Blocked / Done with drag-and-drop.
- User-configurable columns with reorder + recolor.
- Human-friendly display IDs (`T-1`, `T-2`, ...) via a monotonic sequence.
- Promote-from-inbox flow.
- Live WS broadcast — any mutation (UI, deck slash, agent REST) refetches all
  open kanbans without polling.

### Routines
- Cron scheduler (`croner`) for `bash` / `prompt` / `script` actions.
- Run history with stdout/stderr excerpts.
- Manual fire-now.

### Inbox
- Quick-capture with kind taxonomy (email / ticket / idea / decision /
  investigation / capture).
- Promote-to-task one-click flow.

### Settings
- **Env** — masked secret list, replace-or-unset modal, atomic `.env` write
  to `<dataDir>/.env`, append-only audit log, hot-apply for
  `LOG_LEVEL` / `OMP_DECK_IDLE_TIMEOUT_MS` / `OMP_DECK_AUTO_START` /
  `OMP_DECK_DEFAULT_CWD` / `OMP_DECK_WORKSPACES`, restart-required banner with
  one-click restart.
- **Messaging** — Telegram credential rows, bridge supervisor with Start /
  Stop / Restart buttons, live logs panel, status pill (running / stopped /
  crashed).
- **Appearance** — Paper (warm cream) and Slate (dark) themes with swatch
  previews, system-preference following, FOUC-free pre-paint applied before
  React mounts. `data-theme` attribute on `<html>` swaps every Tailwind color
  + font token via CSS custom properties.

### Marketplace
- Three-panel browser over the SDK's `MarketplaceManager`.
- Suggested empty-state seeds with `anthropics/claude-plugins-official`.
- Install / uninstall / refresh per plugin or per source.
- Capability badges (`cmds` / `agents` / `hooks` / `mcp` / `lsp`).

### Native model picker
- Header label opens a modal listing every SDK model.
- Available (369) / All (2587) toggle.
- Provider grouping with the active model's provider floated to the top.
- Auth gating — picks against an unauthed model surface the SDK error inline.

### Messaging
- Standalone Telegram bridge in `apps/bridges/telegram/`.
- Long-poll, allowlist-gated, per-chat session map persisted to SQLite.
- Image attachments downloaded and forwarded as omp `ImageAttachment`.
- Debounced `editMessageText` to avoid Telegram rate-limits.
- Supervised by the deck server — Start / Stop / Restart from the Settings UI.

### First-run UX
- Auto-start (`OMP_DECK_AUTO_START`) **disabled by default**. Opt in by
  writing `~/.omp/agent/commands/start.md` and setting the env var.
- Empty `tasks` table seeds a `T-1: Welcome to omp-deck` backlog task with
  orientation pointers (nav rail, themes, deck slash commands, docs links).

### Deployment
- Loopback-only by default. Tailscale Serve, Docker, and SSH-tunnel patterns
  documented in `docs/deployment.md`.
- `POST /api/server/restart` graceful restart endpoint.

### Architecture
- Bun + Hono backend embedding `@oh-my-pi/pi-coding-agent`.
- `AgentBridge` interface so a subprocess-per-session impl can drop in later.
- WS event passthrough (`session_event`) with deck-side synthetic events for
  context-usage, slash-command round-trips, and model swaps.
- Dep-free `@omp-deck/protocol` package owns the wire types.
