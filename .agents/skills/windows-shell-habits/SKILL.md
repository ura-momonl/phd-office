---
name: windows-shell-habits
description: 在本机用 Bash / PowerShell 跑 node、写临时文件、传中文或 JSON、等待后台任务前读：避开本周统计里反复出现的命令层报错。
---

# Windows 命令层做法

依据：2026-10-17—23 对三位助手 1750 个轮次的统计，命令层报错 486 次、涉及 174 个轮次，基本都是下面几种写法造成的（原始数据 `D:/stuck-stats/errors.json`）。适用于 Claude 的 Bash/PowerShell 和 Codex 的 PowerShell。

## 通用：脚本和数据先写成文件
- JSON、中文文本用文件工具（Write / apply_patch）写成 UTF-8 文件，再把路径传给程序。
- 临时文件放 `.runtime/tmp/`（办公室内）。`/tmp` 现在可用：`D:\tmp` 是指向系统临时目录的链接，bash 的 `/tmp/x` 和 Node 的 `/tmp/x` 是同一个文件。如果 `D:\tmp` 又消失，Node 读 `/tmp/...` 会报 `ENOENT D:\tmp\...`，改用 `D:/…` 绝对路径。
- 脚本写成 `.mjs`，用 `import`；`.js` 里写 `require` 会报 `require is not defined`。
- 从 `/d/...` 风格路径传给 Node 时，Node 要的是 `D:/...`；放进 JSON 或文件内容里的路径一律写 `D:/...`。
- node 脚本把进度写到 stderr（例如 `api-screen.mjs` 的“补引文 1 条”）时，pwsh 会记成 `NativeCommandError` 并给退出码 1，脚本自己的 JSON 里却可能写着 `complete:true`。判断成败看输出 JSON 的 `complete`/`saved` 字段，别只看退出码。

## Codex（PowerShell 5.1，固定 -NoProfile）
- 不支持 `<<` heredoc，也不支持 `node -` 加管道传脚本，会直接报 `Missing file specification after redirection operator`。
- 管道到原生程序的文字默认是 ASCII，中文会变成 `?`。需要管道时，同一命令先设 `$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`；更稳的是写文件。
- 读 UTF-8 文件用 `Get-Content -Encoding UTF8`，否则中文乱码。
- 文献脚本（`reader-work.mjs append/mark`）：把 JSON 写进任务的 `chunk_file`，再 `append TASK chunk_file`；不要用 `-`（stdin）。

## Claude（Git Bash）
- `sleep N` 会被拦截。等后台任务用 `run_in_background`，或 Monitor 加 until 循环。
- `rm` 带通配或系统路径会被安全检查拒绝：删具体文件，路径写全。
- 大文件 Read 超 token 上限会失败：先 `offset/limit` 分段，或让程序先筛。

## 文献校验器
`records.mjs` 一次列出该条记录的全部问题，`append` 汇总整批；看到“整批未保存”时，按列出的每条原因一次改完再提交，不要逐条重试。
