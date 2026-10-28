$ErrorActionPreference = 'Stop'
if ($env:PHD_ISOLATED_TESTS -ne '1') { throw 'Use scripts/run-tests.mjs; this check writes only to its isolated copy.' }
. (Join-Path $PSScriptRoot 'Backend.ps1')
$queuePath = Join-Path $dashboardRoot 'work/queue.json'
$launcherPath = Join-Path $PSScriptRoot 'Start-Dashboard.ps1'
function Assert($ok, $message) { if (-not $ok) { throw $message } }
function Find-Tray {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like "*-File `"$launcherPath`"*" })
}
function Wait-Ready {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 300
        $health = Get-DashboardHealth
        if ($health -and $health.app -eq 'phd-workflows') { return }
    } while ((Get-Date) -lt $deadline)
    throw 'Isolated tray backend did not become ready.'
}
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OfficeTestWindows {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static bool AnyVisible(int[] processes) {
        bool found = false;
        EnumWindows((h,l) => { uint pid; GetWindowThreadProcessId(h,out pid);
            if (Array.IndexOf(processes,(int)pid)>=0 && IsWindowVisible(h)) found=true;
            return true; }, IntPtr.Zero);
        return found;
    }
}
'@
try {
    [void](Start-DashboardBackend)
    $first = (Get-DashboardProcess).Id
    [void](Start-DashboardBackend)
    Assert ((Get-DashboardProcess).Id -eq $first) 'Repeated launch created a second backend.'
    Write-Output 'PASS backend launch and repeated launch'

    $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $queue.items = @(@{id='tray-active-fixture';status='active';actor='claude'})
    $queue | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $queuePath -Encoding UTF8
    $blocked = $false
    try { Stop-DashboardBackend } catch { $blocked = $true }
    Assert $blocked 'Active task did not prevent shutdown.'
    Assert ((Get-DashboardProcess).Id -eq $first) 'Active backend was interrupted.'
    $source = Join-Path $dashboardRoot 'dashboard/server.mjs'
    $oldSource = [IO.File]::ReadAllBytes($source)
    [IO.File]::AppendAllText($source, "`n// isolated startup version fixture`n")
    Assert ((Get-DashboardHealth).code.state -eq 'stale') 'Changed backend code was not detected.'
    [void](Start-DashboardBackend -CheckFreshness)
    Assert ((Get-DashboardProcess).Id -eq $first) 'Freshness check interrupted active work.'
    Write-Output 'PASS active-task exit and freshness safeguards'

    $queue.items = @(@{id='user-experiment';status='active';actor='user'})
    $queue | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $queuePath -Encoding UTF8
    [void](Start-DashboardBackend -CheckFreshness)
    Assert ((Get-DashboardProcess).Id -ne $first) 'User experiment blocked stale backend refresh.'
    Assert ((Get-DashboardHealth).code.state -eq 'current') 'Restart did not load the new code version.'
    $after = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert ($after.items.Count -eq 1 -and $after.items[0].id -eq 'user-experiment' -and $after.items[0].status -eq 'active') 'Refresh changed the user experiment.'
    [IO.File]::WriteAllBytes($source, $oldSource)
    Stop-DashboardBackend
    Assert (-not (Get-DashboardHealth)) 'Exit left the backend running.'
    Stop-DashboardBackend
    Write-Output 'PASS user experiment permits refresh, stop, and repeated stop without task changes'

    $vbs = Join-Path $PSScriptRoot 'Start-Dashboard.vbs'
    Start-Process "$env:SystemRoot/System32/wscript.exe" -ArgumentList ('"'+$vbs+'"') -WindowStyle Hidden
    Wait-Ready
    Start-Sleep -Seconds 1
    # CIM scalar objects do not expose PowerShell's synthetic Count property.
    $trays = @(Find-Tray)
    Assert ($trays.Count -eq 1) 'Hidden VBS launch failed to create exactly one tray.'
    $trayId = $trays[0].ProcessId
    $backendId = (Get-DashboardProcess).Id
    foreach ($repeat in 1..2) {
        Start-Process "$env:SystemRoot/System32/wscript.exe" -ArgumentList ('"'+$vbs+'"') -WindowStyle Hidden
        Start-Sleep -Seconds 2
        Assert (@(Find-Tray).Count -eq 1) 'Repeated launch duplicated the tray.'
        Assert ((Get-DashboardProcess).Id -eq $backendId) 'Repeated tray launch duplicated the backend.'
    }
    Assert (-not [OfficeTestWindows]::AnyVisible(@([int]$trayId,[int]$backendId))) 'Background launch created a visible window.'
    Write-Output 'PASS hidden VBS launch, second and third launch, no visible app window'
    Write-Output 'LIFECYCLE PASSED'
} finally {
    if ($oldSource) { [IO.File]::WriteAllBytes($source, $oldSource) }
    $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $queue.items = @()
    $queue | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $queuePath -Encoding UTF8
    Stop-DashboardBackend
    foreach ($trayProcess in (Find-Tray)) { Stop-Process -Id $trayProcess.ProcessId -Force }
}
