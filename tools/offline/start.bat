@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
    "runtime\node.exe" server.mjs %*
) else (
    node server.mjs %*
)
pause
