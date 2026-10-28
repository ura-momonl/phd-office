# 浏览器与 Windows 账号锁定

（自 AGENTS.md 原样迁出，2026-10-23；AGENTS.md 只留入口行。）

- 本项目的 Edge 自动化（含临时 UI 验收、头像脚本）统一用 `automation/browser-launch.mjs` 的 `launchEdge()`，不要直接 `chromium.launch()`。它把 `AutofillAiWalletPrivatePasses` 与 Playwright 默认及调用方的 `--disable-features` 合并，保留其他参数；`--browser-safety` 测试会核对实际 Edge 进程只收到一个合并后的 switch，Playwright 升级后跑它。
- 受控复测：`node scripts/run-tests.mjs --browser-safety --keep`（脱敏副本、仅 2 次 Edge 启动）。- 用户已确认管理员日志不再新增 kemono 的 4625／4740，启动 Edge 前后不必核查 Windows 安全日志，也不用在汇报里列为“没验证”；仅当用户再次提到账号被锁或登录异常时才查。
- 此修复只覆盖本项目启动入口；用户级 WebView2 策略此前写入失败，尚未生效，应用须另行授权。不关闭账号保护、不删除浏览器配置。
- 不用 App 工具新建 Edge 实例；已有窗口按任务操作，不盲目反复登录。

