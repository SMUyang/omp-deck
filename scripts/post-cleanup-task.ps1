$ErrorActionPreference = "Stop"

$body = @'
## Phase
Cleanup / technical debt

## Scope
Five pre-existing `noUncheckedIndexedAccess` errors are blocking workspace-wide green `bun typecheck`. They predate Routines V1 (introduced during T-38/T-39/T-40 KB graph work). All five are `T | undefined` issues where invariants are obvious from local context but not provable to tsc. Trivial to fix; load-bearing because every future workspace typecheck on CI will hit them.

## Errors

**`apps/server/src/kb-service.ts`**

- **L831** `m[1].trim()` -- `m[1]` from `stripped.matchAll(WIKILINK_RE)` is `string | undefined` under strict index access. Capture group 1 is required by the regex pattern so it's never actually undefined at runtime. Fix: `m[1]!.trim()` OR `const tgt = m[1] ?? ""; tgt.trim()`.
- **L890** Same pattern in `rewriteBodyForRender`. Same fix.
- **L941** `candidates[0].relPath` -- guarded by `candidates.length === 1` above. Fix: `candidates[0]!.relPath`.
- **L948** `sorted[0].relPath` -- guarded by `candidates.length === 0` returning early. Fix: `sorted[0]!.relPath`.

**`apps/web/src/views/KbView.tsx`**

- **L739** `decodeURI(target)` -- `target` destructured from `raw.split("?", 1)` is `string | undefined`. `String.prototype.split` with a limit always returns at least one element; tsc doesn't know. Fix: `decodeURI(target ?? raw)` OR destructure with default `const [target = raw] = raw.split("?", 1)`.

## Approach

Surgical per-location fixes; prefer the `!` non-null assertion where the invariant is obvious from a guard a few lines up (kb-service L941/L948). Prefer fallback defaults (`?? raw`) where guards aren't local (KbView L739, kb-service L831/L890 inside `for ... of matchAll(...)` loops where the regex itself is the invariant). Keep the changes minimal -- no refactor.

## Acceptance

- `bun typecheck` from `omp-deck/` workspace root exits 0 across all four packages (@omp-deck/protocol, @omp-deck/telegram-bridge, @omp-deck/server, @omp-deck/web)
- No new tsc errors introduced (use `git diff --stat` to confirm scope; should be ~5 lines changed across 2 files)
- KB graph view + Ctrl-P palette + inspector still render correctly on a smoke test (these are the surfaces those code paths feed)

## Dependencies

None. Independent cleanup; can land any time.

## Context

Discovered 2026-05-21 while shipping Routines V1 Phase 0 (T-43..T-45). Workspace typecheck went red on these errors before V1 work started; the V1 work returned the workspace to the same baseline of 5 errors. See `inbox/captures/omp-deck-server-restart-script-2026-05-19.md`-adjacent capture history.
'@

$payload = @{
    title = "[cleanup] Resolve 5 pre-existing TS-strict errors in kb-service + KbView"
    body = $body
    cwd = "C:/Users/bryan/enclave/omp-deck"
} | ConvertTo-Json -Depth 10 -Compress

$resp = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/tasks" -Method POST -ContentType "application/json" -Body $payload

Write-Output ("Created T-" + $resp.displayId + " (" + $resp.id + ")")
Write-Output ("Title: " + $resp.title)
