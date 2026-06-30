# Start the omp-deck server in the background. ASCII only per PS 5.1 .ps1 parse rules.
$ErrorActionPreference = "Stop"

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverDir = Join-Path $rootDir "apps\server"
$logDir = Join-Path $rootDir ".logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$outLog = Join-Path $logDir "dev-server-$ts.out.log"
$errLog = Join-Path $logDir "dev-server-$ts.err.log"

# Pre-kill anyone holding 8787
$ns = & netstat -aon -p TCP
foreach ($line in $ns) {
    if ($line -match ":8787\s" -and $line -match "LISTENING") {
        $parts = $line.Trim() -split "\s+"
        $stalePid = [int]$parts[-1]
        Write-Output ("Killing stale listener on 8787 PID=" + $stalePid)
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}

$proc = Start-Process -FilePath "bun" `
    -ArgumentList "src/index.ts" `
    -WorkingDirectory $serverDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

Write-Output ("Spawned PID=" + $proc.Id)
Write-Output ("Log out: " + $outLog)
Write-Output ("Log err: " + $errLog)

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $elapsed = $i * 0.5
            Write-Output ("Server ready after " + $elapsed + "s")
            Write-Output ("Body: " + $resp.Content)
            $ready = $true
            break
        }
    } catch {
        # not ready yet
    }
}

if (-not $ready) {
    Write-Output "TIMEOUT waiting for /api/health"
    Write-Output "--- stdout tail ---"
    if (Test-Path $outLog) { Get-Content $outLog -Tail 30 }
    Write-Output "--- stderr tail ---"
    if (Test-Path $errLog) { Get-Content $errLog -Tail 30 }
    exit 1
}
