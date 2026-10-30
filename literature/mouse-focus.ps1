# Shared desktop focus/wait boundary, also exercised by the isolated regression tests.
function Save-MacroState([string]$status, [string]$reason = '') {
  $changed=$script:State.status -ne $status
  $script:State.status=$status
  $script:State.reason=$reason
  $script:State.updated_at=(Get-Date).ToUniversalTime().ToString('o')
  $temp=Join-Path $Directory ('progress.'+$PID+'.tmp')
  $script:State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
  # Replace instead of truncate: status readers never see a half-written JSON document.
  if(Test-Path -LiteralPath $script:StateFile) {[IO.File]::Replace($temp,$script:StateFile,[NullString]::Value)}
  else {[IO.File]::Move($temp,$script:StateFile)}
  if($script:Notify) { try {
    $script:Notify.Text=('Paper macro: '+$status+' '+$script:State.registered+'/'+$script:State.total).Substring(0,[Math]::Min(63,('Paper macro: '+$status+' '+$script:State.registered+'/'+$script:State.total).Length))
    if($changed -and $status -in @('waiting_focus','waiting_browser','waiting_error','waiting_access','needs_attention','stopped','complete')) {
      $script:Notify.BalloonTipTitle='Paper macro: '+$status
      $script:Notify.BalloonTipText=$reason
      $script:Notify.ShowBalloonTip(10000)
    }
    [Windows.Forms.Application]::DoEvents()
  } catch {Write-Host ('Tray notification unavailable: '+$_.Exception.Message)} }
}
function Get-ForegroundContext {
  $fg=[W32]::GetForegroundWindow()
  $root=[W32]::GetAncestor($fg,3)
  $title=New-Object Text.StringBuilder 512
  $class=New-Object Text.StringBuilder 256
  $windowPid=[uint32]0;$name='';$file=''
  [W32]::GetWindowText($fg,$title,$title.Capacity) | Out-Null
  [W32]::GetClassName($fg,$class,$class.Capacity) | Out-Null
  [W32]::GetWindowThreadProcessId($fg,[ref]$windowPid) | Out-Null
  if($windowPid) {try {$process=Get-Process -Id $windowPid -ErrorAction Stop;$name=$process.ProcessName;$file=$process.Path} catch {}}
  return @{handle=$fg.ToInt64();owner=$root.ToInt64();title=$title.ToString();class_name=$class.ToString();process_name=$name;process_path=$file}
}
function Wait-Poll {Start-Sleep -Milliseconds 500}
function Get-FocusNow {return Get-Date}
function Test-MacroStop {
  if(Test-Path -LiteralPath $StopFile) {throw 'MACRO_STOP: requested; no further desktop input'}
}
function Test-BrowserWindow {return [W32]::IsWindow($script:TargetHandle)}
function Test-QuickSettingsContext($context) {
  if($context.class_name -ne 'ControlCenterWindow') {return $false}
  return (($context.process_name -eq 'ShellHost' -and $context.process_path -eq (Join-Path $env:WINDIR 'System32\ShellHost.exe')) -or
    ($context.process_name -eq 'ShellExperienceHost' -and $context.process_path -like (Join-Path $env:WINDIR 'SystemApps\ShellExperienceHost_*\ShellExperienceHost.exe')))
}
function Send-QuickSettingsDismiss {
  # Win+A closes the whole control centre, including Wi-Fi/Bluetooth subpages.
  # Never click a network toggle, connect button, or a guessed screen coordinate.
  try {
    [W32]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
    [W32]::keybd_event(0x41,0,0,[UIntPtr]::Zero)
  } finally {
    [W32]::keybd_event(0x41,0,2,[UIntPtr]::Zero)
    [W32]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)
  }
}
function Dismiss-QuickSettings($expected) {
  Test-MacroStop
  if(-not (Test-QuickSettingsContext $expected)) {return $false}
  $current=Get-ForegroundContext
  if($current.handle -ne $expected.handle -or -not (Test-QuickSettingsContext $current)) {return $false}
  Test-MacroStop
  Write-Result $script:State.current_doi 'quick_settings_dismiss_requested' ($current | ConvertTo-Json -Compress)
  Send-QuickSettingsDismiss
  for($i=0;$i -lt 4;$i++) {
    Test-MacroStop
    Wait-Poll
    $current=Get-ForegroundContext
    if(-not (Test-QuickSettingsContext $current)) {
      Write-Result $script:State.current_doi 'quick_settings_dismissed' 'control centre closed; no network setting changed'
      return $true
    }
  }
  Write-Result $script:State.current_doi 'quick_settings_dismiss_failed' 'control centre still foreground; keep worker waiting'
  return $false
}
function Restore-DownloadWindow {
  Test-MacroStop
  if(-not (Test-BrowserWindow)) {return $false}
  $before=Get-ForegroundContext
  # A locked/secure desktop is not an ordinary focus change. Leave it untouched.
  if($before.handle -eq 0) {return $false}
  # This is called only at the existing three-minute focus-return deadline.
  # Dismiss the positively identified system flyout before activating Edge.
  if(Test-QuickSettingsContext $before) {Dismiss-QuickSettings $before | Out-Null}
  Test-MacroStop
  [W32]::ShowWindow($script:TargetHandle,3) | Out-Null
  [W32]::SetForegroundWindow($script:TargetHandle) | Out-Null
  $current=Get-ForegroundContext
  if($current.handle -ne $script:TargetHandle.ToInt64()) {
    Test-MacroStop
    # User explicitly authorized reclaiming this window after three minutes.
    # A bare Alt press is the normal Windows activation gesture, not document input.
    # No registry/foreground-lock settings or permissions are changed.
    [W32]::keybd_event(0x12,0,0,[UIntPtr]::Zero)
    [W32]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
    [W32]::SetForegroundWindow($script:TargetHandle) | Out-Null
  }
  $current=Get-ForegroundContext
  return ($current.handle -eq $script:TargetHandle.ToInt64())
}
function Assert-EdgeForeground($hwnd) {
  Test-MacroStop
  $started=Get-FocusNow
  $nextReturnAt=$started.AddSeconds(180)
  $waiting=$false
  $previous=$script:State.status
  $previousReason=$script:State.reason
  $lastTitle=$null
  while($true) {
    Test-MacroStop
    $fg=Get-ForegroundContext
    if($fg.handle -eq $hwnd.ToInt64() -or ($script:SaveDialogHandle -ne [IntPtr]::Zero -and $fg.handle -eq $script:SaveDialogHandle.ToInt64())) {break}
    $contextKey=[string]$fg.handle+'|'+$fg.title
    if(-not $waiting -or $contextKey -ne $lastTitle) {
      $script:State.foreground=$fg
      $script:State.waiting_since=$started.ToUniversalTime().ToString('o')
      $script:State.stage_before_wait=$script:State.stage
      Write-Result $script:State.current_doi 'waiting_focus' ($fg | ConvertTo-Json -Compress)
      $lastTitle=$contextKey
    }
    $waiting=$true
    $now=Get-FocusNow
    $script:State.focus_return_in_seconds=[Math]::Max(0,[Math]::Ceiling(($nextReturnAt-$now).TotalSeconds))
    if(Test-BrowserWindow) {
      Save-MacroState 'waiting_focus' 'Paused article input; after 3 minutes the macro will return to the download Edge automatically.'
      if($now -ge $nextReturnAt) {
        Test-MacroStop
        Write-Result $script:State.current_doi 'focus_return_requested' (@{waited_seconds=[Math]::Round(($now-$started).TotalSeconds,3);target=$hwnd.ToInt64()} | ConvertTo-Json -Compress)
        $returned=Restore-DownloadWindow
        if($returned) {Write-Result $script:State.current_doi 'focus_return_succeeded' 'specified Edge foreground confirmed';continue}
        Write-Result $script:State.current_doi 'focus_return_failed' 'Windows did not activate the specified Edge; waiting, next attempt in 3 minutes'
        $nextReturnAt=$now.AddSeconds(180)
      }
    }
    else {throw 'MACRO_WAIT_BROWSER: download window closed; update request window_handle to resume in another existing Edge'}
    Wait-Poll
  }
  if($waiting) {
    $script:PauseTotalMs+=((Get-Date)-$started).TotalMilliseconds
    $script:State.Remove('waiting_since');$script:State.Remove('foreground');$script:State.Remove('focus_return_in_seconds')
    Write-Result $script:State.current_doi 'focus_restored' 'resuming same article; article input remained restricted to target Edge'
    Save-MacroState $previous $previousReason
    # A user may have changed tabs/scroll/selection while paused. Reopen the same DOI
    # through the dedicated target tab, rather than using a stale UI element or typing half a shortcut.
    throw 'MACRO_FOCUS_RESUMED: restart current article from a known page'
  }
}
function Get-ActiveNow {return (Get-Date).AddMilliseconds(-$script:PauseTotalMs)}
function Send-MacroKeys([string]$keys) {
  Assert-EdgeForeground $script:TargetHandle
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}
function Get-MacroJournal([string]$file) {
  $terminal=@{};$downloaded=@{}
  if(Test-Path -LiteralPath $file) {
    $lines=@(Get-Content -LiteralPath $file -Encoding UTF8 | Where-Object {$_.Trim()})
    $valid=New-Object 'System.Collections.Generic.List[string]'
    for($i=0;$i -lt $lines.Count;$i++) {
      try {$record=$lines[$i] | ConvertFrom-Json}
      catch {
        if($i -ne $lines.Count-1) {throw 'Malformed macro journal before the last record'}
        Copy-Item -LiteralPath $file -Destination ($file+'.incomplete-'+(Get-Date).ToString('yyyyMMddHHmmssfff'))
        [IO.File]::WriteAllText($file,($valid -join "`n")+"`n",(New-Object Text.UTF8Encoding($false)))
        break
      }
      $valid.Add($lines[$i])
      if($record.status -in @('registered','already_local','failed')) {$terminal[$record.doi]=$record.status}
      if($record.status -eq 'downloaded') {$downloaded[$record.doi]=$record.detail}
    }
  }
  return @{terminal=$terminal;downloaded=$downloaded}
}
function Get-MacroFailureAction([string]$message,[int]$attempt) {
  if($message -match '^MACRO_STOP:') {return 'stop'}
  if($message -match '^MACRO_WAIT_BROWSER:') {return 'browser'}
  if($message -match '^MACRO_ACCESS:') {return 'access'}
  if($message -match '^MACRO_(ATTENTION|WAIT):') {return 'wait'}
  if($message -match '^MACRO_PAPER:') {return 'fail'}
  if($message -match '^MACRO_FOCUS_RESUMED:') {return 'resume'}
  if($attempt -lt 2) {return 'retry'}
  return 'fail'
}
function Wait-MacroRecovery([string]$reason,[string]$status='waiting_error') {
  # Shared resources recover in place; no desktop input and no model polling.
  $until=(Get-FocusNow).AddSeconds(30)
  do {
    Test-MacroStop
    try {Save-MacroState $status $reason} catch {Write-Host ('State unavailable: '+$_.Exception.Message)}
    Wait-Poll
  } while((Get-FocusNow) -lt $until)
}
