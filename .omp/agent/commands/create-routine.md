---
description: Scaffold a new omp-deck routine end-to-end — pick triggers, compose typed steps via the deck step family, gate cross-run state, validate the spec, and either save as a built-in template or POST to /api/routines. Use when the user says "build a routine that ...", "scaffold a routine", or asks how to wire a recurring deck workflow.
argument-hint: <purpose, e.g. "daily summary of yesterday's PR merges">
---

You are authoring a new routine for omp-deck's V1 pipeline engine. Build the smallest correct spec that solves the stated purpose. Don't ship a stub.

## 1. Understand the ask in one sentence

Restate the request as `<when> <do_what> <where_does_output_go>`. Examples:
- `every morning at 7am · summarize yesterday's completed tasks · into a fresh inbox capture`
- `on webhook · pull the latest GitHub PRs · post a digest to the inbox`
- `manually triggered · run a research prompt with a topic argument · file findings under tasks/research/`

If the request is ambiguous on any of `<when>` / `<do_what>` / `<where_does_output_go>`, ask ONCE with a recommendation. Otherwise proceed.

## 2. Decision tree

Work top-to-bottom. Default values are in parentheses.

### Trigger
- Recurring time-based → `- cron: "0 7 * * *"` (5-field UTC; set `timezone:` if local clock matters)
- External system poke → `- webhook: { path: /hooks/<slug>, secret_env: <ENV_VAR> }`
- Human-driven → `- manual: {}`
- Multiple sources are fine — list every entry the engine should fire on.

### Idempotency
If the routine should run at most once per day/hour/event window, prepend a `should_run` gate:

```yaml
- id: should_run
  type: transform
  body: |
    const today = new Date().toISOString().slice(0, 10);
    return context.state.last_run_date !== today;
```

Then **every** later step gets `when: steps.should_run.json === true`. Final step is `set_state` writing `last_run_date: "{{ run.date }}"`. Add the cursor key to `state.declared_keys` — the validator rejects undeclared keys.

### Steps (the body of the routine)

Classify each unit of work into ONE of these. Always prefer the most specific.

| type | use for | required fields |
|---|---|---|
| `deck` | tasks / inbox in THIS app | `action` + action-specific fields |
| `agent` | LLM call (Claude / GPT via omp SDK) | `prompt` |
| `transform` | JS projection / digest / boolean gate | `body` (returns JSON) |
| `write` | write a file to disk | `path`, `content` |
| `http` | external URL (NOT this deck's own API) | `method`, `url` |
| `run` | shell out to a command | `command` |
| `set_state` | persist cross-run cursors | `state: { key: value }` |
| `wait` | sleep N seconds between polls | `duration_secs` |
| `mcp` | MCP tool call (V1.5 — currently stubbed) | `server`, `tool`, `args` |

### `deck` step actions (read = slim summary; write = mutation)

Read (returns slim records — `{id, ref, displayId, title, stateId, updatedAt, createdAt}` for tasks; `{id, kind, title, source, createdAt, processedAt}` for inbox):
- `list_tasks` — filters: `state_ref` (id OR case-insensitive name substring), `since_hours`, `include_archived`, `limit`
- `list_inbox` — filters: `kind`, `since_hours`, `include_processed`, `limit`
- `get_task` — `task_ref` accepts `T-N` or `t_<id>`
- `get_inbox_item` — `inbox_ref` accepts the inbox id

Write:
- `create_task` — `title` (req), `body`, `stateId`/`state_ref`
- `create_inbox_item` — `kind` (capture/idea/decision/investigation/ticket/email), `title`, `body`, `source`
- `move_task` — `task_ref`, `state_ref`, optional `index`
- `promote_inbox_item_to_task` — `inbox_ref`, optional target state

### Output destination

Almost every routine ends by writing back into the deck. The canonical landing zone is the **inbox**:

```yaml
- id: write_to_inbox
  type: deck
  action: create_inbox_item
  kind: capture
  title: "<topic> - {{ run.date }}"
  source: routine:<routine-name>
  body: |
    {{ steps.<agent_step>.stdout }}
```

`write` (filesystem) is appropriate only when the user explicitly wants files on disk (e.g. archived weekly reports under `archive/`). For anything an agent will later read or the user wants to scroll through, **land it in the inbox**.

## 3. Templating

In any string field (substitution-mode):
- `{{ run.date }}` — ISO date of the run (`2026-05-21`)
- `{{ run.id }}` — `run_01xxx...` identifier
- `{{ steps.<id>.stdout }}` — text output of an earlier step
- `{{ steps.<id>.json }}` — structured output (use `| json` to inline-stringify)
- `{{ steps.<id>.json.<field> }}` — direct field access
- `{{ steps.<id>.json.length }}` — array length (works on any list)
- `{{ state.<key> }}` — persisted state value
- `{{ secrets.<key> }}` — masked-but-usable secret (NEVER appears in step logs)

In `when:` and `transform.body:` (JS sandbox-mode):
- `context.steps.<id>.json`, `context.state.<key>`, `context.run`, `context.secrets`
- Bare globals work too: `steps.<id>.json`, `state.<key>`, `run`
- Secrets are auto-redacted across the sandbox boundary; reading `context.secrets.foo` inside `when:` returns `'[REDACTED]'`

## 4. Critical rules (these are bugs every time)

1. **NEVER write `type: http` with `url: http://127.0.0.1:8787/api/...`** — use `type: deck` with the matching action. Reasons: no HMAC mint required, slim summaries instead of full records (saves prompt tokens + Windows arg-cap headroom), survives port/auth changes.
2. **NEVER add a `transform` "compact" step after `list_tasks` / `list_inbox`** — they already return slim summaries. The compact step is dead weight.
3. **Every `state.X` key used (template OR sandbox) MUST be in `state.declared_keys`** — validator rejects undeclared keys, the routine refuses to save.
4. **Agent prompts must stay under ~30 KB rendered** — Windows `Bun.spawn(["omp", "-p", ...])` blows up past ~32 KB total argv. Use `limit:` on deck reads and project at source; do NOT pass full Task records into the prompt.
5. **`on_failure:` defaults to `abort`** — set it to `continue` only when the rest of the routine can meaningfully proceed without this step's output.
6. **Concurrency defaults to `skip`** — overlapping cron fires are dropped. Use `queue` only if every fire matters and order is critical; `cancel-previous` for "latest wins" semantics.
7. **Cron is UTC unless `timezone:` is set** — set `timezone: America/Chicago` (or the user's actual zone) for any "every morning at X" routine.

## 5. Validate before you write

The protocol package exposes `validateRoutineSpec` which runs Ajv + cross-ref checks (missing step ids in `when:`, missing layout edges, etc).

```bash
cd /c/Users/bryan/enclave/omp-deck
bun -e '
  import("yaml").then(y =>
    import("./packages/protocol/dist/index.js").then(p => {
      const spec = y.parse(`<your YAML here>`);
      const res = p.validateRoutineSpec(spec);
      console.log(res.ok ? "OK" : JSON.stringify(res.errors, null, 2));
    })
  );
'
```

If you don't have the protocol package built, the server's PATCH/POST endpoints validate too — they'll return the same error structure on a bad spec.

## 6. Create the routine

Pick ONE path:

### A. Built-in template (ships with omp-deck)
- File: `apps/server/src/templates/<slug>.yaml`
- Loaded at server boot, available to all installs
- Required when the routine is part of the product itself (daily-briefing, observer-daily, etc)
- Server must restart to pick up template changes: `powershell -File scripts/start-deck-server.ps1`

### B. User routine (lives in this user's DB)
- POST `http://127.0.0.1:8787/api/routines` with `{name, description, specYaml}`
- Or use the visual builder: navigate to `/routines?edit=new`, paste YAML into the Spec tab, click Apply, then Save
- Survives across server restarts (stored in `routines` table)

### Verify it ran
```bash
# Trigger manually
curl -sX POST http://127.0.0.1:8787/api/routines/<routineId>/run

# Wait a few seconds, then check the latest run
curl -s "http://127.0.0.1:8787/api/routines/<routineId>/runs?limit=1"

# And the per-step breakdown
curl -s "http://127.0.0.1:8787/api/routines/<routineId>/runs/<runId>/steps"
```

Failing steps show `error` / `stderrExcerpt`. The most common first-run failures: undeclared state key, agent prompt arg-cap overflow, missing webhook secret env.

## 7. Worked example (read-aggregate-write-cursor)

Daily summary of yesterday's completed tasks landing in the inbox:

```yaml
name: daily-completions-digest
description: Every morning, summarize yesterday's completed tasks into an inbox capture
trigger:
  - cron: "0 7 * * *"
concurrency: skip
timezone: America/Chicago
state:
  declared_keys: [last_digest_date]
tags: [daily, digest]

steps:
  - id: should_run
    type: transform
    body: |
      return context.state.last_digest_date !== run.date;

  - id: fetch_done
    type: deck
    when: steps.should_run.json === true
    action: list_tasks
    state_ref: done
    since_hours: 24
    limit: 25

  - id: summarize
    type: agent
    when: steps.should_run.json === true
    model: claude-sonnet-4-6
    timeout_secs: 60
    prompt: |
      Summarize what shipped yesterday as 3-5 markdown bullets. Skip ceremony.

      Completed ({{ steps.fetch_done.json.length }}): {{ steps.fetch_done.json | json }}

  - id: write_to_inbox
    type: deck
    when: steps.should_run.json === true
    action: create_inbox_item
    kind: capture
    title: "Daily completions - {{ run.date }}"
    source: routine:daily-completions-digest
    body: |
      {{ steps.summarize.stdout }}

  - id: persist
    type: set_state
    when: steps.should_run.json === true
    state:
      last_digest_date: "{{ run.date }}"
```

Reach for this shape any time you have `read → digest → write-to-inbox` + a once-per-day cursor.

## 8. Files to consult when in doubt

- Canonical example: `apps/server/src/templates/daily-briefing.yaml`
- Types (source of truth): `packages/protocol/src/index.ts` — `RoutineSpec`, `RoutineStep`, `RoutineTrigger`
- Schemas (validator): `packages/protocol/src/schemas/`
- Step executors: `apps/server/src/routines/steps/<type>.ts` (one file per type, ~50 lines each)
- Architecture notes (org repo): `knowledge/system/v1-routines-engine-architecture.md`
- Slim-summary rationale: `knowledge/system/agent-step-input-projection-at-source.md`
- Deck-as-step-family rationale: `knowledge/system/first-party-step-family-pattern.md`

## What this skill is NOT for

- Editing an existing routine — open `/routines?edit=<id>` and use the canvas/form. Re-run this skill only if you're starting fresh.
- Designing a new step *type* — that's a protocol + executor + form change across three packages; see the architecture note above.
- Triggering a routine on demand — that's just `POST /api/routines/<id>/run`.
