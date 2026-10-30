# Exercise the production queue/lifetime without loading its desktop bootstrap.
$ErrorActionPreference='Stop'
if($env:PHD_ISOLATED_TESTS -ne '1') {throw 'Use scripts/run-tests.mjs'}
. (Join-Path $PSScriptRoot 'mouse-focus.ps1')
$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'mouse-download.ps1'),[ref]$null,[ref]$errors)
if($errors.Count){throw 'Worker parse failed'}
$definitions=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)|ForEach-Object {$_.Extent.Text})
# Load unmodified functions from a real file beside the worker, so PowerShell's
# automatic PSScriptRoot has its actual production value (Create() leaves it empty).
$functionsFile=Join-Path $PSScriptRoot 'mouse-queue.fixture.ps1'
[IO.File]::WriteAllText($functionsFile,($definitions -join "`n"),(New-Object Text.UTF8Encoding($true)))
. $functionsFile
$Directory=Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime/mouse-queue-fixture'
[IO.Directory]::CreateDirectory($Directory)|Out-Null
$Log=Join-Path $Directory 'attempts.jsonl';$StopFile=Join-Path $Directory 'STOP'
$script:StateFile=Join-Path $Directory 'progress.json';$script:Notify=$null
$script:State=@{status='starting';reason='';stage='checking_local';current_doi='';pid=$PID}
$RetryFailed=$false;$PaceSeconds=0;$script:TargetHandle=[IntPtr]42
$script:visits=@{};$script:init=0;$script:clock=[datetime]'2026-10-28T12:00:00Z'
$script:waits=0;$script:accessPolls=0
# A malformed non-tail record must wait, never erase prior successful entries.
Set-Content -LiteralPath $Log -Encoding UTF8 -Value @('{bad record','{"doi":"10.5555/done","status":"registered","detail":"done.pdf"}')
function Get-FocusNow {return $script:clock}
function Wait-Poll {
  $script:waits++;$script:clock=$script:clock.AddSeconds($(if($script:State.status -eq 'waiting_access'){4}else{31}))
  if($script:State.status -eq 'waiting_access') {
    if($script:visits['10.5555/access'] -ne 1){throw 'Access gate caused network-style article retry while blocked'}
    $script:accessPolls++
  }
  if($script:waits -eq 1) {Set-Content -LiteralPath $Log -Encoding UTF8 -Value '{"doi":"10.5555/done","status":"registered","detail":"done.pdf"}'}
}
function Initialize-MacroBrowser {
  $script:init++
  if($script:init -eq 1){throw 'MACRO_WAIT_BROWSER: fixture browser closed'}
}
function Test-BrowserWindow {return $true}
function Get-MacroAccessTitle {if($script:accessPolls -lt 2){return 'Verify you are human'};return 'Research article'}
function Invoke-MacroArticle([string]$doi,$downloaded) {
  $script:visits[$doi]++
  switch($doi) {
    '10.5555/rejected' {Assert-MacroLocalResult @{status='validation_failed';message='Requested DOI is not verified by a first-page identifier or title-bound publication DOI evidence; nothing registered'}}
    '10.5555/timeout' {throw 'Download did not land within 40 seconds'}
    '10.5555/shared' {if($script:visits[$doi] -eq 1){Assert-MacroLocalResult @{status='error';message='catalog temporarily locked'}}}
    '10.5555/focus' {if($script:visits[$doi] -eq 1){throw 'MACRO_FOCUS_RESUMED: same article'}}
    '10.5555/access' {if($script:visits[$doi] -eq 1){throw 'MACRO_ACCESS: human verification'}}
    '10.5555/modal' {if($script:visits[$doi] -eq 1){throw 'MACRO_ATTENTION: unknown save dialog'}}
  }
  return @{status='registered';detail=($doi+'.pdf')}
}
$dois=@('10.5555/done','10.5555/rejected','10.5555/timeout','10.5555/shared','10.5555/focus','10.5555/access','10.5555/modal','10.5555/next')
Invoke-MacroQueue $dois
if($script:State.status -ne 'complete' -or $script:State.failed -ne 2 -or $script:State.registered -ne 6 -or $script:State.completed -ne 8){throw 'Queue failed to finish after local and shared faults'}
if($script:visits['10.5555/rejected'] -ne 1 -or $script:visits['10.5555/timeout'] -ne 2 -or $script:visits.ContainsKey('10.5555/done')){throw 'Failed/successful paper retry boundary wrong'}
if($script:accessPolls -ne 2 -or $script:visits['10.5555/next'] -ne 1){throw 'Access wait did not resume to later paper'}
$before=($script:visits|ConvertTo-Json -Compress)
Invoke-MacroQueue $dois
if(($script:visits|ConvertTo-Json -Compress) -ne $before){throw 'Restart repeated terminal papers'}
# Frozen challenge: exactly ten seconds of observation, then skip and advance.
$script:AccessDeadline=$null;$script:AccessWaitReason=$null
$script:challengePolls=0;$script:challengeVisits=0;$script:laterVisits=0
function Get-MacroAccessTitle {return 'Verify you are human'}
function Wait-Poll {
  if($script:challengeVisits -ne 1){throw 'Blocked article was retried instead of observed'}
  $script:challengePolls++;$script:clock=$script:clock.AddSeconds(5)
}
function Invoke-MacroArticle([string]$doi,$downloaded) {
  if($doi -eq '10.5555/frozen-captcha') {$script:challengeVisits++;throw 'MACRO_ACCESS: human verification'}
  $script:laterVisits++;return @{status='registered';detail='later.pdf'}
}
Invoke-MacroQueue @('10.5555/frozen-captcha','10.5555/after-captcha')
if($script:challengePolls -ne 2 -or $script:challengeVisits -ne 1 -or $script:laterVisits -ne 1 -or (Get-MacroJournal $Log).terminal['10.5555/frozen-captcha'] -ne 'failed'){throw 'Ten-second verification skip did not advance queue'}
# STOP while waiting must leave the pending article resumable, not failed.
$script:stopMode=$true
function Invoke-MacroArticle([string]$doi,$downloaded) {
  if($script:stopMode){throw 'MACRO_WAIT: validator unavailable'}
  return @{status='registered';detail='resumed.pdf'}
}
function Wait-Poll {Set-Content -LiteralPath $StopFile -Value 'stop'}
Invoke-MacroWorker @('10.5555/pending')
if($script:State.status -ne 'stopped' -or (Get-MacroJournal $Log).terminal.ContainsKey('10.5555/pending')){throw 'STOP lost pending article or was ignored'}
Remove-Item -LiteralPath $StopFile
$script:stopMode=$false
Invoke-MacroWorker @('10.5555/pending')
if((Get-MacroJournal $Log).terminal['10.5555/pending'] -ne 'registered'){throw 'STOP/restart did not resume unfinished article'}
# An exception escaping the normal recovery handler still cannot end the worker.
$script:escapes=0;$script:waitErrors=0
function Invoke-MacroQueue($dois) {$script:escapes++;if($script:escapes -lt 3){throw 'unexpected recovery exception'}}
function Wait-MacroRecovery($reason,$status) {$script:waitErrors++;if($script:waitErrors -eq 1){throw 'recovery failed too'}}
Invoke-MacroWorker @('10.5555/pending')
if($script:escapes -ne 3){throw 'Unexpected runtime/recovery error terminated process loop'}
function Start-Process {throw 'fixture node launch failed'}
try {Invoke-MacroLocal '10.5555/pending';throw 'Validator launch failure ignored'} catch {if((Get-MacroFailureAction $_.Exception.Message 1) -ne 'wait'){throw}}
Write-Output 'PASS: rejected orphan, page timeout, catalog/parser recovery, browser wait, focus resume, verification no-input wait, modal wait, malformed journal, later-paper progress, restart idempotency, explicit STOP and last-resort worker recovery'
