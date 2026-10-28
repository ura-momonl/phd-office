@echo off
"D:\Program Files\nodejs\node.exe" "%~dp0automation\run.mjs" mail status
start "" "%~dp0.runtime\mail-flow\today.md"
