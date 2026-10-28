$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $assistantRoot '.runtime\mail-flow'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$process = Start-Process -FilePath 'D:\Program Files\nodejs\node.exe' -ArgumentList @('automation/run.mjs', 'mail', 'collect') -WorkingDirectory $assistantRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logRoot 'collector-output.log') -RedirectStandardError (Join-Path $logRoot 'collector-error.log')
$collectionExit = $process.ExitCode
# The same ten-minute program tick prepares Monday reports; it never starts a model.
& 'D:\Program Files\nodejs\node.exe' (Join-Path $assistantRoot 'automation\run.mjs') weekly tick | Out-Null
exit $collectionExit
