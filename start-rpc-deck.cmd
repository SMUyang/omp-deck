@echo off
setlocal

REM start-rpc-deck.cmd - Windows launcher wrapper.
REM Real logic lives in start-rpc-deck.ps1 to avoid CMD parsing issues.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-rpc-deck.ps1" %*
exit /b %ERRORLEVEL%
