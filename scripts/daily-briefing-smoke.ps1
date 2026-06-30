$ErrorActionPreference = "Stop"

Write-Output "=== Step 1: List templates ==="
$templates = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routine-templates"
$templates.templates | Format-Table -AutoSize

Write-Output ""
Write-Output "=== Step 2: Install daily-briefing template ==="
$installed = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routine-templates/daily-briefing" -Method POST
Write-Output ("Installed routine: " + $installed.id)
Write-Output ("  name:        " + $installed.name)
Write-Output ("  specVersion: " + $installed.specVersion)
Write-Output ("  concurrency: " + $installed.concurrency)
Write-Output ("  enabled:     " + $installed.enabled)
Write-Output ("  cron:        " + $installed.cron)
Write-Output ("  tags:        " + ($installed.tags -join ", "))
$routineId = $installed.id

Write-Output ""
Write-Output "=== Step 3: Manual run ==="
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/run" -Method POST `
    -ContentType "application/json" -Body "{}" | Out-Null

# Allow time for the agent step to invoke omp -p (LLM call can take a few seconds)
Write-Output "Waiting up to 180s for the run to complete..."
$run = $null
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 1
    $runs = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/runs?limit=1"
    if ($runs.runs.Count -gt 0 -and $runs.runs[0].endedAt) {
        $run = $runs.runs[0]
        Write-Output ("Run finished after ~" + ($i + 1) + "s")
        break
    }
}
if (-not $run) {
    Write-Output "Run did not complete within 180s; leaving routine installed for manual inspection."
    exit 1
}

Write-Output ""
Write-Output ("Run summary: " + $run.id)
Write-Output ("  exitCode:           " + $run.exitCode)
Write-Output ("  stepCountTotal:     " + $run.stepCountTotal)
Write-Output ("  stepCountFailed:    " + $run.stepCountFailed)
Write-Output ("  totalLlmTokens:     " + $run.totalLlmTokens)
Write-Output ("  totalLlmCostMicros: " + $run.totalLlmCostMicros)
Write-Output ("  abortReason:        " + $run.abortReason)

Write-Output ""
Write-Output "=== Step 4: Per-step records ==="
$steps = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/routines/$routineId/runs/$($run.id)/steps"
foreach ($s in $steps.steps) {
    Write-Output ("  [" + $s.stepIndex + "] " + $s.stepId + " (" + $s.stepType + "): " + $s.status + " in " + $s.durationMs + "ms")
    if ($s.error) { Write-Output ("      error: " + $s.error) }
    if ($s.stepType -eq "agent" -and $s.stdoutExcerpt) {
        $abbrev = if ($s.stdoutExcerpt.Length -gt 400) { $s.stdoutExcerpt.Substring(0,400) + "..." } else { $s.stdoutExcerpt }
        Write-Output ("      agent stdout (first 400 chars):")
        $abbrev -split "`n" | ForEach-Object { Write-Output ("        | " + $_) }
    }
}

Write-Output ""
Write-Output "=== Step 5: Generated inbox capture ==="
$inbox = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/inbox?kind=capture&includeProcessed=true"
$item = $inbox.items | Where-Object { $_.source -eq "routine:daily-briefing" } | Select-Object -First 1
if ($item) {
    Write-Output ("Found inbox item: " + $item.id + " - " + $item.title)
    ($item.body -split "`n" | Select-Object -First 60) | ForEach-Object { Write-Output ("  | " + $_) }
    Write-Output "[Routine left installed -- disabled by default. Enable from the kanban or the Routines UI when ready to fire on schedule.]"
} else {
    Write-Output "Briefing inbox item NOT found."
    Write-Output "Check the per-step output above; the agent step may have failed."
}
