# Wraps the omp-deck server with restart-on-crash supervision.
# ASCII only per PS 5.1 .ps1 parse rules. No em-dashes, no smart quotes.
#
# Invariants:
#   - Each spawn redirects stdout/stderr to a fresh timestamped file under .logs/
#   - Supervisor decisions (spawn/exit/backoff/give-up) append to .logs/supervisor.log
#   - Exponential backoff 1s -> 60s on rapid crashes (<30s lifetime)
#   - Backoff resets to 1s after a child runs >30s
#   - Ctrl+C in the supervisor terminal kills the supervisor AND the child
#   - The supervisor never holds port 8787 itself; it just orchestrates the child
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/supervise-deck-server.ps1
#
# Stop with Ctrl+C in this terminal, or by killing this PowerShell process.

$ErrorActionPreference = "Stop"

$root         = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverDir    = Join-Path $root "apps\server"
$logDir       = Join-Path $root ".logs"
$supervisorLog= Join-Path $logDir "supervisor.log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Single shared script-scope copy so the Ctrl+C handler can reach it.
$script:childProc   = $null
$script:shuttingDown = $false

function Write-SupervisorLog([string]$line) {
  $ts = Get-Date -Format "o"
  $entry = "$ts $line"
  Write-Host $entry
  Add-Content -Path $supervisorLog -Value $entry
}

function Stop-Child {
  if ($script:childProc -and -not $script:childProc.HasExited) {
    try {
      Stop-Process -Id $script:childProc.Id -Force -ErrorAction SilentlyContinue
      Write-SupervisorLog ("killed child PID=" + $script:childProc.Id)
    } catch {
      Write-SupervisorLog ("Stop-Process threw: " + $_.Exception.Message)
    }
  }
}

# Kill any stale listener on the port before each spawn. The dev terminal
# sometimes leaves an orphan when the supervisor is restarted.
function Clear-Stale-Port([int]$port) {
  $ns = & netstat -aon -p TCP
  foreach ($line in $ns) {
    if ($line -match (":" + $port + "\s") -and $line -match "LISTENING") {
      $parts = $line.Trim() -split "\s+"
      $stalePid = [int]$parts[-1]
      Write-SupervisorLog ("clearing stale listener on " + $port + " PID=" + $stalePid)
      Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }
  }
}

# Ctrl+C handler. PowerShell does not allow registering CancelKeyPress on the
# Console class while in a Cmdlet pipeline, but it does honor a trap on the
# break/control signal. We use [Console]::TreatControlCAsInput trick is
# unreliable on 5.1; the simpler path is to register a Process.Exited handler
# on $script:childProc and let Ctrl+C raise PipelineStoppedException, which
# unwinds to the finally block below.

try {
  Write-SupervisorLog "supervisor started"

  $backoffMs    = 1000
  $maxBackoffMs = 60000
  $restartCount = 0
  $consecutiveQuickExits = 0

  while (-not $script:shuttingDown) {
    Clear-Stale-Port 8787

    $ts      = Get-Date -Format "yyyyMMdd-HHmmss"
    $outLog  = Join-Path $logDir ("dev-server-" + $ts + ".out.log")
    $errLog  = Join-Path $logDir ("dev-server-" + $ts + ".err.log")
    $spawnAt = Get-Date

    Write-SupervisorLog ("spawning deck server attempt=" + ($restartCount + 1) + " out=" + $outLog)

    $script:childProc = Start-Process -FilePath "bun" `
        -ArgumentList "src/index.ts" `
        -WorkingDirectory $serverDir `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru

    Write-SupervisorLog ("spawned PID=" + $script:childProc.Id)

    # Block until child exits.
    $script:childProc.WaitForExit()
    $exitCode = $script:childProc.ExitCode
    $ranFor   = (Get-Date) - $spawnAt
    Write-SupervisorLog ("child exited PID=" + $script:childProc.Id + " exitCode=" + $exitCode + " ranFor=" + [int]$ranFor.TotalSeconds + "s")

    # Forensic tail of stderr so the supervisor log preserves the proximate cause.
    if (Test-Path $errLog) {
      $tail = Get-Content $errLog -Tail 25 -ErrorAction SilentlyContinue
      if ($tail) {
        Write-SupervisorLog "stderr tail:"
        foreach ($l in $tail) { Write-SupervisorLog ("  " + $l) }
      }
    }

    if ($script:shuttingDown) { break }

    $restartCount++

    # Long-running child: reset backoff. Rapid crash: keep escalating.
    if ($ranFor.TotalSeconds -gt 30) {
      $consecutiveQuickExits = 0
      $backoffMs = 1000
      Write-SupervisorLog "child ran >30s, resetting backoff to 1s"
    } else {
      $consecutiveQuickExits++
      Write-SupervisorLog ("quick exit count=" + $consecutiveQuickExits + " backoffMs=" + $backoffMs)
    }

    # Give up after 10 consecutive rapid crashes. Operator should look at logs.
    if ($consecutiveQuickExits -ge 10) {
      Write-SupervisorLog "ABORT: 10 consecutive quick exits, supervisor giving up"
      break
    }

    Write-SupervisorLog ("backoff " + $backoffMs + "ms then restart")
    Start-Sleep -Milliseconds $backoffMs
    $backoffMs = [Math]::Min($backoffMs * 2, $maxBackoffMs)
  }
} finally {
  $script:shuttingDown = $true
  Write-SupervisorLog "supervisor shutting down"
  Stop-Child
  Write-SupervisorLog "supervisor exited"
}
