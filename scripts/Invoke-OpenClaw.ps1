param([Parameter(ValueFromRemainingArguments = $true)][string[]]$OpenClawArguments)
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
$env:OPENCLAW_STATE_DIR = Join-Path $assistantRoot '.runtime\state'
$env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$env:npm_config_cache = Join-Path $assistantRoot '.runtime\npm-cache'
$openClawEntry = Join-Path $assistantRoot '.runtime\openclaw\node_modules\openclaw\openclaw.mjs'
if (-not (Test-Path -LiteralPath $openClawEntry)) { throw 'OpenClaw is not installed in this assistant directory.' }
& node $openClawEntry @OpenClawArguments
exit $LASTEXITCODE
