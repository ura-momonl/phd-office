# Windows console input mode of the console this process is attached to (stdin is inherited from the TUI).
#   console-mode.ps1             -> prints the flags
#   console-mode.ps1 -Mouse      -> Quick Edit off (the classic console keeps the mouse for text selection while it is on),
#                                   mouse input + VT input on; prints was=<original flags>
#   console-mode.ps1 -QuickEdit  -> native text selection on, mouse reports off
#   console-mode.ps1 -Restore 0x... -> restore the original input flags on exit
param([switch]$Mouse, [switch]$QuickEdit, [string]$Restore)
Add-Type -Namespace W -Name K -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
$h = [W.K]::GetStdHandle(-10)
[uint32]$m = 0
if (-not [W.K]::GetConsoleMode($h, [ref]$m)) { 'unknown'; exit 1 }
$before = $m
# 0x80 ENABLE_EXTENDED_FLAGS is required for Quick Edit changes; 0x40 Quick Edit; 0x10 mouse input; 0x200 VT input
if ($Mouse) { [uint32]$new = ($m -bor 0x80 -bor 0x10 -bor 0x200) -band (-bnot 0x40) }
elseif ($QuickEdit) { [uint32]$new = ($m -bor 0x80 -bor 0x40) -band (-bnot 0x10) }
elseif ($Restore) { [uint32]$new = [Convert]::ToUInt32($Restore, 16) }
if ($Mouse -or $QuickEdit -or $Restore) {
  if (-not [W.K]::SetConsoleMode($h, $new)) { 'error: SetConsoleMode failed'; exit 1 }
  [void][W.K]::GetConsoleMode($h, [ref]$m)
}
'0x{0:X} vt={1} quickedit={2} was=0x{3:X}' -f $m, [int][bool]($m -band 0x200), [int][bool]($m -band 0x40), $before
