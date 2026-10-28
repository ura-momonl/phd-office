# Shared by the tray and isolated lifecycle checks. No model calls here.
$dashboardRoot = Split-Path -Parent $PSScriptRoot
$dashboardPort = if ($env:PHD_DASHBOARD_PORT) { [int]$env:PHD_DASHBOARD_PORT } else { 18787 }
$dashboardUrl = "http://127.0.0.1:$dashboardPort"

function Get-DashboardHealth {
    try { Invoke-RestMethod "$dashboardUrl/health" -TimeoutSec 2 } catch { $null }
}
function Assert-DashboardIdle {
    # An unreadable queue must not lead to interrupting an agent.
    $queue = Get-Content -LiteralPath (Join-Path $dashboardRoot 'work/queue.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    # Chat-turn records live in work/turns.json once the queue is split; a running assistant turn is there.
    $items = @($queue.items)
    $turnsPath = Join-Path $dashboardRoot 'work/turns.json'
    if (Test-Path -LiteralPath $turnsPath) { $items += @((Get-Content -LiteralPath $turnsPath -Raw -Encoding UTF8 | ConvertFrom-Json).items) }
    if (@($items | Where-Object { $_.status -eq 'active' -and $_.actor -ne 'user' }).Count -gt 0) {
        throw '办公室还有助手任务正在运行。请等助手任务结束后再退出或重启；用户自己的任务不阻止重启。'
    }
    $health = Get-DashboardHealth
    if ($health.background_busy) { throw '办公室后台任务仍在运行，请稍后再重启。' }
}
function Get-DashboardProcess {
    $listeners = @(Get-NetTCPConnection -LocalPort $dashboardPort -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return $null }
    $ownerId = $listeners[0].OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
    if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch '(?i)(?:\s|[\\/]|\")automation[\\/]run\.mjs\"?\s+dashboard\s+serve(?:\s|$)') {
        throw "端口 $dashboardPort 被其他程序占用；不会终止它。"
    }
    $health = Get-DashboardHealth
    if (-not $health -or $health.app -ne 'phd-workflows' -or $health.version -ne 2) {
        throw '未能确认办公室后端的身份；不会终止该进程。'
    }
    Get-Process -Id $ownerId -ErrorAction Stop
}
function Stop-DashboardBackend {
    param([int]$ExpectedProcessId = 0)
    $backend = Get-DashboardProcess
    if ($ExpectedProcessId -and (-not $backend -or $backend.Id -ne $ExpectedProcessId)) {
        throw '后端进程身份已变化，取消此次重启。'
    }
    Assert-DashboardIdle
    if ($backend) {
        $backend.Kill()
        if (-not $backend.WaitForExit(5000)) { throw '后端未能在五秒内退出。' }
    }
}
function Start-DashboardBackend {
    param([switch]$CheckFreshness)
    $health = Get-DashboardHealth
    if ($health -and ($health.app -ne 'phd-workflows' -or $health.version -ne 2)) {
        throw "端口 $dashboardPort 被其他服务占用。"
    }
    if ($health -and $CheckFreshness) {
        if ($health.code) {
            if ($health.code.state -eq 'unknown') { Write-Warning '源文件读取不完整，无法确认后端版本；不自动重启。'; return $health }
            $stale = $health.code.state -eq 'stale'
        } else {
            # Transition for the currently-running legacy backend, which has no startup fingerprint.
            $sources = Get-ChildItem -Path (@('dashboard','agent','usage','mail-flow','work','weekly','projects','automation') | ForEach-Object { Join-Path $dashboardRoot $_ }) -Include *.mjs,*.js,*.html,*.css -Recurse -File
            $newest = ($sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
            $stale = (-not $health.started_at) -or ([datetimeoffset]::Parse($health.started_at).UtcDateTime -lt $newest)
        }
        if ($stale) {
            # Preserve freshness checks without interrupting active work.
            try { Stop-DashboardBackend; $health = $null }
            catch { Write-Warning $_.Exception.Message; return $health }
        }
    }
    if ($health) { return $health }
    if (@(Get-NetTCPConnection -LocalPort $dashboardPort -State Listen -ErrorAction SilentlyContinue).Count) {
        throw "端口 $dashboardPort 正在使用，但后端健康检查失败；未另启进程。"
    }
    $logs = Join-Path $dashboardRoot '.runtime/dashboard'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $backend = Start-Process -FilePath $node -ArgumentList @('automation/run.mjs','dashboard','serve') -WorkingDirectory $dashboardRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'output.log') -RedirectStandardError (Join-Path $logs 'error.log')
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $health = Get-DashboardHealth
        if ($health -and $health.app -eq 'phd-workflows' -and $health.version -eq 2) { return $health }
        if ($backend.HasExited) { throw "后端启动失败。详情见 $logs/error.log" }
    } while ((Get-Date) -lt $deadline)
    throw "后端启动超时。详情见 $logs/error.log"
}
