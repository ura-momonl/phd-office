$ErrorActionPreference = 'Stop'
$discordRoot = Split-Path -Parent $PSScriptRoot
$discordEntry = Join-Path $discordRoot 'automation/run.mjs'
$discordLock = Join-Path $discordRoot '.runtime/remote/bridge.lock'

function Get-DiscordBridge {
    if (-not (Test-Path -LiteralPath $discordLock)) { return $null }
    $bridgeId = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $discordLock -Raw).Trim(), [ref]$bridgeId)) { throw 'Invalid Discord bridge lock; no process was stopped.' }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$bridgeId"
    # No process owns this PID (e.g. reboot after an unclean exit): the lock is dead, clear it so login startup self-heals.
    # A live PID reused by another program still hits the identity check below and is never touched.
    if (-not $owner) { Remove-Item -LiteralPath $discordLock; return $null }
    if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch [regex]::Escape($discordEntry) -or $owner.CommandLine -notmatch '\sremote\s+discord(?:\s|$)') {
        throw 'Discord lock process identity is not this absolute bridge entry; no process was stopped.'
    }
    Get-Process -Id $bridgeId -ErrorAction Stop
}
function Start-DiscordBridge {
    $identity = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($discordRoot.ToLowerInvariant())).Replace('/', '_')
    $mutex = New-Object System.Threading.Mutex($false, "Local\PhD-Discord-Launcher-$identity")
    try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { $mutex.Dispose(); return }
    try {
        $running = Get-DiscordBridge
        if ($running) { Write-Output "Discord bridge already running: $($running.Id)"; return }
        $envFile = Join-Path $discordRoot '.runtime/discord.env'
        if (-not (Test-Path -LiteralPath $envFile)) { throw 'Fill .runtime/discord.env first.' }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $logDir = Join-Path $discordRoot '.runtime/remote'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        $arguments = @("--env-file-if-exists=`"$envFile`"", "`"$discordEntry`"", 'remote', 'discord')
        $bridge = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $discordRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'output.log') -RedirectStandardError (Join-Path $logDir 'error.log')
        $deadline = (Get-Date).AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            if ($bridge.HasExited) { throw 'Discord bridge exited. See .runtime/remote/error.log; it was not retried.' }
            if ((Test-Path -LiteralPath $discordLock) -and (Get-Content -LiteralPath $discordLock -Raw).Trim() -eq [string]$bridge.Id -and (Get-Content -LiteralPath (Join-Path $logDir 'output.log') -Raw) -match 'Discord commands ready\.') {
                Write-Output "Discord background bridge ready: $($bridge.Id)"; return
            }
        } while ((Get-Date) -lt $deadline)
        throw 'Discord readiness was not confirmed within 20 seconds. Inspect logs; do not blindly start another instance.'
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
function Stop-DiscordBridge {
    $bridge = Get-DiscordBridge
    if (-not $bridge) { Write-Output 'Discord bridge is not running.'; return }
    $bridge.Kill()
    if (-not $bridge.WaitForExit(5000)) { throw 'Discord bridge did not exit; lock retained.' }
    # Node on Windows may be forcibly terminated. Clear only its exact lock AFTER it exited.
    if ((Test-Path -LiteralPath $discordLock) -and (Get-Content -LiteralPath $discordLock -Raw).Trim() -eq [string]$bridge.Id) { Remove-Item -LiteralPath $discordLock }
    Write-Output 'Discord bridge stopped; notification ledger retained.'
}
