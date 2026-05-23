$ErrorActionPreference = "Stop"

$spec = @'
name: p1-smoke-test
description: V1 P1 smoke test - exercises http + transform + write + set_state
trigger:
  - manual: {}
concurrency: skip
budget:
  max_duration_secs: 30
state:
  declared_keys: [run_count]
tags: [smoke, v1]
steps:
  - id: fetch_health
    type: http
    method: GET
    url: http://127.0.0.1:8787/api/health
    expect_json: true
    on_failure: abort
  - id: extract_pid
    type: transform
    body: |
      return { pid: context.steps.fetch_health.json.pid, ok: context.steps.fetch_health.json.ok };
  - id: compute_next
    type: transform
    body: |
      const prev = Number(context.state.run_count) || 0;
      return { next: prev + 1 };
  - id: write_marker
    type: write
    path: C:/Users/bryan/enclave/omp-deck/.logs/v1-smoke.txt
    content: |
      V1 P1 smoke test
      Run id:        {{ run.id }}
      Started:       {{ run.iso_started }}
      Deck PID:      {{ steps.extract_pid.json.pid }}
      Health.ok:     {{ steps.extract_pid.json.ok }}
      Prior count:   {{ state.run_count }}
      New count:     {{ steps.compute_next.json.next }}
  - id: bump_state
    type: set_state
    state:
      run_count: "{{ steps.compute_next.json.next }}"
'@

$createBody = @{
    name = "p1-smoke-test"
    description = "V1 P1 smoke test"
    specYaml = $spec
    enabled = $false
} | ConvertTo-Json -Depth 10 -Compress

Write-Output "=== Step 1: Create routine ==="
$created = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines" -Method POST `
    -ContentType "application/json" -Body $createBody
Write-Output ("Created routine id=" + $created.id + " specVersion=" + $created.specVersion + " concurrency=" + $created.concurrency)
$routineId = $created.id

Write-Output ""
Write-Output "=== Step 2: Manual run (first time) ==="
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/run" -Method POST `
    -ContentType "application/json" -Body "{}" | Out-Null

Start-Sleep -Seconds 2

Write-Output ""
Write-Output "=== Step 3: Inspect run history ==="
$runs = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/runs?limit=5"
$run1 = $runs.runs[0]
Write-Output ("Latest run: " + $run1.id)
Write-Output ("  trigger:           " + $run1.trigger)
Write-Output ("  startedAt:         " + $run1.startedAt)
Write-Output ("  endedAt:           " + $run1.endedAt)
Write-Output ("  exitCode:          " + $run1.exitCode)
Write-Output ("  stepCountTotal:    " + $run1.stepCountTotal)
Write-Output ("  stepCountFailed:   " + $run1.stepCountFailed)
Write-Output ("  totalLlmTokens:    " + $run1.totalLlmTokens)
Write-Output ("  totalLlmCostMicros:" + $run1.totalLlmCostMicros)
Write-Output ("  abortReason:       " + $run1.abortReason)

Write-Output ""
Write-Output "=== Step 4: Per-step records ==="
$steps = Invoke-RestMethod -Uri ("http://127.0.0.1:8787/api/routines/$routineId/runs/" + $run1.id + "/steps")
foreach ($s in $steps.steps) {
    Write-Output ("  [" + $s.stepIndex + "] " + $s.stepId + " (" + $s.stepType + "): " + $s.status + " in " + $s.durationMs + "ms")
    if ($s.error) { Write-Output ("      error: " + $s.error) }
    if ($s.outputJson) {
        $abbrev = if ($s.outputJson.Length -gt 200) { $s.outputJson.Substring(0,200) + "…" } else { $s.outputJson }
        Write-Output ("      output: " + $abbrev)
    }
}

Write-Output ""
Write-Output "=== Step 5: Marker file content ==="
$marker = "C:\Users\bryan\enclave\omp-deck\.logs\v1-smoke.txt"
if (Test-Path $marker) {
    Get-Content $marker | ForEach-Object { Write-Output ("  | " + $_) }
} else {
    Write-Output "  (marker file not written)"
}

Write-Output ""
Write-Output "=== Step 6: Manual run (second time - exercise state persistence) ==="
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/run" -Method POST `
    -ContentType "application/json" -Body "{}" | Out-Null
Start-Sleep -Seconds 2
$runs2 = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/runs?limit=5"
$run2 = $runs2.runs[0]
$steps2 = Invoke-RestMethod -Uri ("http://127.0.0.1:8787/api/routines/$routineId/runs/" + $run2.id + "/steps")
$bumpStep = $steps2.steps | Where-Object { $_.stepId -eq "bump_state" } | Select-Object -First 1
Write-Output ("Second run bump_state output: " + $bumpStep.outputJson)
if (Test-Path $marker) {
    Write-Output ("Marker file after run #2:")
    Get-Content $marker | ForEach-Object { Write-Output ("  | " + $_) }
}

Write-Output ""
Write-Output "=== Step 7: Cleanup (delete smoke routine) ==="
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId" -Method DELETE | Out-Null
Remove-Item $marker -ErrorAction SilentlyContinue
Write-Output ("Deleted routine " + $routineId)
