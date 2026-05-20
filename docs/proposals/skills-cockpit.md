# Proposal: Skills Cockpit

Status: draft, 2026-05-20
Author: omp-deck team
Tracks: post-v0.1 — "self-improving skills" gap noted in `README.md` "How it
compares" table.

## Why

The marketplace answers "what can I install?" It doesn't answer "what's
installed, what's it doing for me, and how do I make it better over time?" A
self-improving-skills story doesn't have to be autonomous (the Hermes pitch) to
be useful: most of what makes adaptive agents feel adaptive is **visibility +
a one-click iteration loop**, not background refinement. This proposal turns
omp-deck into the cockpit for that loop in three shippable phases, with no
required changes to the `omp` SDK.

## What we already have

Source-of-truth on disk (managed by omp, shared with the omp CLI):

- `~/.omp/marketplaces.json` — added marketplace sources.
- `~/.omp/plugins/installed_plugins.json` — `{ version: 2, plugins: { id: [entries] } }`. Each entry has `scope`, `version`, `installedAt`, `installPath`, `enabled?`.
- `~/.omp/plugins/cache/marketplaces/<mp>/plugins/<plugin>/` — the plugin tree, including `.claude-plugin/plugin.json` and `skills/<name>/SKILL.md` (+ scripts, refs, assets, agents, hooks, commands, mcpServers, lspServers).

SDK surface (`@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace`):

- `listMarketplaces`, `listAvailablePlugins(name)`, `listInstalledPlugins`
- `installPlugin(name, mp, {scope, force})`, `uninstallPlugin(id, scope)`
- `setPluginEnabled(id, enabled, scope)`
- `checkForUpdates`, `upgradePlugin(id, scope)`, `upgradePluginAcrossScopes(id)`, `upgradeAllPlugins`
- `refreshStaleMarketplaces`, `updateAllMarketplaces`
- `getPluginInfo(name, mp)` — capability map (commands / agents / hooks / mcpServers / lspServers)
- Project-scope resolution via `resolveActiveProjectRegistryPath(cwd)`

Deck surface (today):

- `MarketplaceService.listCatalog()` — sources + catalog with capability *booleans* + installed array. Drives the Marketplace view.
- Install / uninstall / addMarketplace / removeMarketplace / refresh / setEnabled.

Anthropic upstream (already installable from `claude-plugins-official`):

- `skill-creator` plugin — ships `scripts/run_loop.py`, `run_eval.py`,
  `improve_description.py`, `quick_validate.py`, `package_skill.py`,
  `eval-viewer/generate_review.py`, plus agents (`analyzer`, `comparator`,
  `grader`).

## Gap

| Concern                                                  | State today                                      |
|----------------------------------------------------------|--------------------------------------------------|
| "What plugins are installed?"                            | ✅ deck shows plugin-level list                  |
| "What skills do those plugins contain?"                  | ❌ no skill-level enumeration                    |
| "What does this skill actually do?"                      | ❌ no SKILL.md reader in UI                      |
| "Which scope is this plugin coming from?"                | ✅ shown                                         |
| "Are there updates to my installed plugins?"             | ❌ `checkForUpdates` not surfaced                |
| "Which skills fired in this session?"                    | ❌ no telemetry                                  |
| "Can I tweak a skill for this project only?"             | ❌ no UI; SDK supports project scope             |
| "Can I run the eval / description-tuner loop?"           | ❌ `skill-creator` installable, no cockpit       |
| "Can I author a new skill from the deck?"                | ❌ shell-out only                                |

## Phases

Each phase ends in a usable feature; later phases assume the previous shipped.

### Phase 1 — Inventory ("what's currently available")

A `/skills` view that lists every skill exposed by every enabled plugin, with
enough metadata to act on.

Backend:
- New `SkillsService`. For each entry returned by `listInstalledPlugins()`,
  glob `<installPath>/skills/*/SKILL.md`, parse frontmatter (`name`,
  `description`, `triggers?`, `model?`, `tags?`), record `pluginId`, `scope`,
  `installPath`, `skillPath`.
- `GET /api/skills` → `{ skills: SkillSummary[], plugins: InstalledPluginSummary[] }`.
- `GET /api/skills/:pluginId/:skillName` → `{ frontmatter, body, files: [...] }`
  so the UI can render the SKILL.md and link to siblings (scripts, refs, etc.).
- WS broadcast `skills_changed` from a `chokidar`/`fs.watch` watcher rooted at
  `getPluginsCacheDir()`. Gate the watcher behind `OMP_DECK_WATCH_SKILLS=1`
  defaulting on, with a polling fallback when the watcher emits errors (OneDrive
  / network drives — known pattern from existing routines watcher).

Web:
- New left-nav entry `Skills` between Marketplace and Settings.
- Two-pane layout: filterable list (by plugin, scope, trigger keyword) +
  detail pane with frontmatter card and rendered SKILL.md (reuse the chat's
  markdown + `highlight.js` pipeline from T-25).
- Enable / disable reuses the existing plugin-level toggle and documents the
  granularity ("skills inherit from their plugin").

Acceptance:
- Install `skill-creator`; deck shows `skill-creator/skill-creator` with the
  real description, and the detail pane renders its SKILL.md.
- Disable the plugin → list row greys; WS pushes `skills_changed`; no manual
  refresh required.

### Phase 2 — Lifecycle ("keep them fresh")

Turn the cockpit into a maintenance surface.

- `GET /api/marketplace/updates` → `MarketplaceManager.checkForUpdates()`.
- `POST /api/marketplace/plugins/:id/upgrade` body `{ scope?: "user"|"project" }`
  → `upgradePlugin` or `upgradePluginAcrossScopes`.
- Skills nav badge: "N updates available"; per-row "Upgrade" action.
- Project-scope install toggle in the install dialog. Resolves project root
  via `resolveActiveProjectRegistryPath` against the active session's `cwd`.
- New built-in routine `skills:refresh` (template, not pre-installed):
  `refreshStaleMarketplaces` + `checkForUpdates`, fans the diff into Inbox
  with a one-click "promote to upgrade task" using the existing inbox→task
  pipeline.

Acceptance:
- An outdated installed plugin shows an Upgrade button; clicking it bumps the
  version, WS pushes the new state, and the daily routine writes a digest into
  Inbox.

### Phase 3 — Iteration ("make them better")

Wire deck-native telemetry and the upstream `skill-creator` loop.

Telemetry (deck-side, no SDK change):
- New SQLite table `skill_invocations(session_id, skill_id, ts, kind)`.
- Inference from the existing session event stream: when a tool from a
  plugin's `commands` / `tools` / `hooks` set fires, attribute it to the
  owning skill via `installPath`. Document the limits (skills consumed by the
  agent purely through context don't fire commands → no signal; that's OK).
- `GET /api/skills/:id/usage` → counts + last-7-day sparkline + linked
  session IDs.
- Skill detail pane gains a "Usage" tab.

Edit-in-place:
- "Fork to project scope" button: copies the plugin tree into the project's
  `.omp/plugins/cache/...` (via `MarketplaceManager.installPlugin` with
  `scope: "project"`), then opens SKILL.md in an editor pane (reuse the
  existing CodeMirror surface from T-25). Save writes back to the
  project-scoped path. Description-trigger collisions across enabled plugins
  are flagged inline.

Iteration loop:
- "Run eval" button shells out to `<installPath>/scripts/run_eval.py` against
  a project-local `tests/prompts.jsonl` (created from a template if absent).
  Streams output into a chat-style panel and links the rendered eval review
  HTML when complete.
- "Tune description" button → `improve_description.py`. Shows before/after
  diff; "Apply" commits via the edit-in-place path.

Authoring:
- "New skill" CTA opens a chat session pre-loaded with the `skill-creator`
  SKILL.md and a starter prompt template. Whole authoring loop stays inside
  the deck.

Acceptance:
- Take an installed skill, fork it to project scope, edit it, run the eval
  loop, accept a tuned description, ship — all without leaving the deck.
- Usage tab shows when that skill last fired and in which sessions.

## What this is NOT (yet)

- **Autonomous in-session skill refinement** (the Hermes pitch). That
  requires an SDK-side hook the omp agent loop doesn't expose today plus a
  budgeted refinement turn. Treat as a v0.4+ research item; the cockpit above
  delivers most of the perceived "self-improving" feel via visibility + low-
  friction iteration.
- **A separate skill registry.** The Anthropic plugin format nests skills
  inside plugins; building a parallel registry fragments the ecosystem. Stay
  inside `MarketplaceManager`'s model.
- **Skill-level enable/disable.** SDK granularity is plugin-level; promising
  finer than that in the UI would lie about what `setPluginEnabled` does.

## Risks / sharp edges

- `installed_plugins.json` is shared with the omp CLI. Always write through
  `MarketplaceManager`; never mutate the file directly. `parseClaudePluginsRegistry`
  rejects non-numeric versions.
- Watching `~/.omp/plugins/cache/...` with `chokidar` will misbehave on
  OneDrive / network drives. Wrap it like the routines watcher, with polling
  fallback on first error.
- "Fork to project scope" must use `resolveActiveProjectRegistryPath`; do not
  assume `cwd === project root`. Reuse the SDK helper.
- Don't ship agent-initiated skill installs (the OpenClaw "skills can install
  skills" pattern). Anthropic plugin format requires explicit consent. Crossing
  that boundary is a separate proposal and a security review.

## Tasks to file (deck kanban)

Phase 1 — Inventory:
- `SkillsService` + `GET /api/skills` + WS `skills_changed`
- `GET /api/skills/:pluginId/:skillName` with SKILL.md + linked files
- `/skills` two-pane view
- docs/skills.md user guide

Phase 2 — Lifecycle:
- `GET /api/marketplace/updates` + `POST .../upgrade`
- Skills nav "Updates available" badge + per-row upgrade
- Project-scope install toggle (uses active session cwd)
- `skills:refresh` routine template → Inbox digest

Phase 3 — Iteration:
- `skill_invocations` table + capture from session events
- `GET /api/skills/:id/usage` + Usage tab
- Fork-to-project + project-scoped editor pane
- "Run eval" wired to `skill-creator/scripts/run_eval.py`
- "Tune description" wired to `improve_description.py`
- "New skill" CTA → chat session bootstrapped with `skill-creator`

## Future (v0.4+ research)

- Push for an SDK hook `onSkillTriggered(skillId, ctx)` so telemetry stops
  being inferred and starts being authoritative.
- Per-session skill budget: limit how often a single skill can fire.
- Background "skill drift" routine: re-run evals for installed skills weekly,
  flag regressions caused by upstream plugin updates.
- Agent-driven refinement turn, gated behind explicit user opt-in per skill.
