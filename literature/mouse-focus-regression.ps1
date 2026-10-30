# Runs only in the sanitised test copy. No desktop input, windows, or network.
$ErrorActionPreference='Stop'
if($env:PHD_ISOLATED_TESTS -ne '1') {throw 'Use scripts/run-tests.mjs'}
$Directory=Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime/mouse-fixture'
[IO.Directory]::CreateDirectory($Directory)|Out-Null
$StopFile=Join-Path $Directory 'STOP'
$script:StateFile=Join-Path $Directory 'progress.json'
$script:Notify=$null;$script:PauseTotalMs=0
$script:State=@{status='running';reason='';stage='finding_pdf';current_doi='10.5555/pending';pid=$PID}
$script:SaveDialogHandle=[IntPtr]::Zero;$script:TargetHandle=[IntPtr]42
$script:events=New-Object 'System.Collections.Generic.List[string]'
. (Join-Path $PSScriptRoot 'mouse-focus.ps1')
function Write-Result($doi,$status,$detail) {$script:events.Add($status)}
function Test-BrowserWindow {return $true}
$script:polls=0
function Get-ForegroundContext {
  if($script:polls -lt 3) {return @{handle=88;owner=88;title='python.exe - Application Error'}}
  return @{handle=42;owner=42;title='Download Edge'}
}
function Wait-Poll {
  $s=Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($s.status -ne 'waiting_focus' -or $s.foreground.title -ne 'python.exe - Application Error') {throw 'focus wait not persisted or cause lost'}
  $script:polls++
}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Expected known-page recovery after wait'}
catch {if($_.Exception.Message -notmatch '^MACRO_FOCUS_RESUMED:') {throw}}
if($script:polls -ne 3 -or $script:State.status -ne 'running' -or $script:events -notcontains 'focus_restored') {throw 'Focus did not resume the same article'}
if($script:State.current_doi -ne '10.5555/pending') {throw 'Focus wait advanced the queue'}
# STOP is responsive even while paused; it is not swallowed as a retry.
$script:polls=0
function Wait-Poll {Set-Content -LiteralPath $StopFile -Value 'stop';$script:polls++}
try {Assert-EdgeForeground ([IntPtr]42);throw 'STOP ignored'} catch {if($_.Exception.Message -notmatch '^MACRO_STOP:') {throw}}
Remove-Item -LiteralPath $StopFile
# Accelerated clock exercises the exact 180-second boundary, without desktop input.
$script:base=[datetime]'2026-10-28T12:00:00Z';$script:seconds=0;$script:returns=0;$script:returned=$false
function Get-FocusNow {return $script:base.AddSeconds($script:seconds)}
function Get-ForegroundContext {
  if($script:returned) {return @{handle=42;owner=42;title='Download Edge'}}
  return @{handle=88;owner=88;title=('Other window '+$script:seconds)}
}
function Restore-DownloadWindow {
  Test-MacroStop
  if($script:seconds -lt 180) {throw 'Focus reclaimed before three minutes'}
  $script:returns++;$script:returned=$true;return $true
}
function Wait-Poll {
  if($script:seconds -eq 0) {$script:seconds=179}
  elseif($script:seconds -eq 179) {if($script:returns -ne 0){throw 'Returned before deadline'};$script:seconds=180}
  else {throw 'Focus deadline was reset by changing foreground windows'}
}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Expected recovery after automatic focus return'} catch {if($_.Exception.Message -notmatch '^MACRO_FOCUS_RESUMED:'){throw}}
if($script:returns -ne 1 -or $script:events -notcontains 'focus_return_succeeded') {throw 'Automatic return not confirmed'}
# Manual return before deadline cancels the delayed activation.
$script:seconds=0;$script:returns=0;$script:returned=$false
function Wait-Poll {$script:seconds=60;$script:returned=$true}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Expected manual recovery'} catch {if($_.Exception.Message -notmatch '^MACRO_FOCUS_RESUMED:'){throw}}
if($script:returns -ne 0) {throw 'Delayed activation survived manual return'}
# STOP at the deadline wins over activation.
$script:seconds=0;$script:returned=$false
function Wait-Poll {$script:seconds=180;Set-Content -LiteralPath $StopFile -Value 'stop'}
try {Assert-EdgeForeground ([IntPtr]42);throw 'STOP ignored at deadline'} catch {if($_.Exception.Message -notmatch '^MACRO_STOP:'){throw}}
if($script:returns -ne 0) {throw 'Activated after STOP'}
Remove-Item -LiteralPath $StopFile
# A rejected foreground activation waits another full interval, rather than hammering focus.
$script:seconds=0;$script:returns=0;$script:returned=$false
function Restore-DownloadWindow {$script:returns++;if($script:returns -eq 2){$script:returned=$true;return $true};return $false}
function Wait-Poll {
  if($script:seconds -eq 0){$script:seconds=180}
  elseif($script:seconds -eq 180){$script:seconds=359}
  elseif($script:seconds -eq 359){if($script:returns -ne 1){throw 'Activation retry too soon'};$script:seconds=360}
  else {throw 'Activation did not retry at the next interval'}
}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Expected recovery on second activation'} catch {if($_.Exception.Message -notmatch '^MACRO_FOCUS_RESUMED:'){throw}}
if($script:returns -ne 2) {throw 'Activation retry count wrong'}
if((Get-MacroFailureAction 'MACRO_FOCUS_RESUMED: known page' 99) -ne 'resume') {throw 'Focus loss consumes retries'}
if((Get-MacroFailureAction 'button did not appear' 1) -ne 'retry') {throw 'Transient page failure not retried'}
if((Get-MacroFailureAction 'download timeout' 2) -ne 'fail') {throw 'Per-paper failure is unbounded'}
if((Get-MacroFailureAction 'MACRO_ACCESS: access denied' 1) -ne 'access') {throw 'Access check retried'}
if((Get-MacroFailureAction 'MACRO_ATTENTION: save dialog' 1) -ne 'wait') {throw 'Shared attention terminated worker'}
if((Get-MacroFailureAction 'MACRO_PAPER: identity mismatch' 1) -ne 'fail') {throw 'Rejected paper retried'}
if((Get-MacroFailureAction 'MACRO_STOP: user' 1) -ne 'stop') {throw 'Stop retried'}
# Real journal files: success skipped, pending retried, already-downloaded file available for local recovery.
$journal=Join-Path $Directory 'attempts.jsonl'
@(
  @{doi='10.5555/done';status='registered';detail='done.pdf'},
  @{doi='10.5555/bad';status='failed';detail='timeout'},
  @{doi='10.5555/pending';status='downloaded';detail='pending.pdf'},
  @{doi='10.5555/pending';status='starting';detail='open'}
) | ForEach-Object {$_ | ConvertTo-Json -Compress} | Set-Content -LiteralPath $journal -Encoding UTF8
$j=Get-MacroJournal $journal
if($j.terminal.Count -ne 2 -or $j.terminal['10.5555/done'] -ne 'registered' -or $j.terminal.ContainsKey('10.5555/pending') -or $j.downloaded['10.5555/pending'] -ne 'pending.pdf') {throw 'Restart journal cursor wrong'}
Add-Content -LiteralPath $journal -Value '{"doi":"partial' -Encoding UTF8
$j=Get-MacroJournal $journal
if($j.terminal.Count -ne 2) {throw 'Truncated tail damaged completed progress'}
if((Get-MacroJournal $journal).terminal.Count -ne 2) {throw 'Repaired journal cannot be resumed a second time'}
# An owned but unrecognised modal is not permission to type into its fields.
$script:returned=$false;$script:seconds=0
function Get-ForegroundContext {return @{handle=88;owner=42;title='Unknown owned dialog'}}
function Wait-Poll {Set-Content -LiteralPath $StopFile -Value 'stop'}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Unknown owned dialog accepted as browser'} catch {if($_.Exception.Message -notmatch '^MACRO_STOP:'){throw}}
Remove-Item -LiteralPath $StopFile
# Browser disappearance is recoverable by the worker, never treated as a paper failure.
function Test-BrowserWindow {return $false}
try {Assert-EdgeForeground ([IntPtr]42);throw 'Closed browser accepted'} catch {if((Get-MacroFailureAction $_.Exception.Message 1) -ne 'browser'){throw}}
# Actual shell identity observed on this host; a matching title alone is not enough.
$script:quick=@{handle=88;owner=88;title='Quick Settings';class_name='ControlCenterWindow';process_name='ShellHost';process_path=(Join-Path $env:WINDIR 'System32\ShellHost.exe')}
$script:quickForeground=$script:quick;$script:dismissals=0
function Get-ForegroundContext {return $script:quickForeground}
function Wait-Poll {}
function Send-QuickSettingsDismiss {$script:dismissals++;$script:quickForeground=@{handle=42;title='Download Edge';class_name='Chrome_WidgetWin_1';process_name='msedge'}}
if(-not (Dismiss-QuickSettings $script:quick) -or $script:dismissals -ne 1 -or $script:events -notcontains 'quick_settings_dismissed'){throw 'Known control centre did not dismiss'}
foreach($other in @(
  @{handle=88;title='Quick Settings';class_name='Chrome_WidgetWin_1';process_name='msedge'},
  @{handle=88;title='Quick Settings';class_name='ControlCenterWindow';process_name='OtherApp';process_path=$script:quick.process_path},
  @{handle=88;class_name='ControlCenterWindow';process_name='ShellHost';process_path='D:\unrelated\ShellHost.exe'}
)) {if(Dismiss-QuickSettings $other){throw 'Unrelated foreground app dismissed'}}
if($script:dismissals -ne 1){throw 'Dismissal leaked outside known shell flyout'}
# Foreground can change between identification and input. Do not toggle Win+A then.
if(Dismiss-QuickSettings $script:quick){throw 'Stale shell context acted on a different foreground window'}
Set-Content -LiteralPath $StopFile -Value 'stop'
try {Dismiss-QuickSettings $script:quick;throw 'STOP ignored before shell dismissal'} catch {if($_.Exception.Message -notmatch '^MACRO_STOP:'){throw}}
Remove-Item -LiteralPath $StopFile
if($script:dismissals -ne 1){throw 'Shell shortcut sent after STOP'}
# An ineffective shortcut produces explicit failure, not a claimed recovery.
$script:quickForeground=$script:quick
function Send-QuickSettingsDismiss {$script:dismissals++}
if(Dismiss-QuickSettings $script:quick){throw 'Failed shell dismissal reported success'}
if($script:events -notcontains 'quick_settings_dismiss_failed'){throw 'Shell dismissal failure not visible'}
Write-Output 'PASS: focus pause/resume, 180-second automatic return, manual cancellation, STOP priority, bounded activation retries, per-paper recovery and journal restart'
