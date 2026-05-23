@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-deck.ps1"
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo omp-deck failed to start. Check the output above and the .logs folder.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo omp-deck is running. You can close this window.
pause
