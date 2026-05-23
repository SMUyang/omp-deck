# Third-party attributions for bundled starter skills

The starter skills below were imported from third-party repositories. Each one
ships with a per-file footer (or shebang comment, for scripts) pointing at the
exact upstream blob it was sourced from. This file is the index.

## mattpocock/skills

- **Upstream**: <https://github.com/mattpocock/skills>
- **License**: MIT (see <https://github.com/mattpocock/skills/blob/main/LICENSE>)
- **Pinned commit**: `b8be62ffacb0118fa3eaa29a0923c87c8c11985c` (`b8be62f`)
- **Date synced**: 2026-05-23
- **Imported skills** and per-file source paths:

| Local path                                      | Upstream path                                                            | Verbatim? |
|-------------------------------------------------|--------------------------------------------------------------------------|-----------|
| `handoff/SKILL.md`                              | `skills/productivity/handoff/SKILL.md`                                   | yes       |
| `grill-me/SKILL.md`                             | `skills/productivity/grill-me/SKILL.md`                                  | yes       |
| `zoom-out/SKILL.md`                             | `skills/engineering/zoom-out/SKILL.md`                                   | yes       |
| `diagnose/SKILL.md`                             | `skills/engineering/diagnose/SKILL.md`                                   | **adapted** — Phase 6 reference to `/improve-codebase-architecture` rewritten to "hand off the architectural finding into a task or knowledge article" (we don't import that skill) |
| `diagnose/scripts/hitl-loop.template.sh`        | `skills/engineering/diagnose/scripts/hitl-loop.template.sh`              | yes       |
| `prototype/SKILL.md`                            | `skills/engineering/prototype/SKILL.md`                                  | yes       |
| `prototype/LOGIC.md`                            | `skills/engineering/prototype/LOGIC.md`                                  | yes       |
| `prototype/UI.md`                               | `skills/engineering/prototype/UI.md`                                     | yes       |

### Re-sync procedure

1. Pull the latest commit SHA from <https://github.com/mattpocock/skills>.
2. For each row above, re-fetch the upstream path and diff against the local copy.
3. Resolve diffs (verbatim files should adopt upstream; the `diagnose` adaptation must be preserved).
4. Update the per-file footer commit SHA and the "Pinned commit" line above.
5. Update the "Date synced" line.

The footers are intentionally per-file so reviewers can verify provenance without leaving the file they're reading.
