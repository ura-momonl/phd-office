# Started hidden by the tray after the office backend is up. Updates the Claude Code and Codex CLIs the agents run on.
# No model calls. Skips when agents are working, when run less than 12 hours ago, or with PHD_NO_CLI_UPDATE=1.
$ErrorActionPreference = 'Continue'
if ($env:PHD_ISOLATED_TESTS -eq '1' -or $env:PHD_NO_CLI_UPDATE -eq '1') { exit 0 }
. (Join-Path $PSScriptRoot 'Backend.ps1')
$dir = Join-Path $dashboardRoot '.runtime/dashboard'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$logPath = Join-Path $dir 'cli-update.log'
$stampPath = Join-Path $dir 'cli-update.stamp'
function Log($text) { Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format s) $text" }

# Single run at a time (a second tray start must not race the first).
$mutex = New-Object System.Threading.Mutex($false, "Local\PhD-Workflows-cli-update-$dashboardPort")
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 0 }

function Run-Timed($file, $arguments, $seconds) {
    # Output goes to a temp file; returns exit code (-1 on timeout) and the text.
    $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null = $p.Handle  # cache the handle, otherwise ExitCode reads back empty in Windows PowerShell 5.1
        if (-not $p.WaitForExit($seconds * 1000)) {
            & taskkill.exe /PID $p.Id /T /F | Out-Null
            return @{ code = -1; text = 'timeout' }
        }
        $text = ((Get-Content -LiteralPath $out -Raw -Encoding UTF8), (Get-Content -LiteralPath $err -Raw -Encoding UTF8) -join "`n").Trim()
        return @{ code = $p.ExitCode; text = $text }
    } finally { Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue }
}
function Version-Of($file, $arguments) {
    $r = Run-Timed $file $arguments 30
    if ($r.code -eq 0 -and $r.text -match '(\d+\.\d+\.\d+\S*)') { return $Matches[1] }
    return $null
}

try {
    if (Test-Path -LiteralPath $stampPath) {
        $age = (Get-Date) - (Get-Item -LiteralPath $stampPath).LastWriteTime
        if ($age.TotalHours -lt 12) { exit 0 }
    }
    try { Assert-DashboardIdle } catch { Log "skipped: $($_.Exception.Message)"; exit 0 }
    $failed = $false

    # Claude Code: its own native updater decides whether anything is newer.
    $claude = (Get-Command claude.exe -ErrorAction SilentlyContinue).Source
    if ($claude) {
        $before = Version-Of $claude '--version'
        $r = Run-Timed $claude 'update' 300
        $after = Version-Of $claude '--version'
        if ($r.code -ne 0) { $failed = $true }
        Log "claude $before -> $after (exit $($r.code)) $($r.text -replace '\s+', ' ')"
    } else { Log 'claude not found'; $failed = $true }

    # Codex: global npm package. A running codex holds its files; npm would then leave a half-replaced install, so wait for the next start.
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    $codex = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source
    if ($npm -and $codex) {
        $package = Join-Path $env:APPDATA 'npm/node_modules/@openai/codex'
        $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$package*" })
        if ($running.Count) {
            Log "codex update skipped: $($running.Count) codex process(es) running"
            $failed = $true
        } else {
            $before = Version-Of $codex '--version'
            $latest = Run-Timed $npm 'view @openai/codex version' 60
            if ($latest.code -ne 0 -or $latest.text -notmatch '^\d+\.\d+\.\d+\S*$') {
                Log "codex latest version unavailable: $($latest.text -replace '\s+', ' ')"; $failed = $true
            } elseif ($latest.text -eq $before) {
                Log "codex $before is current"
            } else {
                $r = Run-Timed $npm 'install -g @openai/codex@latest' 600
                $after = Version-Of $codex '--version'
                if ($r.code -ne 0 -or $after -ne $latest.text) { $failed = $true }
                Log "codex $before -> $after (target $($latest.text), exit $($r.code)) $($r.text -replace '\s+', ' ')"
            }
        }
    } else { Log 'npm or codex not found'; $failed = $true }

    # Failures (offline, busy) are retried on the next start rather than waiting 12 hours.
    if (-not $failed) { Set-Content -LiteralPath $stampPath -Value (Get-Date -Format o) -Encoding ASCII }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
