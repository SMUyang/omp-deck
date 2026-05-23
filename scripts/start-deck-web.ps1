# Start the omp-deck web dev server (Vite) on the prod-tree port 5173.
# Per CONTRIBUTING.md: prod tree = 5173, dev worktree = 5273.
# ASCII only per PS 5.1 .ps1 parse rules.
$ErrorActionPreference = "Stop"

$webDir = "C:\Users\bryan\enclave\omp-deck\apps\web"
$logDir = "C:\Users\bryan\enclave\omp-deck\.logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$outLog = Join-Path $logDir "dev-web-$ts.out.log"
$errLog = Join-Path $logDir "dev-web-$ts.err.log"

# Kill anyone holding 5173
$ns = & netstat -aon -p TCP
foreach ($line in $ns) {
    if ($line -match ":5173\s" -and $line -match "LISTENING") {
        $parts = $line.Trim() -split "\s+"
        $stalePid = [int]$parts[-1]
        Write-Output ("Killing stale listener on 5173 PID=" + $stalePid)
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}

# Use bun to run vite (matches the existing dev:web script in apps/web/package.json)
$proc = Start-Process -FilePath "bun" `
    -ArgumentList "run", "vite" `
    -WorkingDirectory $webDir `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru

Write-Output ("Spawned PID=" + $proc.Id)
Write-Output ("Log out: " + $outLog)
Write-Output ("Log err: " + $errLog)

# Vite cold-start needs more than the server's 30s budget on first hit.
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $elapsed = $i * 0.5
            Write-Output ("Vite ready after " + $elapsed + "s at http://127.0.0.1:5173/")
            $ready = $true
            break
        }
    } catch {
        # not ready
    }
}

if (-not $ready) {
    Write-Output "TIMEOUT waiting for Vite on 5173"
    Write-Output "--- stdout tail ---"
    if (Test-Path $outLog) { Get-Content $outLog -Tail 40 }
    Write-Output "--- stderr tail ---"
    if (Test-Path $errLog) { Get-Content $errLog -Tail 40 }
    exit 1
}
