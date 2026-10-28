param([int]$Port, [int]$ExpectedProcessId)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535 -or $ExpectedProcessId -le 0) { throw 'Invalid restart target.' }
$env:PHD_DASHBOARD_PORT = [string]$Port
. (Join-Path $PSScriptRoot 'Backend.ps1')
try {
    Stop-DashboardBackend -ExpectedProcessId $ExpectedProcessId
    [void](Start-DashboardBackend)
} catch {
    $logs = Join-Path $dashboardRoot '.runtime/dashboard'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $logs 'restart-error.log') -Encoding UTF8
    exit 1
}
