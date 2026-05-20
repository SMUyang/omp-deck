# Proposal: KB Cockpit

Status: draft, 2026-05-20
Author: omp-deck team
Tracks: T-33 (this proposal) — T-41 (deferred maintenance hook). Implements
[Karpathy's llm-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
in omp-deck as a first-class viewer / editor / graph view over the user's
existing knowledge base at `~/kb`.

## Why

The user already has a Karpathy-style llm-wiki at `C:/Users/bryan/kb` —
**1013 markdown files, 3101 wikilinks, ~9 MB** of hand-tended knowledge with
frontmatter metadata, `[[wiki-links]]` between articles, and topical hub
index files. What's missing is the **cockpit** to read/edit/browse/visualize
it from the deck.

Three observations that shaped the design:

1. **The wiki already exists.** This proposal is NOT for a writer (like the
   skill-creator we built in T-32) — it's a viewer/editor/graph view over
   an existing tree the user maintains by hand and via separate scripts.
2. **omp's native memory feature is different.** `memory.backend = local`
   writes rolling session summaries; `memory.backend = hindsight` calls a
   vector-store recall endpoint. Both are about session-context compaction
   and retrieval, NOT a persistent hand-tendable wiki. We build separately.
3. **The deck is the right home.** The kb is already accessible via
   filesystem and any markdown editor (Obsidian, VS Code, etc.). What omp-deck
   adds is *cockpit-native* views: tightly integrated with the agent's
   workflow (the chat session can reference what you're reading), the
   marketplace (skills can deep-link into kb), and the task system
   (find→capture loop). That's value the standalone tools don't deliver.

## What we measured

```
TOTAL md files: 1013
TOTAL bytes:    9,112,189
TOTAL wikilinks: 3101 (raw, including duplicates)

BY TOP-LEVEL DIR:
  projects   411    (incl. vendor noise — see "Risks")
  tools      360    (gotcha articles, hubs)
  writing     92
  system      85    (system patterns)
  domains     63
  cryptocracy (junction → external Obsidian vault)

FRONTMATTER KEYS (sample 50 files):
  tags / created / type / updated → near-universal
  description / name / metadata    → occasional
```

Wikilink syntax in use (observed):

```
[[tauri-knowledge-hub]]                  # stem-only — most common
[[fitness-app/README]]                   # subpath
[[:alpha:]]  [[=e=]]  [[.ch.]]           # false positives inside code blocks
```

## Three-layer mental model (Karpathy)

| Layer  | Where                                          | Who maintains    |
|--------|------------------------------------------------|------------------|
| Sources| External — git repos, papers, transcripts      | User             |
| Wiki   | `~/kb/{domains,tools,system,writing,projects}/`| User + agents    |
| Schema | `~/kb/README.md` + per-cluster hubs            | User             |

This cockpit operates **only on the Wiki layer.** It doesn't ingest sources
(the user does that via `kb_sync.py` or by hand). It reads the schema (the
README and hub files) and renders the resulting graph.

## Scope

In:
- Browse the wiki tree
- Render any `.md` file with proper wikilink resolution
- Edit + save files atomically
- Visualize the wikilink graph (Obsidian-style force-directed)
- Inspector: frontmatter, outbound links, backlinks, tag chips
- Search + quick-open palette
- Live refresh via WS

Out:
- Source ingestion (that's `kb_sync.py`'s job)
- Wiki *authoring by agent* (the skill-creator pattern, but for knowledge —
  separate future proposal if we want it)
- Cross-vault navigation (one kb root per deck instance for v1)
- Maintenance automation — orphan census, broken links, stale dates
  (deferred to T-41, references vincitamore/opus-extensions)

## Key design choices

### 1. Configurable root, single kb per deck

`OMP_DECK_KB_ROOT` env var, default `~/kb`. v1 supports one kb at a time.
Multi-kb (workspace concept) is a v2 concern; the protocol leaves room.

### 2. Exclude rules from day one

The kb measurement showed `projects/paper-trading-longcall/.venv/Lib/site-packages/altair/jupyter/js/README.md`-style vendor noise. The cockpit must filter at the discovery layer.

Hardcoded skip-set (matches `orphan-census.py`):

```
.git, node_modules, target, .venv, venv, __pycache__, dist, build,
.next, .nuxt, .agents/skills
```

Future: `.kbignore` file at any subdir level (gitignore-style). Out of v1.

### 3. Wikilink resolution rules

- **Stem-only** `[[name]]` → first match by filename stem
  (case-insensitive). Tiebreaker: prefer same-directory, then alphabetical
  by relative path.
- **Subpath** `[[dir/name]]` → absolute under kb root, with `.md` appended
  if no extension.
- **Label** `[[target|label]]` → resolve `target`, render `label`.
- **Anchor** `[[name#section]]` → resolve `name`, anchor handled in viewer
  (scroll into view).
- **Self-link** `[[#section]]` → same-file anchor only.
- **Ambiguous stems** (`readme`, `index`, `profile`, `skill`, `summary` —
  from `orphan-census.py`) → require explicit subpath, otherwise resolve to
  `null` with a "stem too ambiguous" reason.
- **Code-block exclusion**: don't extract wikilinks inside ` ``` ` fenced
  blocks (eliminates the `[[:alpha:]]` / `[[=e=]]` false positives).

### 4. Frontmatter parser

Use a lightweight YAML parser (likely `yaml` npm package, ~30kb) for
safety — the kb has real YAML (arrays, nested objects, multi-line). The
header-grep approach from `routes-slash-commands.ts` is insufficient for
this scale.

### 5. Graph library: `react-force-graph-2d`

- Wraps `d3-force`, canvas-based, handles 1000s of nodes comfortably.
- ~80kb gzipped, no React Three dependency.
- Already React-friendly; reasonable Obsidian parity.
- Alternatives considered: `cytoscape.js` (heavier, more features we don't
  need); rolling d3-force directly (more code, no obvious benefit at v1).

### 6. URL state as source of truth

`/kb?path=<rel>` opens a file. `/kb?view=graph` switches to graph. Back /
forward works. Bookmarkable. The web view reads from URL, never the other
way around — this avoids the URL-state-vs-component-state class of bugs.

### 7. Atomic writes + watcher echo suppression

- Saves go through a write-temp + rename to avoid partial-file reads.
- The kb watcher fires on the user's own save. The viewer tracks a
  "last-save epoch" per path; an incoming `kb_changed` for that path within
  500ms of the save is ignored to avoid the editor remounting on its own
  write.

### 8. Cross-platform path normalization

Windows kb stores backslashes on disk; wiki-links use forward slashes. The
protocol always uses forward slashes; the backend normalizes on read,
denormalizes on write.

### 9. Symlink / junction handling

`cryptocracy/` is a Windows junction to an external Obsidian vault.
Follow it, but track visited absolute paths to break cycles. Surface the
junction with a small icon in the tree so the user knows it's not part of
the main vault.

## Phased plan

Tasks already filed (T-34..T-41). Summary:

| Task | What                                                    | Depends on    |
|------|---------------------------------------------------------|---------------|
| T-34 | `KbService` + `GET /api/kb/{tree,file}` + WS kb_changed | —             |
| T-35 | `/kb` view — tree + viewer + wikilink navigation        | T-34          |
| T-36 | Markdown editor + `PUT /api/kb/file`                    | T-35          |
| T-37 | `GET /api/kb/graph` + backlink index                    | T-34          |
| T-38 | Obsidian-style force-directed graph view                | T-37          |
| T-39 | Inspector — frontmatter + outbound + backlinks + tags   | T-35 + T-37   |
| T-40 | Search + quick-open (Ctrl-P) palette                    | T-34          |
| T-41 | (deferred) Maintenance hook + orphan census routine     | T-34..T-40    |

Natural shipping order: T-34 → T-35 → T-36 → T-37 → T-38 → T-39 → T-40.
T-41 stays in backlog until the rest has been live for at least a week.

The shipping unit users notice is **T-34..T-35** together (browse + read),
which is enough to start using the cockpit. T-36 (edit) and T-38 (graph)
are independently valuable. T-39 and T-40 polish the experience.

## Risks and sharp edges

1. **Vendor noise in `projects/`.** 411 files there, with `.venv/`,
   `node_modules`-equivalents, and third-party README mirrors. The
   exclude rules are load-bearing; without them the cockpit shows
   thousands of irrelevant files. Test against the real kb during T-34.
2. **Wikilink false positives in code blocks.** Already observed
   (`[[:alpha:]]`). Fenced-block skip is mandatory.
3. **Ambiguous stems.** Files named `README.md` / `INDEX.md` exist in
   many subdirs. Stem resolution will pick one; the UI needs to
   surface the resolved path so the user can tell which.
4. **Editor data loss.** Never auto-save. Dirty-bit visible.
   Confirm-discard on navigate-away. Save = atomic.
5. **Watcher echo.** The editor's own save fires `kb_changed`. Without
   the "last-save epoch" guard, the editor would remount mid-edit.
6. **Graph size.** 1013 nodes + ~2000-3000 resolved edges is comfortably
   within `react-force-graph-2d` territory, but the kb will grow. Plan
   for an LOD / "show top-N inbound" cap once we cross 5k nodes.
7. **Cross-platform paths.** Test wikilink resolution on Windows-stored
   paths with mixed slashes; the protocol carries forward-slashes.
8. **The cryptocracy junction.** Don't break the external vault by
   writing into it accidentally. Read-only flag per source on the
   server side; the editor refuses to save into a path resolved through
   a junction.

## What this is NOT (yet, restated)

- **An agent-driven wiki maintainer.** The cockpit shows what's there;
  it doesn't autonomously rewrite or restructure. That's the T-41 hook's
  job, and even then it's user-approved-per-finding, not autonomous.
- **A replacement for `kb_sync.py`.** The Python tooling does
  source-to-wiki promotion; we're not building that into the deck.
- **A cross-vault mounter.** One kb root per deck. Multi-vault is v2.
- **Live collaborative editing.** Single user, single deck. CRDT /
  multiplayer is out of scope.

## Open questions for the user

1. **Default kb root**: confirm `~/kb` (i.e. `C:/Users/bryan/kb`) for
   your machine. The proposal currently reads it from `OMP_DECK_KB_ROOT`
   with that default.
2. **Editor surface**: CodeMirror 6 with markdown + soft-wrap matches the
   existing deck CodeMirror usage. OK?
3. **Atomic write strategy on Windows**: `cp temp dst` then `rm temp` vs.
   `rename` — `rename` is atomic but fails across drive letters. The kb
   should always be on a single drive, so `rename` should work. Confirm.
4. **Wikilink-create-on-click**: when a user clicks an unresolved
   `[[name]]`, should the cockpit prompt to create the file (T-39's
   "create affordance")? Or just show the unresolved state? Tentative
   answer: yes-prompt, but the prompt asks for a target directory
   (defaulting to the current file's directory) so we don't blindly
   write into the root.

## References

- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- `my-org-new/scripts/orphan-census.py` — canonical wikilink regex,
  exclude rules, and ambiguous-stems list
- `my-org-new/scripts/kb_sync.py` — source ingestion path (we don't
  reimplement; just don't conflict)
- `my-org-new/scripts/build-knowledge-hubs.py` — hub generation pattern
- [vincitamore/opus-extensions](https://github.com/vincitamore/misc/tree/main/opus-extensions) — referenced for T-41's maintenance gate
- `react-force-graph-2d` — chosen graph library
