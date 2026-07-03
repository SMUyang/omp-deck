# CPA Usage Status Panel Design

## Goal

Add a deck Status panel section for CLIProxyAPI/CPA actual request usage using the external collector endpoints under `https://api.hyanapi.xyz/collector`. This is request/token usage telemetry, not provider quota or remaining balance.

## Non-goals

- Do not merge CPA usage into Provider usage.
- Do not label CPA usage as quota, balance, or remaining allowance.
- Do not depend on local `omp usage --json` for CPA usage.
- Do not expose the Basic Auth password to the browser, logs, protocol responses, tests, or error messages.

## Data source

Server-side deck requests these collector endpoints with Basic Auth:

- `GET /health`
- `GET /usage/1h`
- `GET /usage/24h`
- `GET /usage/7d`
- Optional later: `GET /usage/recent`

Configuration is via environment variables:

- `CPA_USAGE_BASE_URL`, default unset, expected example `https://api.hyanapi.xyz/collector`
- `CPA_USAGE_USERNAME`, expected `cpa`
- `CPA_USAGE_PASSWORD`, sensitive
- `CPA_USAGE_TIMEOUT_MS`, default `10000`

If any of base URL, username, or password is missing, `/api/status/cpa-usage` returns `available: false` with a configuration error. The UI renders a muted unavailable line instead of failing the whole Status panel.

## Server API

Add:

```text
GET /api/status/cpa-usage
```

Response shape:

```ts
interface CpaUsageResponse {
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

Collector window shape is accepted defensively. The server only promotes numeric totals and aggregate arrays with known numeric/string fields. Invalid windows are omitted; if every window fails, `available: true` with an error explains the collector was unreachable or returned malformed data.

## UI

Status panel adds a separate section titled `CPA usage` below `Chat usage` and above `Provider usage`.

The section always includes the explanatory text:

```text
CLIProxyAPI request usage, not remaining quota.
```

When data is available, show cards for `1h`, `24h`, and `7d` if each window is present:

- requests
- errors and error rate
- total tokens
- input/output/cached/reasoning tokens when non-zero
- top models by request count, if `per_model` exists
- top API keys by request count, if `per_api_key` exists

If collector is unconfigured or unreachable, show a concise muted/error line. Provider usage continues to render independently.

## Testing

Server tests cover:

- missing env returns `available: false`
- successful health + all three windows returns normalized response
- malformed collector windows are omitted without throwing
- Basic Auth is sent but never reflected in response/error text

Web tests cover:

- Status view model renders CPA unavailable/error states separately from provider usage
- Status view model formats `1h/24h/7d` request/token totals and top model/API-key rows

## Security

- Password remains server-side only.
- Do not log Authorization headers, username/password, or full collector URL with credentials.
- Error messages may include endpoint path/window name and HTTP status, not auth material.
