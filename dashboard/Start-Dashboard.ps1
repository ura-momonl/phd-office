param([switch]$OpenDashboard)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Backend.ps1')

# One tray owns the lifecycle; later launches only ask it to open the office.
$identity = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dashboardRoot.ToLowerInvariant())).Replace('/', '_')
$name = "Local\PhD-Workflows-$identity-$dashboardPort"
$created = $false
$mutex = New-Object System.Threading.Mutex($false, $name)
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
$openRequest = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "$name-open", [ref]$created)
if (-not $owned) {
    if ($OpenDashboard) { [void]$openRequest.Set() }
    $openRequest.Dispose(); $mutex.Dispose()
    exit
}

# Opt out of Windows bitmap-stretching before creating any tray/menu windows.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OfficeIconNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@
[void][OfficeIconNative]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'TrayMenu.cs') -ReferencedAssemblies System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$context = New-Object System.Windows.Forms.ApplicationContext
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object OfficeTrayMenu
$menuFont = New-Object System.Drawing.Font('Segoe UI', 9)
$menu.Font = $menuFont
$menu.ShowImageMargin = $false
$menu.Padding = New-Object System.Windows.Forms.Padding(6, 6, 6, 6)
$status = $menu.Items.Add('办公室：正在启动…'); $status.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$open = $menu.Items.Add('打开办公室')
$logs = $menu.Items.Add('查看后台日志')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('退出办公室（停止后端）')
foreach ($item in $menu.Items) {
    if ($item -is [System.Windows.Forms.ToolStripMenuItem]) {
        $item.Padding = New-Object System.Windows.Forms.Padding(10, 5, 10, 5)
    }
}
# Reserve four extra pixels of height; TrayMenu.cs shifts the status text down.
$status.Padding = New-Object System.Windows.Forms.Padding(10, 9, 10, 5)
$tray.ContextMenuStrip = $menu

# Small native green icon, no new bitmap-generation or runtime dependency.
$bitmap = New-Object System.Drawing.Bitmap(32, 32)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(16, 163, 127))
# Rounded-square silhouette stays legible at Windows' small tray sizes.
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc(2, 2, 14, 14, 180, 90)
$tile.AddArc(16, 2, 14, 14, 270, 90)
$tile.AddArc(16, 16, 14, 14, 0, 90)
$tile.AddArc(2, 16, 14, 14, 90, 90)
$tile.CloseFigure()
$graphics.FillPath($brush, $tile)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3)
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$frame = New-Object System.Drawing.Drawing2D.GraphicsPath
$frame.AddArc(10, 10, 6, 6, 180, 90)
$frame.AddArc(16, 10, 6, 6, 270, 90)
$frame.AddArc(16, 16, 6, 6, 0, 90)
$frame.AddArc(10, 16, 6, 6, 90, 90)
$frame.CloseFigure()
$graphics.DrawPath($pen, $frame)
$handle = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($handle).Clone()
[void][OfficeIconNative]::DestroyIcon($handle)
$graphics.Dispose(); $brush.Dispose(); $pen.Dispose(); $tile.Dispose(); $frame.Dispose(); $bitmap.Dispose()
$tray.Icon = $icon
$tray.Text = '课题办公室：正在启动'
$tray.Visible = $true

function Update-OfficeStatus {
    $health = Get-DashboardHealth
    $ready = $health -and $health.app -eq 'phd-workflows' -and $health.version -eq 2
    $label = if ($ready) { '运行中' } else { '后端未运行 / 不可用' }
    if ($ready -and $health.code.state -eq 'stale') { $label = '运行中 · 代码更新待重启' }
    elseif ($ready -and (-not $health.code -or $health.code.state -eq 'unknown')) { $label = '运行中 · 版本待确认' }
    $status.Text = "办公室：$label"
    $tray.Text = "课题办公室：$label"
}
function Show-OfficeError($message) {
    $dir = Join-Path $dashboardRoot '.runtime/dashboard'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'tray.log') -Encoding UTF8 -Value "$(Get-Date -Format o) $message"
    $tray.ShowBalloonTip(5000, '课题办公室', $message, [System.Windows.Forms.ToolTipIcon]::Warning)
}
function Open-Office {
    try { [void](Start-DashboardBackend -CheckFreshness); Start-Process $dashboardUrl; Update-OfficeStatus }
    catch { Show-OfficeError $_.Exception.Message }
}
$open.Add_Click({ Open-Office })
$tray.Add_DoubleClick({ Open-Office })
$logs.Add_Click({ Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $dashboardRoot '.runtime/dashboard') + '"') })
$quit.Add_Click({
    try { Stop-DashboardBackend; $context.ExitThread() }
    catch { [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '暂时不能退出办公室') }
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$script:beat = 0
$timer.Add_Tick({
    if ($openRequest.WaitOne(0)) { Open-Office }
    if ((++$script:beat % 10) -eq 0) { Update-OfficeStatus }
})
try {
    try { [void](Start-DashboardBackend); Update-OfficeStatus } catch { Show-OfficeError $_.Exception.Message; Update-OfficeStatus }
    # Discord bridge starts with the office once the backend answers. Its own launcher is hidden, single-instance
    # and returns at once (readiness wait stays out of this UI thread); skipped when Discord is not configured.
    if ($status.Text -match '运行中' -and (Test-Path -LiteralPath (Join-Path $dashboardRoot '.runtime/discord.env'))) {
        try { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $dashboardRoot 'remote\Start-Discord.vbs') + '"') -WindowStyle Hidden }
        catch { Show-OfficeError ('Discord 桥接器未能启动：' + $_.Exception.Message) }
    }
    # Claude Code / Codex CLI self-update: hidden, detached, throttled and idle-only (see Update-Clis.ps1); never blocks the tray.
    if ($status.Text -match '运行中') {
        try { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + (Join-Path $PSScriptRoot 'Update-Clis.ps1') + '"')) -WindowStyle Hidden }
        catch { Show-OfficeError ('CLI 自动更新未能启动：' + $_.Exception.Message) }
    }
    if ($OpenDashboard) { Open-Office }
    $timer.Start()
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop(); $timer.Dispose()
    $tray.Visible = $false; $tray.Dispose(); $menu.Dispose(); $icon.Dispose(); $context.Dispose()
    $menuFont.Dispose()
    $openRequest.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose()
}
