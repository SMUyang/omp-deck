# Starter skills

omp-native skills bundled with omp-deck. On server boot, `apps/server/src/starter-skills.ts` walks this directory and copies any subdir that isn't already present in `~/.omp/agent/skills/`. The installer is **never-overwrite**: once a target exists, the user owns it. Deleting the destination dir + restarting reinstalls.

## Bundled skills

### omp-deck native

- **create-skill** — Author a new omp-native skill. The full author loop using only `omp`'s standard tools (`read`, `write`, `edit`, `bash`). Triggers when the user wants to capture a recurring workflow or formalize a procedure into a `SKILL.md`.

### Imported from `mattpocock/skills`

See [ATTRIBUTION.md](./ATTRIBUTION.md) for the pinned upstream commit, license, and per-file source paths.

- **handoff** — Compact the current conversation into a handoff document for another agent to pick up. Writes to the OS temp dir (never the workspace), includes a `## Suggested skills` section, redacts secrets.
- **diagnose** — Disciplined diagnosis loop for hard bugs and performance regressions: reproduce → minimise → hypothesise → instrument → fix → regression-test. Phase 1 ("build a fast deterministic feedback loop") is the load-bearing insight. Adapted: Phase 6's hand-off-to-`/improve-codebase-architecture` line rewritten to point at "a task or knowledge article describing what would have prevented the bug" (we don't bundle that skill).
- **zoom-out** — When the agent lands in an unfamiliar section of code, go up a layer of abstraction and map all relevant modules and callers using the project's domain vocabulary.
- **prototype** — Build a throwaway prototype that answers a specific question. Routes between two branches: an interactive terminal app for state / business-logic questions ([prototype/LOGIC.md](./prototype/LOGIC.md)), or several radically different UI variations toggleable from one route ([prototype/UI.md](./prototype/UI.md)).
- **grill-me** — Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree.

## Skipped from upstream (and why)

For full context see [ATTRIBUTION.md](./ATTRIBUTION.md) and the task that drove the initial import.

- `caveman` — Overlaps the more-developed `caveman:*` skill family.
- `write-a-skill` — Overlaps `create-skill` + `skill-creator:skill-creator`.
- `to-prd`, `to-issues` — Target GitHub issues + a per-repo config we don't run. Adapting them to the omp-deck kanban is a follow-up.
- `edit-article`, `obsidian-vault`, `scaffold-exercises`, `migrate-to-shoehorn`, `setup-pre-commit`, `git-guardrails-claude-code`, `setup-matt-pocock-skills` — Personal-to-Matt or framework-coupled.
- `improve-codebase-architecture`, `triage`, `grill-with-docs`, `tdd` — Depend on `docs/adr/` + `CONTEXT.md` conventions we don't have. Revisit if we adopt them.
- `in-progress/*` — Upstream marks them unstable; wait for graduation.

## Adding a new starter

1. Create `starter-skills/<name>/SKILL.md` with proper frontmatter (`name`, `description`, optional `tags`). See [`create-skill/SKILL.md`](./create-skill/SKILL.md) for the authoring loop.
2. Ship any co-located scripts / references under the same dir.
3. **If sourced from a third-party repo**, add a per-file footer pointing at the upstream blob (commit-pinned), add an entry in [ATTRIBUTION.md](./ATTRIBUTION.md), and document any adaptations.
4. Restart the deck. Confirm the skill lands at `~/.omp/agent/skills/<name>/` and appears in `GET /api/skills` with `provider: "native"`.

## Disabling

Set `OMP_DECK_INSTALL_STARTER_SKILLS=0` to skip the bootstrap entirely.
Set `OMP_DECK_STARTER_SKILLS_DIR=<path>` to override the source directory.
