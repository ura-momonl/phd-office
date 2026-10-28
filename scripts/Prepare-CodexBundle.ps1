$ErrorActionPreference = 'Stop'
$assistantRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $assistantRoot '.runtime\state\npm\projects\openclaw-codex-8902d781d4'
$source = Join-Path $project 'node_modules\@openclaw\codex'
$hostRoot = Join-Path $assistantRoot '.runtime\openclaw\node_modules\openclaw'
$destination = Join-Path $hostRoot 'dist\extensions\codex'
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostPackage = Get-Content -LiteralPath (Join-Path $hostRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne '@openclaw/codex' -or $package.version -ne '2026.9.8' -or $hostPackage.version -ne $package.version) {
    throw 'The pinned official Codex plugin and host versions must match.'
}
if (Test-Path -LiteralPath $destination) { throw 'Codex bundle already exists; refuse to replace it automatically.' }
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
    if ($item.Name -ne 'node_modules') { Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse }
}
New-Item -ItemType Junction -Path (Join-Path $destination 'node_modules') -Target (Join-Path $project 'node_modules') | Out-Null
Write-Output 'Pinned official Codex package prepared as a local bundle; package code is unchanged.'
