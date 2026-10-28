param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$path = Join-Path ([Environment]::GetFolderPath('Startup')) 'PhD-Discord-Bridge.lnk'
$target = Join-Path $env:SystemRoot 'System32/wscript.exe'
$arguments = '"' + (Join-Path $PSScriptRoot 'Start-Discord.vbs') + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
if ((Test-Path -LiteralPath $path) -and ($shortcut.TargetPath -ne $target -or $shortcut.Arguments -ne $arguments)) { throw 'An unrelated startup shortcut exists; refused to replace or remove it.' }
if ($Uninstall) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    Write-Output 'Discord login startup disabled; running bridge was not stopped.'
} else {
    $shortcut.TargetPath = $target; $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Office Discord: hidden login startup; no model launch or duplicate delivery'
    $shortcut.Save()
    $saved = $shell.CreateShortcut($path)
    if ($saved.TargetPath -ne $target -or $saved.Arguments -ne $arguments) { throw 'Startup shortcut read-back did not match.' }
    Write-Output "Installed and verified: $path"
}
