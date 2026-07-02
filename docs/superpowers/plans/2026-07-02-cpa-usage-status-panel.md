# CPA Usage Status Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show CLIProxyAPI/CPA actual request usage in the deck Status panel using the external collector, without presenting it as provider quota or remaining balance.

**Architecture:** The server owns collector credentials and exposes a sanitized `/api/status/cpa-usage` response. Protocol types define the wire contract. The web API and Status panel render CPA usage as a separate section from Provider usage.

**Tech Stack:** TypeScript, Bun tests, Hono server routes, React StatusPanel view model.

---

## Files

- Create `apps/server/src/routes-cpa-usage.ts`: collector config, Basic Auth fetcher, runtime normalization, Hono route.
- Create `apps/server/src/routes-cpa-usage.test.ts`: server route/normalizer tests with stub fetcher.
- Modify `apps/server/src/routes.ts`: mount `buildCpaUsageRouter(config)` at `/api/status/cpa-usage`.
- Modify `apps/server/src/env-schema.ts`: add `CPA_USAGE_BASE_URL`, `CPA_USAGE_USERNAME`, `CPA_USAGE_PASSWORD`, `CPA_USAGE_TIMEOUT_MS`.
- Modify `packages/protocol/src/index.ts`: add `CpaUsageResponse`, `CpaUsageWindow`, `CpaUsageAggregate`, `CpaUsageHealth`.
- Modify `apps/web/src/lib/api.ts`: import `CpaUsageResponse`, add `getCpaUsage()`.
- Modify `apps/web/src/components/status/StatusPanel.tsx`: load CPA usage independently and render separate section.
- Modify or add `apps/web/src/components/status-panel.test.ts`: view-model tests for CPA usage formatting and separation from provider usage.

## Task 1: Server collector route

**Files:**
- Create: `apps/server/src/routes-cpa-usage.ts`
- Create: `apps/server/src/routes-cpa-usage.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/env-schema.ts`

- [ ] **Step 1: Write failing server tests**

Create tests that call `buildCpaUsageResponse(config, fetcher)` with a fake fetcher. Cover:

1. Missing env returns:

```ts
{
  available: false,
  generatedAt: expect.any(Number),
  error: "CPA usage collector is not configured (set CPA_USAGE_BASE_URL/USERNAME/PASSWORD)."
}
```

2. Successful collector calls return `available: true`, `health`, and `windows.h1/h24/d7` with totals.

3. Malformed window payload is omitted while valid windows remain.

4. A 401/500 collector result returns `available: true` with an error and no password in the error text.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test apps/server/src/routes-cpa-usage.test.ts
```

Expected: fails because `routes-cpa-usage.ts` does not exist.

- [ ] **Step 3: Implement minimal server code**

Implement:

```ts
export interface CpaUsageClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export type CpaUsageFetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function buildCpaUsageResponse(config: Config, fetcher: CpaUsageFetcher = fetch): Promise<CpaUsageResponse>;
export function buildCpaUsageRouter(config: Config): Hono;
```

Fetch paths:

- `${baseUrl}/health`
- `${baseUrl}/usage/1h`
- `${baseUrl}/usage/24h`
- `${baseUrl}/usage/7d`

Use Basic Auth header generated from username/password. Normalize only known fields; never echo password.

- [ ] **Step 4: Mount route and env schema**

In `routes.ts`:

```ts
import { buildCpaUsageRouter } from "./routes-cpa-usage.ts";
...
app.route("/", buildCpaUsageRouter(config));
```

In `env-schema.ts`, add four env entries near status/provider config keys:

- `CPA_USAGE_BASE_URL`, non-sensitive
- `CPA_USAGE_USERNAME`, non-sensitive
- `CPA_USAGE_PASSWORD`, sensitive
- `CPA_USAGE_TIMEOUT_MS`, int

- [ ] **Step 5: Verify GREEN**

Run:

```bash
bun test apps/server/src/routes-cpa-usage.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes-cpa-usage.ts apps/server/src/routes-cpa-usage.test.ts apps/server/src/routes.ts apps/server/src/env-schema.ts
git commit -m "Add CPA usage collector route"
```

## Task 2: Protocol and web API contract

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Write failing type/API test if existing seam permits**

If an API-client test exists, add assertion that `api.getCpaUsage()` requests `/status/cpa-usage`. If no seam exists, rely on TypeScript compile and StatusPanel tests in Task 3.

- [ ] **Step 2: Add protocol types**

Add after `ProviderUsageResponse`:

```ts
export interface CpaUsageTotals {
  requests: number;
  errors: number;
  error_rate: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

export interface CpaUsageAggregate {
  key_id?: string;
  model?: string;
  account?: string;
  n: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  errors?: number;
}

export interface CpaUsageWindow {
  window_seconds: number;
  totals: CpaUsageTotals;
  per_api_key: CpaUsageAggregate[];
  per_model: CpaUsageAggregate[];
  per_account: CpaUsageAggregate[];
}

export interface CpaUsageHealth {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
}

export interface CpaUsageResponse {
  available: boolean;
  generatedAt: number;
  error?: string;
  health?: CpaUsageHealth;
  windows?: {
    h1?: CpaUsageWindow;
    h24?: CpaUsageWindow;
    d7?: CpaUsageWindow;
  };
}
```

- [ ] **Step 3: Add API method**

In `apps/web/src/lib/api.ts`, import `CpaUsageResponse` and add:

```ts
getCpaUsage(): Promise<CpaUsageResponse> {
  return request<CpaUsageResponse>("/status/cpa-usage");
}
```

- [ ] **Step 4: Verify typecheck**

Run:

```bash
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/server' typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts apps/web/src/lib/api.ts
git commit -m "Add CPA usage protocol contract"
```

## Task 3: Status panel rendering

**Files:**
- Modify: `apps/web/src/components/status/StatusPanel.tsx`
- Modify: `apps/web/src/components/status-panel.test.ts`

- [ ] **Step 1: Write failing view-model tests**

Add tests for `buildStatusPanelViewModel(session, providerUsage, cpaUsage)`:

1. Unavailable CPA returns a `cpa` model with note `CPA usage collector is not configured...` while provider sections still render.
2. Populated 1h/24h/7d windows render labels `1h`, `24h`, `7d`, request counts, error-rate, token totals, and top model/API key rows.
3. The explanatory copy contains `not remaining quota`.

- [ ] **Step 2: Verify RED**

Run:

```bash
bun test apps/web/src/components/status-panel.test.ts
```

Expected: fails because view model does not accept/render CPA usage.

- [ ] **Step 3: Implement CPA view model and loader**

Add independent cache/request state:

```ts
let cpaUsageCache: CpaUsageResponse | undefined;
let cpaUsageRequest: Promise<CpaUsageResponse> | undefined;
```

Add `loadCpaUsage()` using `api.getCpaUsage()`.

Extend `StatusPanelViewModel` with:

```ts
cpaUsage: {
  description: string;
  loadingLabel: string;
  error?: string;
  windows: Array<{
    label: "1h" | "24h" | "7d";
    requests: string;
    errors: string;
    tokens: string;
    topModels: string[];
    topApiKeys: string[];
  }>;
};
```

Render `PanelSection title="CPA usage"` between Chat usage and Provider usage.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
bun test apps/web/src/components/status-panel.test.ts
```

Expected: all status panel tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/status/StatusPanel.tsx apps/web/src/components/status-panel.test.ts
git commit -m "Show CPA usage in status panel"
```

## Task 4: End-to-end verification and deployment

**Files:**
- No new source files unless fixing review findings.

- [ ] **Step 1: Run targeted tests**

```bash
bun test apps/server/src/routes-cpa-usage.test.ts apps/web/src/components/status-panel.test.ts
bun run --filter '@omp-deck/server' typecheck
bun run --filter '@omp-deck/web' typecheck
bun run --filter '@omp-deck/web' build
```

Expected: all exit 0.

- [ ] **Step 2: Run external collector smoke with env**

Use `CPA_USAGE_BASE_URL=https://api.hyanapi.xyz/collector`, `CPA_USAGE_USERNAME=cpa`, and the password from the server credential file. Do not print password. Start or call the route and assert:

```text
GET /api/status/cpa-usage -> 200
available === true
windows.h1.totals.requests is a number
```

- [ ] **Step 3: Code review**

Dispatch reviewer with base `origin/main` and current HEAD. Required checks:

- Password cannot leak to frontend/logs/errors.
- CPA usage is not labeled as quota.
- Provider usage still works independently.
- Runtime guards reject malformed collector payloads.

- [ ] **Step 4: Merge, push, deploy**

Fast-forward merge into main from the clean worktree, push `origin/main`, restart deck from a clean deploy worktree, and verify:

```text
/api/health buildSha == new commit
/api/status/cpa-usage returns 200 with collector data
Status panel browser smoke shows CPA usage section
```
