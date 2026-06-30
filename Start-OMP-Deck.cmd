@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-rpc-deck.ps1" %*
exit /b %ERRORLEVEL%
