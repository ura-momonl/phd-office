$ErrorActionPreference = 'Stop'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Limi-Work-Assistant.lnk'
$target = Join-Path $env:SystemRoot 'System32\wscript.exe'
$arguments = '"' + (Join-Path $PSScriptRoot 'Start-Assistant.vbs') + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $target -or $shortcut.Arguments -ne $arguments)) {
    throw 'An unrelated startup shortcut exists; refused to replace it.'
}
$shortcut.TargetPath = $target
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = 'Start Limi local work assistant'
$shortcut.Save()
Write-Output 'Assistant will start quietly when this Windows user signs in.'
