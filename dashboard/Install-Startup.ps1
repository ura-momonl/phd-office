param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$path = Join-Path ([Environment]::GetFolderPath('Startup')) 'PhD-Workflows.lnk'
$target = Join-Path $env:SystemRoot 'System32/wscript.exe'
$arguments = '"' + (Join-Path $PSScriptRoot 'Start-Dashboard.vbs') + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
if ((Test-Path -LiteralPath $path) -and ($shortcut.TargetPath -ne $target -or $shortcut.Arguments -ne $arguments)) {
    throw 'An unrelated startup shortcut exists; refused to replace or remove it.'
}
if ($Uninstall) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    Write-Output 'Office login startup disabled; the current backend was not stopped.'
} else {
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
    $shortcut.Description = '课题办公室：登录后隐藏启动后端与托盘，不自动打开浏览器'
    $shortcut.Save()
    Write-Output "Installed: $path"
}
