# Mouse/keyboard macro: drives the user's already-open Edge window like a person would.
# One paper at a time: open doi.org/<doi>, find the page's own PDF button by accessible name, press it,
# wait for the file to land in Downloads, then validate (printed DOI, local) and register via register.mjs.
# Maintained, explicit desktop downloader. Focus loss pauses input, not the batch.
param(
  [string]$RequestFile,
  [string]$ListFile,
  [int]$Max = 20000,
  [int]$PaceSeconds = 3,
  [long]$WindowHandle = 0,
  [switch]$ReuseTab,
  [string]$Directory,
  [switch]$RetryFailed,
  [string]$StopFile,
  [string]$Log
)
$ErrorActionPreference = 'Stop'
if($RequestFile) {
  $request=Get-Content -LiteralPath $RequestFile -Encoding UTF8 -Raw | ConvertFrom-Json
  $ListFile=$request.list_file;$Directory=$request.directory;$WindowHandle=[long]$request.window_handle
  if($null -ne $request.pace_seconds) {$PaceSeconds=[int]$request.pace_seconds}
  if($null -ne $request.max) {$Max=[int]$request.max}
  $ReuseTab=[bool]$request.reuse_tab;$RetryFailed=[bool]$request.retry_failed
}
$office=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $office
if(-not $ListFile -or -not $Directory -or $WindowHandle -le 0 -or $PaceSeconds -lt 1) {throw 'Provide list_file, directory, window_handle and pace_seconds >= 1'}
$Directory=[IO.Path]::GetFullPath($Directory)
[IO.Directory]::CreateDirectory($Directory) | Out-Null
if(-not $StopFile) {$StopFile=Join-Path $Directory 'STOP'}
if(-not $Log) {$Log=Join-Path $Directory 'attempts.jsonl'}
if(Test-Path -LiteralPath $StopFile) {throw 'STOP exists. Explicitly move it aside before resuming this run.'}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
# UIA bounding rectangles are physical pixels. Make WinForms screen bounds and input use
# the same coordinate space; otherwise 150% scaling reports a fictitious smaller monitor.
if(-not [W32]::SetProcessDpiAwarenessContext([IntPtr](-4))) {[W32]::SetProcessDPIAware() | Out-Null}
$downloads = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name '{374DE290-123F-4565-9164-39C4925E467B}'))
$AE = [Windows.Automation.AutomationElement]
$script:TargetHandle = [IntPtr]::Zero
$script:SaveDialogHandle = [IntPtr]::Zero
$script:PauseTotalMs=0
$script:StateFile=Join-Path $Directory 'progress.json'
$script:State=@{pid=$PID;started_at=(Get-Date).ToUniversalTime().ToString('o');status='starting';reason='';stage='startup';current_doi='';registered=0;failed=0;completed=0;total=0;window_handle=$WindowHandle;pace_seconds=$PaceSeconds;focus_return_seconds=180;list_file=[IO.Path]::GetFullPath($ListFile);log=$Log}
. (Join-Path $PSScriptRoot 'mouse-focus.ps1')
$script:Notify=$null
try {
  $script:Notify=New-Object Windows.Forms.NotifyIcon
  $script:Notify.Icon=[Drawing.SystemIcons]::Information
  $script:Notify.Text='Paper download macro'
  $script:Notify.Visible=$true
} catch {Write-Host 'Tray notification unavailable; progress.json remains available'}

function Write-Result($doi, $status, $detail) {
  $line = @{ doi = $doi; status = $status; detail = $detail; at = (Get-Date).ToString('s') } | ConvertTo-Json -Compress
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
  Write-Host "$doi  $status  $detail"
}
function Get-Edge {
  $p = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and ($WindowHandle -eq 0 -or $_.MainWindowHandle.ToInt64() -eq $WindowHandle) } | Select-Object -First 1
  if (-not $p) { throw 'MACRO_WAIT_BROWSER: specified Edge window not found; update request window_handle when it is reopened' }
  return $p.MainWindowHandle
}
function Select-WorkTab {
  Assert-EdgeForeground $script:TargetHandle
  $pattern=$null
  $type=New-Object Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem)
  foreach($tab in $AE::FromHandle($script:TargetHandle).FindAll([Windows.Automation.TreeScope]::Descendants,$type)) {
    if(($tab.GetRuntimeId() -join ',') -eq $script:WorkTabId -and $tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {$pattern.Select();return}
  }
  # Recreate only our work tab, in the same window, never reuse the user's page.
  Send-MacroKeys '^t';Start-Sleep -Seconds 1
  $script:WorkTabId=((Get-SelectedTab).GetRuntimeId() -join ',')
  Write-Result $script:State.current_doi 'tab_restored' 'created replacement download tab in specified Edge'
}
function Get-SelectedTab {
  $type=New-Object Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem)
  foreach($tab in $AE::FromHandle($script:TargetHandle).FindAll([Windows.Automation.TreeScope]::Descendants,$type)) {
    # Web pages also expose selected TabItems (e.g. Science's INFORMATION / METRICS).
    # Only a chrome tab outside any Document may own the download navigation.
    $ancestor=$tab;$inPage=$false
    while($ancestor) {
      if($ancestor.Current.ControlType -eq [Windows.Automation.ControlType]::Document) {$inPage=$true;break}
      $ancestor=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
    }
    if($inPage) {continue}
    $pattern=$null
    if($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern) -and $pattern.Current.IsSelected) {return $tab}
  }
  throw 'MACRO_ATTENTION: cannot identify the selected download tab'
}
function Find-Named($root, [string[]]$names) {
  foreach ($n in $names) {
    $c = New-Object Windows.Automation.PropertyCondition($AE::NameProperty, $n)
    $e = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $c)
    if ($e -and $e.Current.IsEnabled) { return $e }
  }
  return $null
}
function Press($el) {
  Assert-EdgeForeground $script:TargetHandle
  $pat = $null
  # Chromium can expose controls below the viewport. Focus/scroll before using coordinates.
  if ($el.Current.IsOffscreen) {
    if ($el.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pat)) { $pat.ScrollIntoView() }
    else { $el.SetFocus() }
    Start-Sleep -Milliseconds 400
    Assert-EdgeForeground $script:TargetHandle
  }
  $pat = $null
  if ($el.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { try { $pat.Invoke(); return } catch {} }
  $r = $el.Current.BoundingRectangle
  $point = New-Object W32+POINT
  $point.X = [int]($r.X + $r.Width / 2); $point.Y = [int]($r.Y + $r.Height / 2)
  $under = [W32]::WindowFromPoint($point)
  $owner = [W32]::GetAncestor($under, 2)
  if ($el.Current.IsOffscreen -or $r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0 -or ($owner -ne $script:TargetHandle -and $owner -ne $script:SaveDialogHandle)) {
    throw 'Control not visible inside target browser; no mouse click sent'
  }
  Assert-EdgeForeground $script:TargetHandle
  [W32]::SetCursorPos($point.X, $point.Y) | Out-Null
  [W32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [W32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
function Wait-NewPdf([datetime]$since, [int]$timeout = 25) {
  $end = (Get-ActiveNow).AddSeconds($timeout)
  while ((Get-ActiveNow) -lt $end) {
    Test-MacroStop
    Complete-MacroSaveDialog
    Assert-EdgeForeground $script:TargetHandle
    Save-MacroState 'running'
    $stem=($script:State.current_doi -split '/')[-1]
    $f = Get-ChildItem -LiteralPath $downloads -Filter *.pdf -File | Where-Object {
      $_.LastWriteTime -gt $since -and ($script:State.current_doi -notmatch '^10\.(1038|1126)/' -or $_.BaseName -eq $stem -or $_.BaseName -match ('^'+[regex]::Escape($stem)+' \(\d+\)$'))
    } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) {
      $s1 = $f.Length; Start-Sleep -Milliseconds 1200; $f.Refresh()
      if ($f.Length -eq $s1 -and $s1 -gt 20000) { return $f.FullName }
    }
    Start-Sleep -Milliseconds 700
  }
  return $null
}
function Complete-MacroSaveDialog {
  # Handle only a Save As dialog owned by the target window, following our PDF
  # click. An unrelated Edge/profile save dialog must remain untouched.
  foreach($name in @('另存为','Save As')) {
    $condition=New-Object Windows.Automation.PropertyCondition($AE::NameProperty,$name)
    foreach($dialog in $AE::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)) {
      $handle=[IntPtr]$dialog.Current.NativeWindowHandle
      if($handle -eq [IntPtr]::Zero -or [W32]::GetAncestor($handle,3) -ne $script:TargetHandle) {continue}
      $editCondition=New-Object Windows.Automation.PropertyCondition($AE::AutomationIdProperty,'1001')
      $edit=$dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,$editCondition)
      $confirm=Find-Named $dialog @('保存(S)','Save','Save (&S)')
      $value=$null
      if(-not $edit -or -not $confirm -or -not $edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value)) {throw 'MACRO_ATTENTION: target Save As dialog is not recognisable; waiting for it to be dismissed'}
      $script:SaveDialogHandle=$handle
      try {
        Assert-EdgeForeground $script:TargetHandle
        $stem=($script:State.current_doi -split '/')[-1]
        $target=Join-Path $downloads ($stem+'.pdf')
        if(Test-Path -LiteralPath $target) {$target=Join-Path $downloads ($stem+' ('+(Get-Date -Format 'yyyyMMddHHmmssfff')+').pdf')}
        $value.SetValue($target)
        Press $confirm
        Write-Result $script:State.current_doi 'save_dialog_handled' $target
      } finally {$script:SaveDialogHandle=[IntPtr]::Zero}
      return
    }
  }
}


function Initialize-MacroBrowser {
  Test-MacroStop
  if($RequestFile -and ($script:TargetHandle -eq [IntPtr]::Zero -or -not (Test-BrowserWindow))) {
    $latest=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:WindowHandle=[long]$latest.window_handle
  }
  $h0=Get-Edge
  if($h0 -ne $script:TargetHandle) {$script:WorkTabId=$null}
  $script:TargetHandle=$h0;$script:State.window_handle=$h0.ToInt64()
  [W32]::ShowWindow($h0,3)|Out-Null
  [W32]::SetForegroundWindow($h0)|Out-Null
  Start-Sleep -Milliseconds 500
  try {Assert-EdgeForeground $h0} catch {if($_.Exception.Message -notmatch '^MACRO_FOCUS_RESUMED:'){throw}}
  $screen=[Windows.Forms.Screen]::FromHandle($h0).WorkingArea
  $bounds=$AE::FromHandle($h0).Current.BoundingRectangle
  if($bounds.Width -lt $screen.Width*0.8 -or $bounds.Height -lt $screen.Height*0.8) {throw 'MACRO_WAIT: browser did not maximize on its monitor'}
  $script:State.window_bounds=@{left=$bounds.X;top=$bounds.Y;width=$bounds.Width;height=$bounds.Height;screen_left=$screen.X;screen_top=$screen.Y;screen_width=$screen.Width;screen_height=$screen.Height}
  if(-not $script:WorkTabId) {
    if(-not $ReuseTab) {Send-MacroKeys '^t';Start-Sleep -Seconds 1}
    $script:WorkTabId=((Get-SelectedTab).GetRuntimeId() -join ',')
  }
}
function Invoke-MacroLocal([string]$doi,[string]$file) {
  $stdout=Join-Path $Directory ('local-'+$PID+'.stdout.json')
  $stderr=Join-Path $Directory ('local-'+$PID+'.stderr.log')
  $arguments=@(('"'+(Join-Path $PSScriptRoot 'mouse-download.mjs')+'"'),'local',$doi)
  if($file) {$arguments+=('"'+$file+'"')}
  try {$process=Start-Process node -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru}
  catch {throw ('MACRO_WAIT: local validator could not start: '+$_.Exception.Message)}
  $deadline=(Get-Date).AddSeconds(90)
  try {
    while(-not $process.WaitForExit(500)) {
      Test-MacroStop
      Save-MacroState 'running'
      if((Get-Date) -ge $deadline) {throw 'MACRO_WAIT: local validator exceeded 90 seconds; retry after recovery wait'}
    }
    $result=Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 | ConvertFrom-Json
    if(-not $result.status) {throw 'MACRO_WAIT: local validator returned no status'}
    return $result
  } catch {
    if($_.Exception.Message -match '^MACRO_') {throw}
    throw ('MACRO_WAIT: local validator I/O failed: '+$_.Exception.Message)
  } finally {if(-not $process.HasExited){$process.Kill()};$process.Dispose()}
}
function Assert-MacroLocalResult($result) {
  if($result.status -eq 'validation_failed') {throw ('MACRO_PAPER: local PDF rejected: '+$result.message)}
  if($result.status -notin @('missing','local-file')) {throw ('MACRO_WAIT: local PDF/catalog service unavailable: '+$result.message)}
}
function Get-MacroAccessTitle {return $AE::FromHandle($script:TargetHandle).Current.Name}
function Wait-MacroAccess([string]$reason) {
  if(-not $script:AccessDeadline) {$script:AccessDeadline=(Get-FocusNow).AddSeconds(10)}
  while($true) {
    Test-MacroStop
    if((Get-FocusNow) -ge $script:AccessDeadline) {return $false}
    if(-not (Test-BrowserWindow)) {throw 'MACRO_WAIT_BROWSER: download window closed during access verification'}
    # Observe only. Do not click verification, reload, or change publisher/profile.
    $title=Get-MacroAccessTitle
    if($title -notmatch '(?i)just a moment|access denied|verify you are human|captcha|unusual traffic|too many requests') {return $true}
    Save-MacroState 'waiting_access' $reason
    Wait-Poll
  }
}
function Invoke-MacroArticle([string]$doi,$downloaded) {
    Test-MacroStop
    $script:State.stage='checking_local';Save-MacroState 'running'
    $argsLocal=@('local',$doi)
    if($downloaded[$doi] -and (Test-Path -LiteralPath $downloaded[$doi])) {$argsLocal+=$downloaded[$doi]}
    $local = Invoke-MacroLocal $doi $(if($argsLocal.Count -gt 2){$argsLocal[2]})
    Assert-MacroLocalResult $local
    if($local.status -eq 'local-file') {return @{status='already_local';detail=$local.path}}
    $script:State.stage='opening';Save-MacroState 'running'
    Write-Result $doi 'starting' 'opening publisher page'
    Assert-EdgeForeground $script:TargetHandle
    $hwnd = Get-Edge
    Select-WorkTab
    $oldClip = $null; try { $oldClip = Get-Clipboard -Raw } catch {}
    Set-Clipboard -Value ('https://doi.org/' + $doi)
    Assert-EdgeForeground $hwnd
    Send-MacroKeys '^l'; Start-Sleep -Milliseconds 300
    Send-MacroKeys '^v'; Start-Sleep -Milliseconds 200
    Send-MacroKeys '{ENTER}'
    if ($oldClip) { Start-Sleep -Milliseconds 300; Set-Clipboard -Value $oldClip }
    $start = Get-Date
    $isAps = $doi.ToLower().StartsWith('10.1103/')
    $isAcs = $doi.ToLower().StartsWith('10.1021/')
    $isScience = $doi.ToLower().StartsWith('10.1126/')
    $isWiley = $doi.ToLower().StartsWith('10.1002/')
    $names = if ($isAps -or $isWiley) { @('PDF') } elseif ($isScience) { @('View Options') } else { @('Download PDF') }
    # wait for the page to expose its own PDF control (up to 30 s); absence = no access, we do not push further
    $script:State.stage='finding_pdf';Save-MacroState 'running'
    $root = $AE::FromHandle($hwnd); $el = $null; $end = (Get-ActiveNow).AddSeconds(30)
    # The user accepts the site cookie banner every time (stated 2026-10-19), so press an exactly-named accept button if one blocks the page.
    $cookieDone = $false; $accessCheck = $false
    while ((Get-ActiveNow) -lt $end -and -not $el) {
      Start-Sleep -Seconds 1
      Assert-EdgeForeground $hwnd
      Save-MacroState 'running'
      if ($root.Current.Name -match '(?i)just a moment|access denied|verify you are human|captcha|unusual traffic|too many requests') { $accessCheck = $true; break }
      if (-not $cookieDone) {
        $acc = Find-Named $root @('Accept all cookies', 'Accept All Cookies', 'Accept all', 'Accept All', 'Accept cookies', 'Accept Cookies', 'Allow all cookies', 'I agree', 'Agree', 'I Accept', 'ACCEPT ALL')
        if ($acc) { Press $acc; $cookieDone = $true; Write-Host "$doi cookie banner accepted"; Start-Sleep -Seconds 2 }
      }
      if ($isAcs) {
        $bc = New-Object Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
        $el = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $bc) | Where-Object { $_.Current.Name -match ' PDF Link Open PDF$' } | Select-Object -First 1
      } else { try { $el = Find-Named $root $names } catch [System.Windows.Automation.ElementNotAvailableException] { $root = $AE::FromHandle($hwnd) } }
    }
    if ($accessCheck) {throw 'MACRO_ACCESS: browser reports access denial or human verification'}
    if (-not $el) {throw 'PDF control did not appear within the page timeout'}
    Start-Sleep -Milliseconds 800
    Press $el
    if ($isWiley) {
      $download = $null; $endDownload = (Get-ActiveNow).AddSeconds(30)
      while ((Get-ActiveNow) -lt $endDownload -and -not $download) {
        Start-Sleep -Seconds 1
        Assert-EdgeForeground $hwnd
        $reader = $AE::FromHandle($hwnd)
        if ($reader.Current.Name -match '(?i)just a moment|access denied|verify you are human|captcha|unusual traffic|too many requests') { throw 'MACRO_ACCESS: access check in Wiley reader' }
        $lc = New-Object Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [Windows.Automation.ControlType]::Hyperlink)
        $download = $reader.FindAll([Windows.Automation.TreeScope]::Descendants, $lc) | Where-Object { $_.Current.Name -match '^Download PDF(?:\s|$)' -and $_.Current.IsEnabled } | Select-Object -First 1
      }
      if (-not $download) { throw 'Wiley reader has no Download PDF control' }
      Press $download
    }
    if ($isScience) {
      $download = $null; $endDownload = (Get-ActiveNow).AddSeconds(20)
      while ((Get-ActiveNow) -lt $endDownload -and -not $download) {
        Start-Sleep -Seconds 1
        Assert-EdgeForeground $hwnd
        $reader = $AE::FromHandle($hwnd)
        if ($reader.Current.Name -match '(?i)just a moment|access denied|verify you are human|captcha|unusual traffic|too many requests') { throw 'MACRO_ACCESS: access check in Science panel' }
        $download = Find-Named $reader @('DOWNLOAD PDF', 'Download PDF')
      }
      if (-not $download) { throw 'Science View Options panel has no DOWNLOAD PDF control' }
      Press $download
    }
    if ($isAps -or $isAcs) {   # Edge PDF viewer's enabled Save / Save As control
      $save = $null; $end2 = (Get-ActiveNow).AddSeconds(20)
      while ((Get-ActiveNow) -lt $end2 -and -not $save) {
        Start-Sleep -Seconds 1
        # signed PDFs disable 'save' but keep 'saveAs'; use whichever is enabled
        foreach ($id in 'save', 'saveAs') {
          $c = New-Object Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
          $cand = $AE::FromHandle($hwnd).FindFirst([Windows.Automation.TreeScope]::Descendants, $c)
          if ($cand -and $cand.Current.IsEnabled) { $save = $cand; break }
        }
      }
      if (-not $save) {throw 'PDF viewer save button not found'}
      Start-Sleep -Seconds 2
      Press $save; Start-Sleep -Seconds 3
      # The same target-bound handler also covers direct publisher downloads.
      Complete-MacroSaveDialog
    }
    $script:State.stage='downloading';Save-MacroState 'running'
    $file = Wait-NewPdf $start 40
    if (-not $file) {throw 'Download did not land within 40 seconds'}
    Write-Result $doi 'downloaded' $file
    $downloaded[$doi]=$file
    if ($isAcs) {Assert-EdgeForeground $hwnd;Send-MacroKeys '^w'; Start-Sleep -Milliseconds 500}
    $script:State.stage='validating';Save-MacroState 'running'
    $registration = Invoke-MacroLocal $doi $file
    Assert-MacroLocalResult $registration
    if($registration.status -ne 'local-file') {throw 'MACRO_WAIT: registration produced no verified result'}
    return @{status='registered';detail=$file}
}
function Invoke-MacroQueue($dois) {
  while($true) {
  try {
    Test-MacroStop
    $journal=Get-MacroJournal $Log
    $terminal=$journal.terminal;$downloaded=$journal.downloaded
    $script:State.total=$dois.Count
    $script:State.registered=0;$script:State.failed=0;$script:State.completed=0
    foreach($doi in $dois) {
      if($terminal[$doi] -in @('registered','already_local')) {$script:State.registered++;$script:State.completed++}
      elseif($terminal[$doi] -eq 'failed' -and -not $RetryFailed) {$script:State.failed++;$script:State.completed++}
    }
    Save-MacroState 'starting'
    Initialize-MacroBrowser
    $accessSkipped=$null
    if($script:AccessWaitReason) {
      if(-not (Wait-MacroAccess $script:AccessWaitReason)) {
        $accessSkipped=$script:State.current_doi
        Write-Result $accessSkipped 'failed' 'Access verification unchanged after 10 seconds; skipped without interacting with verification'
        $terminal[$accessSkipped]='failed';$script:State.failed++;$script:State.completed++
      }
      $script:AccessWaitReason=$null;$script:AccessDeadline=$null
    }
    foreach($doi in $dois) {
      if($doi -eq $accessSkipped) {continue}
      if($terminal[$doi] -in @('registered','already_local') -or ($terminal[$doi] -eq 'failed' -and -not $RetryFailed)) {continue}
      $script:State.current_doi=$doi
      $attempt=0;$complete=$false
      while(-not $complete) {
        try {
          Test-MacroStop
          $result=Invoke-MacroArticle $doi $downloaded
          Write-Result $doi $result.status $result.detail
          $script:State.registered++;$script:State.completed++;$complete=$true
        } catch {
          $message=$_.Exception.Message
          $action=Get-MacroFailureAction $message ($attempt+1)
          if($action -eq 'stop') {throw}
          if($action -eq 'resume') {continue}
          if($action -eq 'access') {
            $script:AccessWaitReason=$message;$script:AccessDeadline=(Get-FocusNow).AddSeconds(10)
            Write-Result $doi 'waiting_access' $message
            if(-not (Wait-MacroAccess $message)) {
              Write-Result $doi 'failed' 'Access verification unchanged after 10 seconds; skipped without interacting with verification'
              $script:State.failed++;$script:State.completed++;$complete=$true
            }
            $script:AccessWaitReason=$null;$script:AccessDeadline=$null
            continue
          }
          if($action -eq 'wait') {Write-Result $doi 'waiting_error' $message;Wait-MacroRecovery $message;continue}
          if($action -eq 'browser') {throw}
          $attempt++
          if($action -eq 'retry') {Write-Result $doi 'retrying' $message;Save-MacroState 'retrying' $message;Start-Sleep -Seconds $PaceSeconds}
          else {Write-Result $doi 'failed' $message;$script:State.failed++;$script:State.completed++;$complete=$true}
        }
      }
      Save-MacroState 'running'
      Start-Sleep -Seconds $PaceSeconds
    }
    $script:State.current_doi='';$script:State.stage='finished'
    Save-MacroState 'complete' 'Queue finished. Rejected/failed papers remain in attempts.jsonl; RetryFailed explicitly reopens them.'
    return
  } catch {
    $message=$_.Exception.Message
    if($message -match '^MACRO_STOP:') {throw}
    # Shared-resource/journal/UI failures must not end the worker or advance an
    # uncommitted article. Reload the durable cursor after a recovery interval.
    try {Write-Result $script:State.current_doi 'recovering' $message} catch {Write-Host $message}
    $status=if($message -match '^MACRO_WAIT_BROWSER:'){'waiting_browser'}else{'waiting_error'}
    Wait-MacroRecovery $message $status
  }
  }
}
function Invoke-MacroWorker($dois) {
  while($true) {
    try {Invoke-MacroQueue $dois;return}
    catch {
      $message=$_.Exception.Message
      if($message -match '^MACRO_STOP:') {
        try {Write-Result $script:State.current_doi 'halted' $message} catch {Write-Host $message}
        try {Save-MacroState 'stopped' $message} catch {Write-Host ('Stop state unavailable: '+$_.Exception.Message)}
        return
      }
      # Even an exception inside recovery stays inside the worker lifetime.
      Write-Host ('Worker recovery: '+$message)
      try {Wait-MacroRecovery $message} catch {
        if($_.Exception.Message -match '^MACRO_STOP:') {continue}
        Write-Host ('Recovery wait unavailable: '+$_.Exception.Message)
        Start-Sleep -Seconds 1
      }
    }
  }
}

$dois = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | ForEach-Object {$_.Trim()} | Where-Object { $_ } | Select-Object -Unique | Select-Object -First $Max)
$mutex = New-Object System.Threading.Mutex($false, 'Local\PiriLiteratureMouseMacro')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { $mutex.Dispose(); throw 'Another mouse download macro is already running' }
try {Invoke-MacroWorker $dois} finally {
  if($script:Notify) {try {$script:Notify.Dispose()} catch {}}
  if($owned) {$mutex.ReleaseMutex()};$mutex.Dispose()
}
