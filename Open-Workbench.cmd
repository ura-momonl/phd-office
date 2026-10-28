@echo off
rem The same window-less tray owns manual launches and Windows login startup.
start "" "%SystemRoot%\System32\wscript.exe" "%~dp0dashboard\Start-Dashboard.vbs" open
