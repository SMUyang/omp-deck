@echo off
setlocal

REM start-rpc-deck.cmd — Windows launcher for omp-deck with external omp RPC backend.
REM
REM Usage:
REM   start-rpc-deck.cmd              foreground (Ctrl+C to stop)
REM   start-rpc-deck.cmd start        background, opens browser
REM   start-rpc-deck.cmd stop         stop background instance
REM   start-rpc-deck.cmd status       check if running

cd /d "%~dp0"

set LOG_DIR=.logs
set PID_FILE=%LOG_DIR%\rpc-deck.pid
set LOG_FILE=%LOG_DIR%\rpc-deck.log

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM ── Resolve omp binary to absolute path ────────────────────────────
if defined OMP_DECK_OMP_BIN (
  set OMP_BIN=%OMP_DECK_OMP_BIN%
  goto :bin_resolved
)

where omp >nul 2>&1
if %ERRORLEVEL% neq 0 (
  echo [ERROR] 'omp' not found on PATH.
  echo   Install it with: bun add -g @oh-my-pi/pi-coding-agent
  echo   Or set OMP_DECK_OMP_BIN=C:\path\to\omp explicitly.
  exit /b 1
)
for /f "delims=" %%i in ('where omp') do set OMP_BIN=%%i
:bin_resolved

REM ── Set defaults ───────────────────────────────────────────────────
if not defined OMP_DECK_PORT set OMP_DECK_PORT=8787
if not defined OMP_DECK_WEB_PORT set OMP_DECK_WEB_PORT=5173
set OMP_DECK_AGENT_BACKEND=rpc
set NO_COLOR=1

echo +-- RPC Backend Configuration ------------------------+
echo ^|  omp binary : %OMP_BIN%
echo ^|  server port: %OMP_DECK_PORT%
echo ^|  web port   : %OMP_DECK_WEB_PORT%
echo ^|  backend    : %OMP_DECK_AGENT_BACKEND%
echo +------------------------------------------------------+

if "%1"=="start" goto :start
if "%1"=="stop" goto :stop
if "%1"=="status" goto :status
if "%1"=="foreground" goto :foreground
if "%1"=="" goto :foreground

echo Usage: %0 [start^|stop^|status^|foreground]
echo.
echo   (no arg)     foreground run, same as 'bun run dev' with RPC backend
echo   start        background, writes PID + logs to %LOG_DIR%\, opens browser
echo   stop         terminate the background run started via 'start'
echo   status       check whether a background run is alive
exit /b 1

:start
if exist "%PID_FILE%" (
  for /f %%p in (%PID_FILE%) do (
    tasklist /fi "PID eq %%p" 2>nul | find "%%p" >nul
    if !ERRORLEVEL! equ 0 (
      echo omp-deck (RPC) already running (PID %%p). Logs: %LOG_FILE%
      exit /b 0
    )
  )
)
start /b bun run dev > "%LOG_FILE%" 2>&1
REM Get the PID of the spawned bun process
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq bun.exe" /fo list ^| find "PID:"') do (
  echo %%p> "%PID_FILE%"
  echo omp-deck (RPC) started. Logs: %LOG_FILE%
  goto :open_browser
)
:open_browser
timeout /t 5 /nobreak >nul
start http://127.0.0.1:%OMP_DECK_WEB_PORT%
exit /b 0

:stop
if exist "%PID_FILE%" (
  for /f %%p in (%PID_FILE%) do (
    taskkill /pid %%p /f 2>nul
    echo stopped omp-deck (RPC) (PID %%p)
  )
  del "%PID_FILE%" 2>nul
) else (
  echo no PID file at %PID_FILE% -- nothing to stop
)
exit /b 0

:status
if exist "%PID_FILE%" (
  for /f %%p in (%PID_FILE%) do (
    tasklist /fi "PID eq %%p" 2>nul | find "%%p" >nul
    if !ERRORLEVEL! equ 0 (
      echo running (PID %%p). Logs: %LOG_FILE%
      exit /b 0
    )
  )
)
echo not running
exit /b 0

:foreground
bun run dev
