$ErrorActionPreference = 'Stop'
$taskName = 'PhD-Workflows-Mail-ReadOnly'
$launcher = Join-Path $PSScriptRoot 'Start-Collector.ps1'
# conhost --headless gives the script a console with no window at all. powershell -WindowStyle Hidden still flashed a Windows Terminal window every run
# (measured with a window probe on Windows 11 where Windows Terminal is the default terminal).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $launcher)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Every 10 minutes: incremental read-only mail collection. No model turns. No email sending.' -Force | Select-Object TaskName,State
