# 去掉 Codex 里那个报 xining.liao@wisc.edu 的 Outlook 连接器。
# 这个连接绑在 ChatGPT/Codex 账号的服务端（Apps/Connectors），本机文件里没有，只能在网页里断开。
# 运行：powershell -ExecutionPolicy Bypass -File D:\Main\assistant\scripts\remove-outlook-connector.ps1
Write-Host '打开 ChatGPT 网页。请在 Settings -> Apps（Connectors）里找到 Outlook / Outlook Email，点 Disconnect。'
Write-Host '注意：要用 Codex 登录的那个 ChatGPT 账号，不是 kliu377 的微软账号。'
Start-Process 'https://chatgpt.com/#settings/Connectors'
Read-Host '断开后按回车，我来核对'
Set-Location 'D:\Main\assistant'
node automation/run.mjs mail outlook-tools get_profile
