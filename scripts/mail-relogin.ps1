# 在你自己的 PowerShell 里运行：
#   powershell -ExecutionPolicy Bypass -File D:\Main\assistant\scripts\mail-relogin.ps1
# 作用：用 kliu377@wisc.edu 重新登录办公室的发信/回信会话（Mail.ReadWrite + Mail.Send），
# 设备码会直接打印在窗口里；到 https://microsoft.com/devicelogin 输入，用 kliu377@wisc.edu 登录并同意。
$ErrorActionPreference = 'Stop'
$root = 'D:\Main\assistant'
$account = 'kliu377@wisc.edu'
$pwsh = Join-Path $root '.runtime\mail-flow\graph-sdk\powershell-7.6.7\pwsh.exe'
$module = Join-Path $root '.runtime\mail-flow\graph-sdk\Microsoft.Graph.Authentication\2.41.2\Microsoft.Graph.Authentication.psd1'

$inner = @"
`$ErrorActionPreference = 'Stop'
`$InformationPreference = 'Continue'
Import-Module '$module'
Write-Host '已加载 Graph SDK，正在向微软申请设备码……'
Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null
Connect-MgGraph -Scopes @('Mail.ReadWrite','Mail.Send') -UseDeviceAuthentication -ContextScope CurrentUser -NoWelcome -InformationAction Continue
`$c = Get-MgContext
Write-Host ('登录账号: ' + `$c.Account)
if (`$c.Account -ine '$account') { Write-Host '账号不是 $account，请重新运行并选对账号。'; exit 2 }
Write-Host ('权限: ' + (`$c.Scopes -join ', '))
Write-Host '完成。'
"@

& $pwsh -NoProfile -Command $inner
if ($LASTEXITCODE -ne 0) { Write-Host "登录未完成（退出码 $LASTEXITCODE）。把窗口里的文字发给我。"; exit $LASTEXITCODE }

Write-Host ''
Write-Host '--- 办公室侧状态 ---'
Set-Location $root
node automation/run.mjs mail graph-status
