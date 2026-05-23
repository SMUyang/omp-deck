# Scaffold the V1 routines tasks into the deck kanban.
# ASCII-only per PS 5.1 .ps1 parse rules; reads JSON via .NET to avoid Get-Content cp1252 corruption.
$ErrorActionPreference = "Stop"

$jsonPath = "C:\Users\bryan\enclave\omp-deck\scripts\v1-routines-tasks.json"
$stubDir = "C:\Users\bryan\enclave\my-org-new\tasks\backlog"
$apiBase = "http://127.0.0.1:8787/api"

# Read JSON via .NET so UTF-8 round-trips correctly on PS 5.1
$utf8 = [System.Text.UTF8Encoding]::new($false)
$raw = [System.IO.File]::ReadAllText($jsonPath, $utf8)
$spec = $raw | ConvertFrom-Json

# Verify deck is responding
try {
    $health = Invoke-RestMethod -Uri "$apiBase/health" -UseBasicParsing -TimeoutSec 3
    Write-Output ("Deck PID: " + $health.pid + " - OK")
} catch {
    Write-Output "ERROR: deck not responding at $apiBase/health"
    Write-Output ("  " + $_.Exception.Message)
    exit 1
}

# Create stub dir if missing
if (-not (Test-Path $stubDir)) { New-Item -ItemType Directory -Path $stubDir -Force | Out-Null }

$today = Get-Date -Format "yyyy-MM-dd"
$created = @()

foreach ($task in $spec.tasks) {
    $payload = @{
        title = $task.title
        body = $task.body
        cwd = $spec.cwd
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $resp = Invoke-RestMethod -Uri "$apiBase/tasks" -Method POST -ContentType "application/json" -Body $payload -UseBasicParsing -TimeoutSec 10
        $displayId = "T-" + $resp.displayId
        Write-Output ("CREATED " + $displayId + " " + $resp.id + " " + $task.title)
        $created += [pscustomobject]@{ taskId = $resp.id; displayId = $displayId; title = $task.title }
    } catch {
        Write-Output ("ERROR creating: " + $task.title)
        Write-Output ("  " + $_.Exception.Message)
        exit 1
    }
}

Write-Output ""
Write-Output ("Created " + $created.Count + " tasks. Writing forwarding stubs to: " + $stubDir)

# Slug helper - strips [V1 PX] prefix and non-alnum
function To-Slug($title) {
    $s = $title -replace '^\[V1[^\]]+\]\s*', ''
    $s = $s.ToLower()
    $s = $s -replace '[^a-z0-9]+', '-'
    $s = $s -replace '^-+|-+$', ''
    if ($s.Length -gt 60) { $s = $s.Substring(0, 60) -replace '-+$', '' }
    return $s
}

foreach ($t in $created) {
    $slug = To-Slug $t.title
    $stubPath = Join-Path $stubDir ("omp-deck-routines-v1-" + $slug + ".md")
    $stub = @"
---
type: task
status: migrated
created: $today
completed: null
migrated: $today
migrated-to: omp-deck/$($t.taskId)
tags: [omp-deck, routines, v1]
---

# omp-deck - $($t.title)

Migrated to the omp-deck kanban as task ``$($t.taskId)`` ($($t.displayId)) on $today.

omp-deck is the source of truth for omp-deck-scoped work. Open the deck (http://127.0.0.1:5174/tasks) or pull via REST:

    curl -s http://127.0.0.1:8787/api/tasks/$($t.taskId)

Companion plan: ``C:/Users/bryan/enclave/omp-deck/docs/proposals/routines-v1-plan.md``.

This file is a forwarding stub; the live spec lives on the deck.
"@
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($stubPath, $stub, $utf8NoBom)
    Write-Output ("STUB " + $stubPath)
}

Write-Output ""
Write-Output "Summary:"
$created | Format-Table -AutoSize
