param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
$env:OPENCLAW_STATE_DIR = Join-Path $assistantRoot '.runtime\state'
$env:OPENCLAW_CONFIG_PATH = Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$entry = Join-Path $assistantRoot '.runtime\openclaw\node_modules\openclaw\openclaw.mjs'
$gatewayUrl = 'http://127.0.0.1:18789'
$running = $false
try {
    $response = Invoke-WebRequest -Uri "$gatewayUrl/healthz" -UseBasicParsing -TimeoutSec 2
    $running = $response.StatusCode -eq 200
} catch { }
if (-not $running) {
    $logs = Join-Path $assistantRoot '.runtime\logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $nodePath -ArgumentList @("`"$entry`"", 'gateway', 'run') -WorkingDirectory (Join-Path $assistantRoot 'workspace') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'gateway.stdout.log') -RedirectStandardError (Join-Path $logs 'gateway.stderr.log')
    Set-Content -LiteralPath (Join-Path $env:OPENCLAW_STATE_DIR 'launcher.pid') -Value $process.Id -Encoding ASCII
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if ($process.HasExited) { throw 'Gateway exited. See assistant/.runtime/logs/gateway.stderr.log.' }
        try {
            $response = Invoke-WebRequest -Uri "$gatewayUrl/readyz" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $running = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $running) { throw 'Gateway did not become ready. See assistant/.runtime/logs/.' }
}
Write-Output 'Assistant is running at http://127.0.0.1:18789/'
if ($OpenBrowser) {
    $config = Get-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH -Raw -Encoding UTF8 | ConvertFrom-Json
    $sessionQuery = [Uri]::EscapeDataString('agent:main:daily')
    Start-Process "${gatewayUrl}/chat?session=${sessionQuery}#token=$($config.gateway.auth.token)"
}
