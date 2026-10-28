param([string]$Trigger = 'none', [int]$Seconds = 10, [string]$TaskName = 'PhD-Workflows-Mail-ReadOnly', [string]$Cmd = '')
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WinProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Snapshot() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(h.ToInt64() + "|" + c + "|" + t + "|" + pid);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$known = @{}
foreach ($w in [WinProbe]::Snapshot()) { $known[$w.Split('|')[0]] = $true }
$seen = @{}
switch ($Trigger) {
  'notepad' { Start-Process notepad.exe | Out-Null }
  'task'    { Start-ScheduledTask -TaskName $TaskName }
  'cmd'     { Start-Process conhost.exe -ArgumentList ('--headless ' + $Cmd) -WorkingDirectory 'D:\Main\assistant' -WindowStyle Hidden | Out-Null }
  default   { }
}
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  foreach ($w in [WinProbe]::Snapshot()) {
    $p = $w.Split('|')
    if (-not $known.ContainsKey($p[0]) -and -not $seen.ContainsKey($p[0])) {
      $name = try { (Get-Process -Id ([int]$p[3]) -ErrorAction Stop).ProcessName } catch { 'exited' }
      $seen[$p[0]] = "{0} | class={1} | title='{2}' | process={3}" -f (Get-Date).ToString('HH:mm:ss.fff'), $p[1], $p[2], $name
    }
  }
  Start-Sleep -Milliseconds 15
}
if ($Trigger -eq 'notepad') { Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force }
"trigger=$Trigger  new visible windows seen: $($seen.Count)"
$seen.Values
