# Routines V1 — Comprehensive Plan

**Goal:** turn omp-deck's routines surface from "single-action cron jobs" into a first-class Pattern-3-agent platform. The V1 proof point is a working **daily-briefing** routine that reads the deck's own tasks / inbox / routine-runs, has an agent summarize into a morning capture, and creates a native **capture item in the deck inbox** (`/api/inbox`, kind=`capture`). V1 also ships a **visual builder** (form-mode editing per step type, YAML round-tripping, trigger picker) so creating routines doesn't require YAML literacy — without it the convenience pitch weakens. External integrations (Gmail, Calendar, etc.) land in **V1.5** via the [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) Workspace MCP server. **Inbox-triager** ships as the V1.5 proof point.

Companion docs: `architecture.md` (current deck internals), `proposals/managed-hosting-v0-proposal.html` (Layer 2 hosting design), `knowledge/domains/agent-hosting-whitelabel-layer-deferred.md` (strategic frame).

---

## 1. Current state

### 1.1 omp-deck V0 routines (`apps/server/src/routines-runner.ts` + `db/routines.ts`)

What exists:

- `routines` table with `id, name, description, cron, action_kind, action_body, action_cwd, enabled, last_run_at, next_run_at`
- `action_kind` ∈ `bash | prompt | script` — exactly one action per routine
- `routine_runs` table with `started_at, ended_at, exit_code, stdout_excerpt, stderr_excerpt, error, trigger` (cron|manual)
- Croner-driven in-process scheduler
- 10 min hard runtime cap, 8 KB stdout/stderr excerpt cap
- `prompt` kind shells out to `omp -p <body>`
- REST: GET/POST/PATCH/DELETE on `/api/routines`, plus run history

What's missing for non-trivial routines:

- **Multi-step pipelines** — can't fetch data in step 1, process with LLM in step 2, write back in step 3
- **Trigger types beyond cron** — no webhook, no event, no agent-to-agent
- **Shared context between steps** — no way for a later step to use an earlier step's output
- **Templating** — no `{{ run.date }}`, no `{{ steps.X.json.Y }}`
- **Conditional execution** — can't gate a step on a condition from earlier steps
- **Failure semantics** — single retry/abort decision per routine, no per-step `on_failure`
- **Concurrency control** — what happens when cron fires while previous run is in flight is undefined
- **Budget controls** — no LLM cost cap, no max-step count
- **State across runs** — no place to store "last_seen_id" for incremental polling
- **Per-step observability** — current view collapses to one final `stdout_excerpt`, can't see step-by-step what happened

### 1.2 my-org-new orgd routines (`orgd/src/routines.rs`) — reference, not authoritative

The orgd implementation in `my-org-new` is several rev steps ahead and worth borrowing from:

- Multi-step pipelines stored as YAML-frontmatter `.md` files in `routines/`
- Step kinds: `run` (shell), `agent` (prompt), `write` (templated file)
- Conditional execution via `when:` expressions over the run context
- Per-step `on_failure: abort | continue` + `timeout_secs`
- Shared JSON context: `steps.X.json.Y` flows through subsequent steps
- Templating: `{{ run.id }}`, `{{ run.date }}`, `{{ run.started }}`, `{{ steps.X.json.field }}`, `{{ steps.X.stdout }}`
- Trigger model with `TriggerBody` / `TriggerInfo` for parameterized invocations

Borrowing decisions:

- **Take:** the multi-step model, the YAML+frontmatter spec format, the shared-context pattern, the templating syntax, `when:` / `on_failure:` / `timeout_secs:` semantics.
- **Extend:** trigger types (orgd is mostly cron+manual; we need webhook + event), step types (add `http`, `transform`, `wait`, `set_state`), budget controls, per-step observability, structured-output for agent steps.
- **Discard:** the on-disk-`.md`-as-source-of-truth model — keep markdown files as a portability/export format, but make SQLite the authoritative store so live edits, run history, and metrics queries are fast and transactional.

---

## 2. V1 routine engine — spec

### 2.1 Routine model

A routine is a multi-step pipeline with one or more triggers, an optional cross-run state, and a budget. Stored as a single YAML spec in the `routines.spec_yaml` column (authoritative) and optionally mirrored to `~/.omp/routines/<id>.yaml` for portability.

```yaml
# Example: minimal multi-step routine
name: daily-briefing
description: Summarize yesterday's tasks + emails into the morning inbox
trigger:
  - cron: "0 7 * * *"          # 7am every day
timezone: America/Chicago
concurrency: skip
budget:
  max_duration_secs: 180
  max_llm_cost_usd: 0.05
tags: [daily, morning]
steps:
  - id: fetch_tasks
    type: http
    method: GET
    url: http://localhost:8787/api/tasks?state=done&since=yesterday
  - id: summarize
    type: agent
    prompt: |
      Summarize these tasks into a 1-paragraph briefing:
      {{ steps.fetch_tasks.json }}
    model: claude-sonnet-4-6
  - id: write
    type: write
    path: inbox/captures/morning-briefing-{{ run.date }}.md
    content: |
      ---
      type: inbox
      created: {{ run.date }}
      source: routine
      ---
      # Morning briefing — {{ run.date }}
      {{ steps.summarize.stdout }}
```

### 2.2 Step types

| Type | Purpose | Body fields |
|------|---------|-------------|
| `run` | Shell command (cmd on Windows / bash on POSIX) | `command`, `cwd?` |
| `agent` | Invoke an omp session with a prompt; capture stdout + structured output | `prompt`, `model?`, `structured_output?: { schema, strict }`, `skills_allowed?: [...]` |
| `write` | Write a file with templated content (or append) | `path`, `content`, `append?: bool` |
| `http` | HTTP request; response body parsed as JSON if Content-Type matches | `method`, `url`, `headers?`, `query?`, `body?`, `expect_json?: bool` |
| `deck` | First-party deck action; safer than raw HTTP for deck-owned mutations | `action: create_inbox_item|create_task|move_task|promote_inbox_item_to_task`, action-specific fields |
| `mcp` | Invoke a specific MCP server tool with templated args; response captured as `json`. Requires the named server to be installed via the omp SDK's MCP client (`/mcp install`). | `server`, `tool`, `args?: { ... }` |
| `transform` | Pure-JS expression over the context; returns a value captured to `steps.X.json` | `body` (JS source; sandboxed with no network, no fs) |
| `wait` | Pause for N seconds (useful between retries or for backoff) | `duration_secs` |
| `set_state` | Persist key/value into cross-run state | `state: { key: value, ... }` |

Every step type accepts the common fields: `id` (required, unique within routine), `when?` (boolean expression, skip step if false), `on_failure: abort | continue | retry` (default `abort`), `retry?: { times, backoff, max_delay_secs }`, `timeout_secs`.

### 2.3 Trigger types

```yaml
trigger:
  - cron: "*/15 9-19 * * 1-5"          # weekdays, every 15 min, 9am–7pm
  - webhook:
      path: /hooks/inbox-triager        # exposed at https://{tenant}.ompdeck.app/hooks/inbox-triager
      secret_env: INBOX_TRIAGER_SECRET  # HMAC-SHA256 signature header required
  - manual: { params_schema: { ... } }  # dashboard "Run now" surface + API
  - event:
      source: telegram                   # see §2.3.1 for event sources
      filter: "msg.from.id == 12345"
```

A routine may have multiple triggers. Any one triggers a run; the trigger payload (webhook body, manual params, event payload) lands at `trigger.X` in the context.

#### 2.3.1 Event sources (V1 set)

- `telegram` — fires when the Telegram bridge receives a message. Filter on `chat.id`, `from.id`, message text patterns.
- `gmail` — fires on new mail. **V1.5+**: via the Workspace MCP server's notification mechanism, or via Gmail Pub/Sub push to a deck webhook. V1 doesn't ship this trigger source; the V1.5 inbox-triager uses cron polling until the event path is proven.
- `deck_inbox` — fires when an inbox item is created with a matching `kind`
- `deck_task` — fires on task state transition
- `routine_finished` — fires when another named routine completes (success or failure) — enables routine chains without explicit invocation

### 2.4 Shared context & templating

Every step sees a `context` object with these top-level fields:

```
run:        { id, started, date (ISO date), iso_started, trigger_kind }
trigger:    { ...payload from the firing trigger... }
steps:      { <step_id>: { status, stdout, stderr, json, error, exit_code, duration_ms, model?, tokens? } }
env:        { <ENV_VAR_NAME>: <value> }            # readonly, from tenant .env
secrets:    { <SECRET_NAME>: <value> }              # readonly, from secrets store (mask in logs)
state:      { <key>: <value> }                      # cross-run state, persisted via set_state step
```

Template syntax: `{{ expr }}` where `expr` is dot/bracket access into context. Whole-value substitution (where the field is itself an object/array) preserves type for JSON serialization. Coercion to string is explicit (`{{ steps.X.json | json }}` or similar — Handlebars-style helpers, not Liquid-style).

`when:` expressions are boolean JS expressions over the same context, evaluated in a tight sandbox (no network, no I/O, expression-only).

### 2.5 Failure semantics

- `on_failure: abort` (default) — stop the routine, mark run as failed, persist what's been captured
- `on_failure: continue` — log the failure, continue to next step (failed step's `steps.X.status = "failed"`, downstream `when:` can check)
- `on_failure: retry` — retry the step per `retry:` config; counts toward budget; if all retries fail, falls through to `on_failure_after_retry: abort | continue` (default `abort`)

Per-step `timeout_secs:` defaults to 60 for non-agent steps and 600 for agent steps. Routine-level `timeout_secs` caps the whole run; default 1800 (30 min).

### 2.6 Concurrency

`concurrency:` is a routine-level field:

- `skip` (default) — if a run is in flight when the trigger fires, drop the new invocation
- `queue` — queue subsequent invocations, run them in order after the current one finishes (max queue depth 10; over that, drop)
- `cancel-previous` — kill the in-flight run, start a new one (useful for "latest signal wins" routines like inbox triage)
- `parallel: N` — allow up to N concurrent instances; rare; only for routines that are genuinely independent per-invocation

### 2.7 Budget controls

```yaml
budget:
  max_duration_secs: 300          # whole-run wall clock
  max_llm_cost_usd: 0.10          # estimated cost from token counts × model price table
  max_llm_tokens_input: 100000    # optional finer-grained
  max_llm_tokens_output: 20000
  max_steps_executed: 50          # guards against infinite-branch bugs
```

When any budget is exceeded, the run is aborted with `abort_reason: "budget"` and the partial output preserved. The deck's price table for cost estimation lives at `apps/server/src/budgets/model-prices.ts` (updated when vendor pricing changes).

### 2.8 Cross-run state

```yaml
state:
  declared_keys: [last_seen_id, last_run, processed_count]
```

State is read via `{{ state.X }}`, written via the `set_state` step. Stored in the `routine_state` table (per §6.1 schema), keyed on `(routine_id, key)`. Atomic per step.

This replaces orgd's ad-hoc `routines/state/*.json` pattern with something queryable and transactional. Exported on snapshot/exit-path same as other tenant data.

---

## 3. Observability

### 3.1 Per-run timeline (deck UI)

Click a routine → see all runs. Click a run → see step-by-step timeline:

- Step header: id, type, status (pending/running/success/skipped/failed/aborted), duration, model (for agent steps), token counts
- Expand step → stdout, stderr, captured JSON output, error details
- Live updates during in-flight runs via WS frames (`routine_step_event`)
- "Open in chat" — fork a chat session pre-loaded with the routine's context for interactive debugging

### 3.2 Replay & debug

- **Replay** — re-run a past run with the same trigger payload. Note: external API state isn't replayed (Gmail messages already labeled don't un-label), so replay is for debugging the deck's behavior, not perfect determinism.
- **Debug run** — manual invocation that retains full (untruncated) stdout/stderr, longer history, verbose LLM-request logging. Toggle per-invocation; auto-expires after 1h to avoid bloat.

### 3.3 Metrics

Per-routine aggregates surfaced in the routine detail view:

- Total runs / success rate over last 30 / 90 / lifetime
- p50 / p95 / p99 duration
- LLM cost: month-to-date, last-30-days
- Failure breakdown by `abort_reason`

Surface at fleet level in the managed-hosting dashboard later (Layer 2 concern, not in V1).

---

## 4. Daily-briefing — the V1 proof point

### 4.1 Goals

- Fires every morning at 7am (and manually via webhook for testing)
- Reads the deck's own state: completed tasks in the last 24h, currently active tasks, fresh inbox items, routine runs that failed in the last 24h
- Idempotent against double-fires: a `set_state`-backed `last_briefing_date` check skips re-runs the same day
- Agent summarizes into a structured markdown briefing with four sections (shipped / in flight / needs attention / top focus today)
- Creates a native deck inbox capture item so the user finds it on next deck open
- Exercises every V1 engine primitive without any external auth or third-party API

### 4.2 Routine spec

```yaml
name: daily-briefing
description: Every morning, summarize yesterday's deck activity into a fresh inbox capture
trigger:
  - cron: "0 7 * * *"
  - webhook:
      path: /hooks/daily-briefing-manual
      secret_env: BRIEFING_SECRET
concurrency: skip
timezone: America/Chicago
budget:
  max_duration_secs: 120
  max_llm_cost_usd: 0.05
state:
  declared_keys: [last_briefing_date]
tags: [daily, morning, briefing]

steps:
  - id: should_run
    type: transform
    body: |
      // Idempotency: skip if we already wrote a briefing today
      const today = new Date().toISOString().slice(0, 10);
      return context.state.last_briefing_date !== today;

  - id: fetch_completed
    type: http
    when: steps.should_run.json === true
    method: GET
    url: http://localhost:8787/api/tasks?state=done&since=24h
    expect_json: true
    timeout_secs: 15
    on_failure: abort

  - id: fetch_active
    type: http
    when: steps.should_run.json === true
    method: GET
    url: http://localhost:8787/api/tasks?state=active
    expect_json: true
    timeout_secs: 15
    on_failure: abort

  - id: fetch_inbox
    type: http
    when: steps.should_run.json === true
    method: GET
    url: http://localhost:8787/api/inbox?since=24h
    expect_json: true
    timeout_secs: 15
    on_failure: abort

  - id: fetch_failed_runs
    type: http
    when: steps.should_run.json === true
    method: GET
    url: http://localhost:8787/api/routines/runs?since=24h&status=failed
    expect_json: true
    timeout_secs: 15
    on_failure: continue   # failed-run fetch is non-critical

  - id: write_briefing
    type: agent
    when: steps.should_run.json === true
    model: claude-sonnet-4-6
    timeout_secs: 90
    prompt: |
      Generate a morning briefing in markdown. Keep it tight — 6 to 10 bullets total.

      Yesterday's completed tasks ({{ steps.fetch_completed.json.length }}):
      {{ steps.fetch_completed.json }}

      Active tasks ({{ steps.fetch_active.json.length }}):
      {{ steps.fetch_active.json }}

      Fresh inbox items in the last 24h ({{ steps.fetch_inbox.json.length }}):
      {{ steps.fetch_inbox.json }}

      Failed routine runs in the last 24h ({{ steps.fetch_failed_runs.json.length }}):
      {{ steps.fetch_failed_runs.json }}

      Structure exactly:

      ## What shipped yesterday
      <2-3 bullets of meaningful completions; skip section if nothing>

      ## In flight
      <2-3 bullets of active tasks worth surfacing; skip section if none worth flagging>

      ## Needs attention
      <inbox items or failed routines worth flagging; skip if empty>

      ## Top focus today
      <exactly 1 bullet — the one thing>

      Tone: direct, no fluff, no preamble. The user re-reads this in 30 seconds and knows what matters.
    on_failure: abort

  - id: write_to_inbox
    type: deck
    action: create_inbox_item
    when: steps.should_run.json === true
    kind: capture
    title: "Morning briefing - {{ run.date }}"
    source: routine:daily-briefing
    body: |
      # Morning briefing - {{ run.date }}

      {{ steps.write_briefing.stdout }}

      ---
      _Generated by routine `daily-briefing` run {{ run.id }}_

  - id: persist_state
    type: set_state
    when: steps.should_run.json === true
    state:
      last_briefing_date: "{{ run.date }}"
```

### 4.3 What this routine forces the engine to support

Every requirement in §2 maps to something in this spec:

- Multi-step pipelines, shared context → `steps.X.json` references across 7 steps
- HTTP step → fetch from the deck's own REST API (localhost; auth handled by an internal routine-runner bearer token injected automatically — see §10.2)
- Transform step → date-compare for idempotency, no LLM tokens
- Agent step with prompt templating + model selection + per-step timeout
- `when:` conditional execution → every subsequent step gated on `should_run.json === true`
- Cross-run state → `last_briefing_date` written by `set_state`, read on next run via `context.state`
- Templating → `run.date`, `run.iso_started`, `run.id`, `steps.X.json`, `steps.X.json.length`
- Webhook trigger → manual "run now" via dashboard
- `concurrency: skip` → cron at 7am won't collide with manual webhook test
- Budget controls → caps LLM spend per run
- `on_failure: abort` vs `continue` mixed → critical fetches abort, the non-critical failed-runs fetch continues
- Write step with frontmatter content + path templating

If the engine ships such that this spec runs end-to-end and is debuggable from the deck UI, V1 is done.

### 4.4 V1.5 proof point: inbox-triager

When the V1.5 Workspace MCP integration lands (§5), the inbox-triager routine is the second proof point. It exercises the `mcp` step type + `mcp_servers_allowed` on agent steps against the taylorwilsdon/google_workspace_mcp server.

Spec (reference; finalized in V1.5):

```yaml
name: inbox-triager
description: Triage unread Gmail every 15 min; draft urgent replies, file the rest
trigger:
  - cron: "*/15 9-19 * * 1-5"
  - webhook:
      path: /hooks/inbox-triager-manual
      secret_env: INBOX_TRIAGER_SECRET
concurrency: cancel-previous
timezone: America/Chicago
budget:
  max_duration_secs: 240
  max_llm_cost_usd: 0.10
state:
  declared_keys: [last_seen_timestamp, last_run_finished_at, processed_count_today]
tags: [email, triage, daily]

steps:
  - id: fetch_new
    type: mcp
    server: google-workspace
    tool: gmail_search_messages
    args:
      query: "after:{{ state.last_seen_timestamp }} is:unread -label:Triaged"
      max_results: 50
    timeout_secs: 30
    on_failure: abort

  - id: classify
    type: agent
    when: steps.fetch_new.json.messages.length > 0
    model: claude-sonnet-4-6
    timeout_secs: 120
    prompt: |
      Classify each message into one of:
        urgent      — needs reply in next 4 hours
        important   — needs reply this week
        fyi         — informational, no reply needed
        spam        — junk
        archivable  — read and done (newsletters, receipts, confirmations)

      For urgent and important, draft a short reply (≤ 3 sentences).
      Be ruthless. Most "important" emails are actually FYI or archivable.

      Messages: {{ steps.fetch_new.json.messages }}
    structured_output:
      strict: true
      schema:
        type: array
        items:
          type: object
          required: [message_id, classification]
          properties:
            message_id: { type: string }
            classification: { enum: [urgent, important, fyi, spam, archivable] }
            reasoning: { type: string }
            draft_reply: { type: string }
    on_failure: abort

  - id: apply_actions
    type: agent
    when: steps.classify.json.length > 0
    model: claude-sonnet-4-6
    mcp_servers_allowed: [google-workspace]
    skills_allowed: [deck-inbox, telegram-bridge]
    timeout_secs: 180
    prompt: |
      Apply triage actions for each item in {{ steps.classify.json }} using the google-workspace MCP server's Gmail tools.

        urgent:
          - gmail_create_draft(message_id, body=draft_reply)
          - gmail_modify_labels(message_id, add=["TriagedUrgent"])
          - telegram.send("📧 Urgent: " + subject + " — drafted")
        important:
          - gmail_create_draft(message_id, body=draft_reply)
          - gmail_modify_labels(message_id, add=["TriagedImportant"])
          - deck_inbox.create({kind: "email", title: subject, body: snippet + reasoning})
        fyi:        gmail_modify_labels(message_id, add=["TriagedFYI"])
        archivable: gmail_modify_labels(message_id, remove=["INBOX"])
        spam:       gmail_modify_labels(message_id, add=["SPAM"], remove=["INBOX"])

      Continue on individual failures; report aggregate at end.
    on_failure: continue

  - id: persist_state
    type: set_state
    state:
      last_seen_timestamp: "{{ run.iso_started }}"
      last_run_finished_at: "{{ run.started }}"
      processed_count_today: "{{ steps.fetch_new.json.messages.length }}"

  - id: write_summary
    type: write
    path: inbox/captures/email-triage-{{ run.date }}.md
    append: true
    content: |
      ## Run {{ run.id }} — {{ run.started }}
      Fetched: {{ steps.fetch_new.json.messages.length }}
      Classified: {{ steps.classify.json.length }}
      ---
```

Tool names (`gmail_search_messages`, `gmail_create_draft`, `gmail_modify_labels`) follow taylorwilsdon/google_workspace_mcp's naming. Validated when V1.5 plumbing lands.

### 4.5 What this routine forces the engine to add for V1.5

Every requirement in §2 maps to something in this spec:

- Multi-step pipelines, shared context → `steps.X.json` references everywhere
- HTTP step → fetch from internal Gmail bridge
- Transform step → filter array in pure JS
- Agent step with structured output → JSON-schema-validated classification
- Agent step with `skills_allowed` → restrict the agent's tool surface for safety
- `when:` conditional execution → skip downstream when nothing to triage
- Cross-run state → `last_seen_history_id` for incremental polling
- Templating → in HTTP query, file path, file content
- Webhook trigger → manual "run now" via dashboard
- `concurrency: cancel-previous` → latest 15-min cycle wins
- Budget → cap LLM spend per run
- `on_failure` → continue past individual message-action failures

If we can ship the engine such that this spec runs end-to-end and is debuggable from the deck UI, V1 is done.

---

## 5. Integrations via MCP (V1.5)

Deferred from V1 to keep the foundation focused. When V1 ships and the engine is stable against deck-internal data, V1.5 brings in the Workspace MCP integration layer.

### 5.1 Server choice: taylorwilsdon/google_workspace_mcp

[github.com/taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) is the V1.5 default. Reasons:

- **Twelve services in one server**: gmail, drive, calendar, docs, sheets, slides, chat, forms, tasks, contacts, search, apps_script. Each future routine integration is a tool-name lookup, not a new server install.
- **OAuth 2.1 multi-user mode** — the only self-hosted Workspace MCP with proper bearer-token-per-user auth. Critical for managed hosting where one server serves N tenants.
- **Stateless container support** — fits cleanly as a sidecar in the managed-hosting control plane (per §4 of the managed-hosting V0 proposal).
- **Active maintenance** — v1.20.1 as of the latest release; FastMCP-based, actively shipping.

Trade-off: a single Google Cloud OAuth client requests scopes across all 12 services at consent time. Users granting consent see one larger scope list rather than per-service consent. Acceptable; surface the scope list in the dashboard consent screen so the customer knows what they're agreeing to.

### 5.2 Deployment per mode

**OSS self-hoster:**

1. Install: `pipx install workspace-mcp` (or Docker per upstream README)
2. User creates a Google Cloud OAuth client (one-time, documented wizard in the deck UI links to the upstream setup guide)
3. User runs `workspace-mcp auth` — browser opens, user consents, refresh token cached locally
4. Deck `/mcp add` registers the server (transport: stdio for single-user, streamable-http for daemon mode)
5. Server appears in deck's Integrations page; advertised tools (~80 across all 12 services) become routine-usable via the `mcp` step type

**Managed hosting V1.5 (Layer 2):**

Deploy taylorwilsdon/google_workspace_mcp as a **shared sidecar service in the control plane** (1× CX23, ~$5/mo, behind the existing private network). OAuth 2.1 multi-user mode (`MCP_ENABLE_OAUTH21=true`):

- One service serves all tenants; each tenant authenticates with their own bearer token
- One Google Cloud project + one OAuth client (AgentDock's), tenants grant consent through the dashboard
- Tenant VMs reach the sidecar via private IP; egress allowlist (§7 of managed-hosting V0) adds the sidecar address
- Refresh tokens stored in the tenant's encrypted volume `.env` (per §9.3 of managed-hosting V0)
- One-time setup cost; every tenant's Workspace integration is "free" thereafter

Alternative considered: per-tenant subprocess (each tenant VM runs its own workspace-mcp instance). Rejected because it duplicates a ~150 MB Python runtime × 1000 tenants for no isolation gain (each tenant's tokens are already scoped at the OAuth layer).

Also considered: Google's official remote MCP (`https://gmailmcp.googleapis.com/mcp/v1` + the Calendar sibling). Rejected for V1.5 because Claude Pro/Max/Team gating on the consumer endpoint is unclear for non-Claude MCP clients; revisit in V2 once Google's terms clarify. taylorwilsdon's self-hosted path gives us deterministic behavior in the meantime.

### 5.3 OAuth flow (managed hosting V1.5)

1. Customer clicks **Dashboard → Integrations → Google Workspace → Connect**
2. Dashboard initiates OAuth2 against Google with AgentDock's client ID, redirect URI `https://{tenant}.ompdeck.app/integrations/callback/google`
3. Scopes requested cover the 12 services (read+write across Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, Forms, Tasks, Contacts, Search) — the consent screen surfaces the list to the customer for transparency
4. On consent: tenant deck exchanges code for tokens, persists `refresh_token` in encrypted `.env`
5. Deck registers the shared MCP sidecar URL in `~/.omp/agent/mcp.json` with a bearer-token-fetch function that exchanges the refresh token for a per-request access token
6. Dashboard shows "Connected as bryan@example.com — 12 services available" with a per-service tool-count breakdown

### 5.4 How routines use the MCP server

Two access modes, used together:

**Deterministic `mcp` step** — call a specific tool with templated args, no LLM:

```yaml
- id: fetch_unread
  type: mcp
  server: google-workspace
  tool: gmail_search_messages
  args:
    query: "is:unread newer_than:1h"
    max_results: 50
  timeout_secs: 30
```

The deck validates `args` against the tool's input schema (cached from `tools/list`). Response captured to `steps.fetch_unread.json`. No LLM tokens spent on the fetch.

**Agent step with `mcp_servers_allowed`** — let the LLM choose which tools to call:

```yaml
- id: triage
  type: agent
  model: claude-sonnet-4-6
  mcp_servers_allowed: [google-workspace]
  skills_allowed: [deck-inbox]
  prompt: |
    Triage these messages: {{ steps.fetch_unread.json }}.
    Use the gmail tools to apply labels and create drafts.
```

The agent has access only to tools advertised by the named MCP servers + the listed native skills. The "restrict the surface vs. implicit all-tools" discipline is the right default for routines processing untrusted input (webhook-driven, third-party data).

### 5.5 Adding other MCP servers post-V1.5

The Integrations page surfaces a curated "Recommended" panel beyond the Workspace MCP. Each addition is ~2 days of work: install path documented + dashboard tile + smoke test. Candidates in priority order:

- **Slack** — for "post briefing to a channel" and "triage Slack messages" routines
- **GitHub** — issue/PR triage, release-notes generator
- **Linear** — same shape as GitHub
- **Notion** — for users who lean on it for docs/wiki
- **Discord** — community-management automation

Anything beyond the curated list is one-click via `/mcp install <smithery-id-or-url>` in chat or the Integrations page's "Install custom" input.

### 5.6 Real-time triggers (V2)

V1.5 polls. V2 promotes specific MCP servers to event sources via either Pub/Sub push (Gmail), `events.watch` (Calendar), or MCP-protocol server-initiated notifications. Routines subscribe via `trigger: { event: { source: gmail, type: new_message, filter: "..." } }`. Defer until polling pain is observable.

---

## 6. DB schema changes

### 6.1 Migration `003-routines-v1.sql`

```sql
-- Extend routines for multi-step model.
-- Old single-action columns (action_kind, action_body, action_cwd) are kept
-- for backward compatibility but become NULL for new V1-format routines.
-- The spec_yaml column is the new source of truth.

ALTER TABLE routines ADD COLUMN spec_yaml      TEXT;
ALTER TABLE routines ADD COLUMN concurrency    TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE routines ADD COLUMN budget_json    TEXT;           -- {max_duration_secs, max_llm_cost_usd, ...}
ALTER TABLE routines ADD COLUMN tags           TEXT;           -- comma-separated, for filter UI
ALTER TABLE routines ADD COLUMN timezone       TEXT;           -- per-routine timezone for cron
ALTER TABLE routines ADD COLUMN spec_version   INTEGER NOT NULL DEFAULT 0;  -- 0=v0 (action_kind), 1=v1 (spec_yaml)

-- Per-run aggregates
ALTER TABLE routine_runs ADD COLUMN trigger_kind      TEXT;
ALTER TABLE routine_runs ADD COLUMN trigger_payload   TEXT;    -- JSON of webhook body / manual params / event
ALTER TABLE routine_runs ADD COLUMN total_llm_tokens  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routine_runs ADD COLUMN total_llm_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routine_runs ADD COLUMN aborted_at        TEXT;
ALTER TABLE routine_runs ADD COLUMN abort_reason      TEXT;    -- 'budget' | 'timeout' | 'cancelled' | 'failure'
ALTER TABLE routine_runs ADD COLUMN step_count_total  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routine_runs ADD COLUMN step_count_failed INTEGER NOT NULL DEFAULT 0;

-- Update trigger CHECK to allow new kinds (SQLite doesn't support ALTER CHECK,
-- so do this via TABLE rebuild — handled in the migration script with a
-- temporary table swap).

-- Per-step run records
CREATE TABLE routine_step_runs (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
    step_id         TEXT NOT NULL,
    step_index      INTEGER NOT NULL,
    step_type       TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    status          TEXT NOT NULL CHECK (status IN ('pending','running','success','skipped','failed','aborted')),
    stdout_excerpt  TEXT NOT NULL DEFAULT '',
    stderr_excerpt  TEXT NOT NULL DEFAULT '',
    output_json     TEXT,
    error           TEXT,
    model           TEXT,
    llm_tokens_in   INTEGER,
    llm_tokens_out  INTEGER,
    llm_cost_micros INTEGER,
    duration_ms     INTEGER,
    attempt         INTEGER NOT NULL DEFAULT 1     -- for retries
);

CREATE INDEX idx_step_runs_run ON routine_step_runs(run_id, step_index);
CREATE INDEX idx_step_runs_step ON routine_step_runs(step_id, started_at DESC);

-- Webhook secrets (HMAC keys per routine)
CREATE TABLE routine_webhook_secrets (
    routine_id      TEXT PRIMARY KEY REFERENCES routines(id) ON DELETE CASCADE,
    path            TEXT NOT NULL UNIQUE,           -- /hooks/<slug>
    secret_hash     TEXT NOT NULL,                  -- argon2id of the secret
    created_at      TEXT NOT NULL,
    last_used_at    TEXT
);

-- Cross-run state
CREATE TABLE routine_state (
    routine_id      TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    value_json      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (routine_id, key)
);

-- (No bespoke integrations table. MCP server install state is tracked by the
-- omp SDK's existing MCP client in `~/.omp/agent/mcp.json`; the deck reads
-- from there via `loadCapability`. If we want richer deck-side state in V1.5
-- — per-server usage counts, per-tenant connection status — we add an
-- `mcp_servers` table at that point. V1 needs nothing here.)
```

V0 routines (`spec_version = 0`) continue working unchanged — the runner branches on `spec_version` and uses the old single-action path. Customers can migrate to V1 by editing the routine through the new spec editor (or via API).

### 6.2 Data-flow on a routine run

1. Cron fires (or webhook arrives, or event published) → runner identifies routine
2. `concurrency` check decides queue/skip/cancel
3. Insert `routine_runs` row with `started_at`, `trigger_kind`, `trigger_payload`
4. Initialize context from `trigger`, `state` (read all `routine_state` rows), `env`, `secrets`
5. For each step in order:
    a. Check `when:` — if false, write skipped step record, continue
    b. Insert `routine_step_runs` row with `status='running'`
    c. Broadcast `routine_step_event` WS frame
    d. Execute step body (with timeout, retry policy)
    e. Capture stdout/stderr/structured output → update context
    f. Update `routine_step_runs` with status, output, duration
    g. Broadcast `routine_step_event` WS frame
    h. Update `routine_runs` aggregates (token counts, cost)
    i. Check budget — abort if exceeded
6. Finalize: update `routine_runs.ended_at`, `step_count_total`, `step_count_failed`
7. Broadcast `routine_run_finished` WS frame
8. Fire `routine_finished` event source for any chained routines

---

## 7. API & WS protocol

### 7.1 REST endpoints

Existing endpoints keep their shape. New endpoints:

```
POST   /api/routines/:id/run                  → manual trigger, body = { params? } → { runId }
POST   /api/routines/:id/replay/:runId        → replay past run → { runId }
GET    /api/routines/:id/runs/:runId          → run detail incl. all step runs
GET    /api/routines/:id/runs/:runId/steps    → just steps
GET    /api/routines/:id/state                → cross-run state for debugging
DELETE /api/routines/:id/state/:key           → clear one key
GET    /api/routines/:id/metrics              → success rate, p50/p95, cost

POST   /hooks/*                               → webhook trigger receiver (HMAC verified)

-- (No integration endpoints in V1. The omp SDK's existing `/mcp` slash
-- commands and `/api/mcp` routes already cover install/list/remove. V1.5
-- adds an Integrations page UI that wraps these for the curated Workspace
-- MCP install flow.)
```

### 7.2 WebSocket frames

New broadcast frames (delivered to all open clients so multiple browser tabs stay in sync):

```ts
type RoutineRunStarted = {
  type: "routine_run_started";
  routineId: string;
  runId: string;
  triggerKind: "cron" | "webhook" | "manual" | "event";
  startedAt: string;
};

type RoutineStepEvent = {
  type: "routine_step_event";
  runId: string;
  stepId: string;
  stepIndex: number;
  status: "running" | "success" | "skipped" | "failed";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  excerpt?: { stdout?: string; stderr?: string };
  outputJson?: unknown;
  error?: string;
  model?: string;
  tokens?: { in: number; out: number };
};

type RoutineRunFinished = {
  type: "routine_run_finished";
  runId: string;
  status: "success" | "failed" | "aborted";
  abortReason?: string;
  endedAt: string;
  durationMs: number;
  totalCostMicros: number;
};
```

These flow through the existing `BroadcastBus` singleton (per `architecture.md`).

---

## 8. UI

### 8.1 Routines list view (current view, augmented)

- Card per routine: name, trigger summary (`*/15 9-19 * * 1-5` + `webhook` badges), enabled toggle, last-run status pill
- Sparkline: success/fail over last 30 runs
- MTD cost
- Tag filter (chips), search
- "+" → new routine: choose from blank / template marketplace

### 8.2 Routine detail view (rewrite)

Four tabs. **Builder** is the default; **Spec** is for power users who'd rather edit YAML directly.

- **Builder** (default) — visual builder. JSON-Schema-driven form per step type, toggle to YAML view, round-tripping in both directions. Detailed scope in §8.6.
- **Spec** — Monaco YAML editor with schema validation, lint, "preview" diff against current version. Same backing model as Builder; switching tabs is a no-op for unsaved state.
- **Runs** — paginated list of recent runs. Click into a run → §8.3.
- **Settings** — name, description, enabled toggle, webhook secret regen, manual-run params form (derived from `trigger.manual.params_schema`), delete.

### 8.3 Run detail view (new)

- Header: routine name, run id, trigger kind (with payload preview), status, duration, total cost
- Timeline: vertical strip of step cards, each showing:
    - Status icon (running/success/skipped/failed/aborted)
    - Step id, type
    - Duration
    - Model + token counts (for agent steps)
    - Expand → stdout, stderr, output_json (with JSON pretty-printer)
- Live updates via WS while run is in flight
- Buttons: **Replay**, **Re-run**, **Open in chat** (forks a chat session pre-loaded with run context for interactive debugging), **Cancel** (if running)

### 8.4 Integrations page (V1.5)

Deferred until the Workspace MCP install flow lands. V1 ships the routines list + detail + run views; an Integrations nav entry shows "Coming in V1.5 — install MCP servers via `/mcp install` in chat for now."

When V1.5 lands, `/integrations` becomes:

- **Recommended MCP servers** panel: one-click install for taylorwilsdon/google_workspace_mcp (Workspace = Gmail + Calendar + Drive + Docs + ...), Slack, GitHub, Linear, Notion, Discord. Each tile shows upstream link, transport, tool count.
- **Installed servers** panel: per-server tile with status, connected-as identifier, last-used, tool count, expandable advertised-tool list
- **Telegram bridge** (separate; not MCP) — existing in-tenant subprocess; configured here for unified UX
- "Connect" → OAuth wizard for remote MCP servers, stdio-server OAuth for local-stdio servers
- "Disconnect" → confirm dialog → clears refresh token, marks server `not_configured`
- "Install custom" → input box for `/mcp install <url-or-smithery-id>` for non-curated servers

### 8.5 Routine template marketplace (Phase 2, but reserve URL space)

A curated set of starter routines that customers can one-click install. Initial templates:

- Inbox triager (the V1 proof point)
- Daily briefing (summarize yesterday's deck activity)
- KB curator (nightly knowledge-base maintenance)
- Lead researcher (input: prospect URL; output: research dossier in inbox)
- Telegram digest (hourly summary of group activity)
- GitHub issue triager (similar shape to inbox triager, for repos)

Each template is a YAML spec + a `README.md` explaining what it does + a "required integrations" list. Customer one-clicks → if integrations are missing, the install flow walks them through connecting → routine is created in disabled state for review.

### 8.6 Visual builder — scope and progression

The Builder tab is the default surface for routine authoring. It's in the V1 critical path, not a Phase 6 deferred item — without it, every routine starts with a YAML learning cliff and the convenience-pricing thesis weakens. Three tiers, shipped progressively across V1 / V1.5 / V2.

**V1 (Tier 1) — form mode + trigger picker + settings**

- Per-step form mode driven by JSON Schemas registered in Phase 0 (the same schemas Ajv uses for spec validation; the form is a different rendering of the same source-of-truth)
- Form ↔ YAML round-tripping: form edits update the YAML buffer; valid YAML edits back-populate the form. Invalid YAML disables form view with an inline parse-error explanation pointing at the offending line.
- Add-step picker: dropdown of step types with one-line descriptions; selecting inserts a scaffold YAML block at the cursor or end of `steps:`
- Reorder: up/down arrows on each step card (DnD lands in Tier 2)
- Trigger picker: visual cron builder reusing the V0 cron expression picker (already implements next-5-runs preview), webhook config form (path + secret regen with copy button), manual params schema editor (JSON Schema mini-editor)
- Routine settings form: concurrency dropdown, budget number inputs (duration / LLM cost), declared state-keys multi-tag input, tags input, timezone picker
- Per-step-type forms — one each for `run`, `agent`, `write`, `http`, `deck`, `mcp`, `transform`, `wait`, `set_state`. Common fields (`id`, `when`, `on_failure`, `retry`, `timeout_secs`) factored as a shared `<StepCommonFields>` component
- For the `deck` step in V1: action dropdown (`create_inbox_item`, `create_task`, `move_task`, `promote_inbox_item_to_task`) with text inputs for refs/state names; Tier 2 canvas mode can expose these as separate palette nodes.
- For the `mcp` step in V1: `server` and `tool` are text inputs (Tier 2 upgrades both to dropdowns once Integrations page ships in V1.5)
- For `agent` steps: model dropdown reads from the SDK's `ModelRegistry`; structured_output schema gets a JSON Schema mini-editor; `skills_allowed` / `mcp_servers_allowed` are multi-select chips

**V1.5 (Tier 2) — DnD reordering + MCP-aware forms**

- Drag-and-drop step reordering using the same dnd-kit infrastructure as the kanban (the DragOverlay-optimistic-reorder pattern documented in `knowledge/tools/dnd-kit-dragoverlay-optimistic-reorder.md` is reused)
- Smart-reorder warnings: if a reorder breaks a downstream context reference (e.g. step B was reordered above step A but B references `steps.A.json`), surface an inline warning with a one-click "revert" button
- Step duplicate / delete buttons in the form mode header
- `mcp` step form: `server` dropdown reads from installed MCP servers (post-V1.5 Integrations page), `tool` dropdown reads from the selected server's `tools/list` cache; `args` form auto-generated from the tool's JSON Schema
- Form-mode-only routine creation: customer can author a non-trivial routine end-to-end without ever seeing YAML

**V2 (Tier 3) — pure visual mode + observability fusion**

- Hide YAML by default; the Spec tab becomes an export / debug surface rather than a primary authoring path
- Visual context-flow diagram: step nodes connected by arrows showing data references (which `steps.X.json` fields each step reads); arrows highlight on hover
- Sample-data preview: last-run step output rendered inline next to each downstream step so customers see what data the next step will actually receive
- Per-step "Test this step" runner that executes one step against the last-run context (no full re-run); essential for debugging long routines without burning tokens
- "Open in chat" enhancements: chat session pre-loaded with the routine spec + the customer's question, for natural-language routine editing

The progression is deliberate: Tier 1 unlocks the no-YAML happy path for simple routines while leaving advanced patterns (complex templating, nested transforms) to YAML mode; Tier 2 completes the visual story once MCP integrations land; Tier 3 makes routines genuinely visual-first.

---

## 9. Phased implementation

Total estimate: ~6.5 weeks pacing-pace for V1 (engine + daily-briefing + visual builder Tier 1); ~2.5 weeks for V1.5 (Workspace MCP + inbox-triager + visual builder Tier 2). V1 and V1.5 can ship as separate releases.

### Phase 0 — Foundation (1 week)
- DB migration `003-routines-v1.sql` (routines extension + routine_step_runs + routine_webhook_secrets + routine_state; no mcp_servers / integrations tables)
- Protocol types: extend `Routine`, add `RoutineSpec`, `Step`, `Trigger`, `RoutineStepRun`, new WS frames
- YAML spec parser + JSON-schema-based validator (Ajv or Zod)
- Templating engine (Handlebars-with-restrictions or hand-rolled `{{ expr }}` parser)
- Sandboxed JS evaluator for `when:` and `transform` steps (quickjs-emscripten)

### Phase 1 — Engine (2 weeks)
- Rewrite `routines-runner.ts` for multi-step pipelines:
    - Step types: `run`, `agent`, `write`, `http`, `deck`, `transform`, `wait`, `set_state`, `mcp`
    - `when:` conditionals, `on_failure: abort | continue | retry`, `timeout_secs`
    - Per-step record persistence to `routine_step_runs`
    - WS event broadcast for live UI
- Trigger router:
    - Cron (existing, extended for multi-trigger routines)
    - Webhook receiver: `/hooks/*` Hono route + HMAC validation
    - Manual: `POST /api/routines/:id/run`
- Concurrency controller (skip / queue / cancel-previous / parallel)
- Budget enforcer
- Cross-run state read/write (`routine_state` table, `set_state` step)
- `mcp` step type wires into the SDK's existing MCP client via `loadCapability` — works against any MCP server the user has installed via `/mcp install`, no curated install UI yet
- `mcp_servers_allowed` field on agent steps restricts the agent's tool surface via the SDK
- Internal routine-runner bearer token for HTTP calls to the deck's own API (§10.2)

### Phase 2 — Daily-briefing E2E (0.5 week)
- Author the routine spec (§4.2)
- "Install Daily Briefing" one-click flow in the routines list (creates the routine in disabled state for review)
- Documentation + walkthrough screenshot
- Verify end-to-end on a real morning cycle

### Phase 3 — Visual builder + run observability (3 weeks)

Visual builder (Tier 1 per §8.6):
- Per-step form mode driven by Phase 0's JSON Schemas; one form per step type (`run`, `agent`, `write`, `http`, `mcp`, `transform`, `wait`, `set_state`) + shared `<StepCommonFields>` for `id` / `when` / `on_failure` / `retry` / `timeout_secs`
- YAML ↔ form round-tripping with invalid-YAML graceful degradation
- Add-step picker + up/down arrow reordering (DnD deferred to V1.5)
- Trigger picker: cron builder + next-5-runs preview (extending V0), webhook config form, manual params schema editor
- Routine settings form: concurrency, budget, tags, timezone, declared state keys
- Spec tab: Monaco YAML editor with schema validation, lint, diff preview

Run observability:
- Run detail view (new): live timeline via WS, step expansion, replay, debug mode
- Metrics aggregation on the routine card (success rate sparkline, MTD cost)
- Integrations nav stub ("Coming in V1.5 — install MCP servers via `/mcp install` in chat for now")

**V1 ships here. ≈ 6.5 weeks.**

---

### Phase 4 — Workspace MCP integration (1 week) — V1.5
- Install + smoke test taylorwilsdon/google_workspace_mcp locally (OSS deck path); document the Google Cloud OAuth client setup
- Managed-hosting path: deploy as shared sidecar in the control plane with OAuth 2.1 multi-user mode; egress allowlist update
- Dashboard OAuth wizard for the customer-facing consent flow
- Optional `mcp_servers` table if deck-side state beyond the SDK's MCP client is needed for richer Integrations page UX

### Phase 5 — Inbox-triager + integrations page + builder Tier 2 (1.5 weeks) — V1.5
- Author the inbox-triager routine spec (§4.4) against the Workspace MCP's actual tool names
- "Install Inbox Triager" one-click that scaffolds the routine + checks Workspace MCP is connected
- Telegram notification integration verified against existing bridge
- Integrations page UI shipping with curated recommended panel + installed servers panel
- Visual builder Tier 2: DnD step reordering, step duplicate/delete buttons, MCP `server` + `tool` dropdowns (now that Integrations page knows what's installed), `args` form auto-generated from tool input schemas

**V1.5 ships here. ≈ 9 weeks cumulative.**

---

### Phase 6 — Deferred (post-V1.5, V2 candidates)
- Visual builder Tier 3 (pure visual mode, hide YAML by default; context-flow diagram between steps; inline sample-data preview from last run; per-step "Test this step" runner)
- Real-time MCP-notification triggers (Gmail Pub/Sub, Calendar `events.watch`, generic MCP server-initiated notifications)
- Curated MCP server tiles for Slack, Discord, GitHub, Linear, Notion (~2 days per integration vs ~1.5 weeks for the pre-MCP bespoke pattern)
- Routine template marketplace
- Event source: `routine_finished` for chained routines
- Cost dashboards at fleet level (managed-hosting concern)

---

## 10. Cross-cutting concerns

### 10.1 Backward compatibility

V0 routines (`spec_version = 0`) continue to work. The list view shows them with a "v0" badge and an "Upgrade to v1 spec" button that generates an equivalent V1 YAML. Once edited and saved, the routine is V1.

The single-action `action_kind` columns become NULL for new routines; the runner reads `spec_version` and dispatches to the right execution path.

### 10.2 Security

- **Webhook signatures** — every webhook trigger requires an HMAC-SHA256 signature header (`X-Routine-Signature: sha256=<hex>`). Secret stored as Argon2 hash in `routine_webhook_secrets`. Rejected requests log to `routine_runs` with `trigger_kind = "webhook"` and `abort_reason = "signature_invalid"` so brute-force attempts are visible.
- **Sandboxed step bodies** — `when:` expressions and `transform` step bodies run in a JS VM with no `require`, no network, no fs, no timers beyond 100ms wall clock. Use `quickjs-emscripten` or `vm2` (with awareness of its CVEs — prefer quickjs).
- **`skills_allowed`** — on agent steps, restrict the agent's tool surface to a named subset. Defaults to all available skills (matching current behavior). Useful for routines that handle untrusted input (e.g., webhook-triggered routines processing third-party data).
- **Budget caps** — hard ceilings; a runaway agent step is bounded by `max_llm_tokens_output`, the routine by `max_llm_cost_usd`. Customer's vendor key, customer's runaway risk per BYOK disclosure.
- **Secret leakage** — `{{ secrets.X }}` values masked in stdout/stderr excerpts and step output JSON before persisting. Show `***REDACTED***` in the UI even on debug runs.

### 10.3 Performance

- Croner scheduling is in-memory; reload on routine create/update/delete (existing pattern).
- Webhook latency target: trigger → first step started < 500ms. Achievable because the trigger receiver just enqueues; the runner picks up immediately.
- Per-run overhead (DB writes + WS broadcasts) should be < 100ms across step boundaries.
- Step output JSON capped at 256 KB before truncation. Step stdout/stderr capped at 8 KB (existing) — keep for non-debug runs; raise to 1 MB on debug runs.

### 10.4 Cost surfacing

LLM token counts come from the SDK's response metadata (already exposed by `@oh-my-pi/pi-coding-agent`). Cost is computed from a static price table per model:

```ts
// apps/server/src/budgets/model-prices.ts
export const MODEL_PRICES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  "claude-sonnet-4-6":     { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  "claude-opus-4":          { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  "claude-haiku-4-5":       { inputPerMillion: 1.00, outputPerMillion: 5.00 },
  // ...
};
```

Stored as `llm_cost_micros` (USD micro-cents = millionths of a dollar) to avoid float precision issues. Update when vendor pricing changes; surface that staleness as a banner in the cost-dashboard.

For BYOK customers, the displayed cost is an *estimate* based on this table — actual billing is against their vendor account. This is fine and matches the §9.3 BYOK disclosure ("we estimate; the vendor bills you").

### 10.5 Telemetry on the engine itself

- Every step execution emits a structured log line: `{routineId, runId, stepId, type, duration_ms, status, model?, tokens?, error?}`
- Aggregate logs to JSON-Lines in `~/.omp/deck/logs/routines-YYYY-MM-DD.jsonl` (gitignored)
- Sampled traces (1% in V1, configurable) include the full context at each step boundary for offline analysis
- Phase 1 of managed hosting reroutes these to Grafana Cloud via Vector or OTLP

---

## 11. Open questions

1. **Spec storage: file vs. DB?** Authoritative store is SQLite (`spec_yaml` column). Also mirror to `~/.omp/routines/<id>.yaml` on every save for portability / git-tracking / exit-path. Reads always come from DB. Confirm this dual-write is acceptable, or prefer DB-only.

2. **YAML vs. JSON for the spec?** YAML is more authorable, but JSON is more tool-friendly. I'd default to YAML for spec content + JSON for API payloads (parse YAML server-side, serialize as JSON over the wire). Confirm.

3. **`agent` step structured output strictness.** Default: `strict: true` — if the LLM returns malformed JSON or schema-violating output, the step fails. Alternative: `strict: false` — best-effort parse, fall back to raw stdout. Which default makes for less customer frustration?

4. **`transform` step language.** JS via QuickJS is the natural choice (web app, no Python runtime to embed). Alternative: JSONata (declarative, safer, but a learning curve). I'd start with JS-via-QuickJS; revisit if security review surfaces concerns.

5. **Cross-routine event triggers.** `event: { source: routine_finished, routine: "fetcher" }` lets routines chain. Powerful, also a footgun (cycles). Add cycle detection at routine save time, or trust the user? I'd ship cycle detection at save time — small cost, prevents pathological loops.

6. **MCP server selection for managed hosting.** Decision per the discussion: taylorwilsdon/google_workspace_mcp deployed as a shared sidecar in OAuth 2.1 multi-user mode. Open: Google's official remote MCP (`gmailmcp.googleapis.com`, `calendarmcp.googleapis.com`) may become a credible drop-in if their Claude-plan gating relaxes for non-Claude MCP clients; revisit in V2.

7. **Routine template marketplace governance.** When we ship templates, are they curated by us, or community-contributed? Curated for V1 (small set we own and test), community-contributed Phase 2+ with a review process. Confirm.

8. **`omp -p` vs. in-process SDK call for agent steps.** Currently the V0 `prompt` action shells out to `omp -p`. An in-process call via the embedded SDK (`InProcessAgentBridge`) would be faster and would expose token counts cleanly. The migration is mechanical but touches the bridge interface; confirm whether to do it as part of Phase 1 or fast-follow.

9. **Routine ownership and sharing in multi-user-per-tenant scenarios.** If a tenant ever has multiple users (today: one user per tenant), how are routines scoped? Per-user? Per-tenant-shared? Defer until multi-user-per-tenant lands; for V1, all routines are tenant-scoped.

10. **`when:` expression context inheritance.** Inside a `when:` does the step see ALL of the context, or only `steps.X.json` from prior steps + `run` + `trigger`? I'd default to ALL; secrets and env are useful in conditionals. Confirm; if uncomfortable, restrict to a subset.
