# CPA Usage Design

## Decision

Implement CLIProxyAPI request-level usage as a separate opt-in feature named
**CPA usage**. Do not mix it with the existing provider quota panel.

The existing `Provider usage` panel shows quota-style reports from:

```text
omp usage --json
```

CPA usage will show request-level events from CLIProxyAPI Management API.
These are different data planes and must remain separately labeled in the UI.

## Current state

`omp-deck` currently has:

- `/api/status/provider-usage`, backed by `omp usage --json`.
- Status panel provider usage cards for quota-style reports.
- No CLIProxyAPI Management API client.
- No persisted CLIProxyAPI usage event table.

CLIProxyAPI upstream has:

- `GET /v0/management/api-key-usage`: non-destructive recent success/failure
  buckets for in-memory `api_key` auths.
- `GET /v0/management/usage-queue?count=N`: destructive pop of queued
  request-level usage records.
- `usage-statistics-enabled`: config/Management API toggle.
- Request usage records containing provider, model, auth metadata, latency,
  TTFT, failure state, token detail, and response headers.

CLIProxyAPI README_CN states that since v6.10.0 CLIProxyAPI and CPAMC no longer
ship built-in data statistics; persistent dashboards are external projects.

## Goals

- Add optional deck support for CLIProxyAPI request-level usage.
- Let users configure CLIProxyAPI Management API URL and key.
- Persist consumed usage events to deck SQLite.
- Display CPA request usage in a separate UI section from provider quota.
- Avoid silently stealing usage events from other collectors.

## Non-goals

- Do not replace `omp usage --json` provider quota reporting.
- Do not scrape CLIProxyAPI config or auth files.
- Do not infer provider subscription quota from request events.
- Do not enable destructive queue consumption by default.
- Do not estimate costs unless a model price table is explicitly configured.

## Data sources

### Management API health/config

The deck needs a minimal client configured by env and settings:

```env
OMP_DECK_CPA_MANAGEMENT_URL=http://127.0.0.1:8317
OMP_DECK_CPA_MANAGEMENT_KEY=...
OMP_DECK_CPA_USAGE_COLLECTOR=0
```

The key is secret material and must use existing env-store redaction patterns.

### `/v0/management/api-key-usage`

Use as a non-destructive read path when available.

Properties:

- grouped by provider and `base_url|api_key`
- success/failed counts
- recent request buckets
- api-key auth only
- no token detail or cost

This is safe for a passive status panel.

### `/v0/management/usage-queue?count=N`

Use only when the user explicitly enables deck as a collector.

Properties:

- destructive pop
- request-level event payloads
- includes token detail and latency when upstream supplies it
- queue retention is short; defaults to 60 seconds, max 3600 seconds
- only one collector should consume it

The UI must warn:

```text
This consumes CLIProxyAPI usage-queue records. Do not enable if another CPA
usage collector is already running.
```

## Storage

Add a deck SQLite table for persisted request events:

```sql
CREATE TABLE cpa_usage_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  requested_at TEXT,
  provider TEXT,
  model TEXT,
  alias TEXT,
  api_key_hash TEXT,
  auth_id TEXT,
  auth_index TEXT,
  auth_type TEXT,
  source TEXT,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  total_tokens INTEGER,
  raw_json TEXT NOT NULL
);
```

Deduplication:

- Prefer a stable id if the usage record includes one.
- Otherwise hash normalized raw JSON plus received timestamp bucket.
- Store raw JSON for forward compatibility.

Retention:

- Default keep 30 days.
- Add configurable retention later if needed.

## Backend API

Add deck routes under `/api/cpa-usage`:

```text
GET  /api/cpa-usage/status
GET  /api/cpa-usage/summary?window=1h|24h|7d|30d
GET  /api/cpa-usage/events?limit=100&provider=&model=
POST /api/cpa-usage/collector/run-once
```

`status` reports:

- configured/not configured
- collector enabled/disabled
- last poll time
- last error
- management API reachability
- whether destructive queue collection is enabled

`summary` reports:

- requests by provider/model
- failures by provider/model
- token totals
- latency/TTFT summaries when present

## UI

Add a separate status section:

```text
CPA request usage
```

Do not put CPA request usage inside the existing `Provider usage` quota section.

Initial UI:

- Configuration status.
- Current collector mode: off / api-key usage only / usage-queue collector.
- Provider/model request counts.
- Token totals when available.
- Failure counts.
- Warning when usage-queue collector is enabled.

Labels:

- `Provider usage` = quota/provider native reports from `omp usage --json`.
- `CPA request usage` = CLIProxyAPI request events.

## Collector behavior

The collector is disabled by default.

When enabled:

1. Poll `/v0/management/usage-queue?count=100` at a conservative interval.
2. Parse every returned JSON record as unknown first.
3. Normalize known fields into `cpa_usage_events`.
4. Store raw JSON for unknown fields.
5. Broadcast a status frame when new events arrive.
6. Back off on 401/403 or network errors.

A manual `run-once` endpoint supports testing without enabling background
collection.

## Error handling

- Missing Management URL/key: show `not configured`.
- 401/403: show `management auth failed`; do not retry aggressively.
- 404: show `usage endpoint unavailable`; keep feature disabled.
- Parse failure: store raw event with minimal metadata when possible.
- Queue collector conflict cannot be auto-detected; warn in UI.

## Tests

- Management API client attaches bearer token and parses JSON responses.
- `/api-key-usage` summary is non-destructive and maps success/failure buckets.
- `/usage-queue` collector persists events and raw JSON.
- Collector does not run unless explicitly enabled.
- Summary endpoint aggregates provider/model/token/failure counts.
- UI labels distinguish quota usage from CPA request usage.

## Implementation order

1. Add configuration/env entries for CPA Management API.
2. Add typed client with unknown-first parsing.
3. Add SQLite table and persistence functions.
4. Add manual `run-once` collector endpoint.
5. Add summary/status endpoints.
6. Add UI section for CPA request usage.
7. Add optional background collector.
8. Run targeted tests and typechecks.

## Acceptance criteria

- Existing provider quota panel still works unchanged.
- With no CPA config, UI says CPA usage is not configured.
- With Management API configured, `api-key-usage` can be displayed without
  consuming queue records.
- With collector enabled, queue records are persisted and summarized.
- UI clearly warns when destructive queue consumption is enabled.
