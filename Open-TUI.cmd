@echo off
cd /d "%~dp0"
chcp 65001 >nul
node automation/run.mjs tui start
