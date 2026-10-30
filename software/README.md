# 软件资产与操作入口

软件资产目录由 **Codex 维护、接手软件操作任务**。不重新造 MCP，不扫描个人配置或凭据，不自动探测、启动软件、轮询或调用额外模型。Computer Use 与显式按需的 DeepSeek Harness 委派是 Codex / Claude 共享能力，Office 文件技能等也不因此禁用。DeepSeek 的入口、API 计费和权限边界见 `deepseek-harness/README.md`，不作为第三位聊天助手。

## 发现与详情

DSH 已获用户批准的只读版本检测是上述「不自动探测」的例外：复用办公室后端节拍每 24 小时检测 latest / next 并在收件箱提醒，不自动安装或调用模型。入口 `node automation/run.mjs deepseek updates`；配置与结果见 `deepseek-harness/README.md`。

在 `D:/Main/assistant` 运行（也可用入口绝对路径）：

```powershell
node automation/run.mjs software list
node automation/run.mjs software show fusion
node automation/run.mjs software list full
```

`list` 每项一行，给出操作者、唤起目录、连接器、启动前提、可执行文件存在性和验证结果；`show <id>` 按需读取完整路线。`list full` 保留原来的完整 JSON 列表（含 `executable_present`）。`software plan <请求JSON文件>` 仍只生成计划，不执行，格式 `{ "app":"fusion", "goal":"明确目标", "inputs":[], "outputs":[] }`。

事实只登记在 `catalog.json`：

- `operator`：任务交给谁执行；本次按用户决定设为 Codex，Computer Use 保留两位共享。旧 `owner` 保留原维护/责任记录，不据它推断连接器可用。
- `working_directory`：唤起/脚本上下文，唯一目录字段，不另设同义 `invoke_in`。输入输出须用绝对路径，不搬动原工程。
- `connector` / `route` / `requires_running`：登记的连接入口、路线与前提，不代表本会话已加载工具或软件已启动。没有 `connector` 不等于存在 MCP，详读 `route`。
- `verified_at`：有直接证据的成功能力检查时间，没有则为 `null`。成功范围以 `verification.scope` 为准；只读查询成功不等于编辑、保存、仿真都可用，也不保证下次在线。
- `verification`：最近实际检查的 `checked_at`、`result`、`scope`、`source`。检查失败或只看到工具缺席，不填成功时间。本次未检查的条目不追认旧 `status`。`status` 为历史描述，绝不是实时状态；`executable_present` 也仅说明文件存在。

## Claude 怎样交给 Codex

不调用 `agent work/ask`，也不用让用户另开会话。普通办公室对话另起一行：

```text
@Codex 请用 AutoCAD 完成【目标】。working_directory=D:/cad-ai；输入【绝对路径】；输出【绝对路径】；约束【保留活动图纸及未保存修改等】。
```

必须写目标软件英文名 `AutoCAD` / `Fusion` / `Altium`，一次交接尽量只写目标软件，不把无关软件名带进来。`working_directory=...` 是交接资料，不是程序解析的任意 cwd 参数。

已核对本机代码 `agent/codex.mjs` 的 `codexLaunch` 和 `invokeCodex`：

1. work 轮从当前请求中匹配上述英文名，取 catalog 的 `working_directory`，以此为 Codex app-server 的进程 cwd；不是运行中 `cd` 后就热加载 MCP。
2. 多软件同时提及时优先 Fusion 目录，其余已知 CAD 服务器通过启动参数启用。目录不存在则回到办公室根目录、尝试显式启用服务器；这不保证工具可用，应报告缺失前提。
3. cwd 或连接器启动配置改变会使续接签名改变，创建新的原生 thread；ask 轮不会据软件名切目录或启用 CAD 连接器。
4. 目前只有这三种 CAD 软件有自动选目录逻辑。其他软件仍在办公室上下文按 `route` 使用指定脚本/CLI/UI；COMSOL 的 `D:/comsol-ai`、Rescript 的 `D:/Zoom-recordings` 不会因写了路径便自动变成 Codex cwd。若任务确需该目录专属 MCP，而当前未挂载，明确让用户在对应目录开启新 Codex 会话；不要声称现有机制已覆盖全部软件。

目录路由按请求里出现的软件名匹配，不是精确的任务语义判定。各软件当前是否可用以 `software list` 的 `verification` 为准，不以本文或旧 `status` 为准。测试：`node scripts/run-tests.mjs --software`（不检查真实应用在线，不启动软件或模型）。

## Transport Workbench

大师兄的输运分析程序由 Codex 操作与维护，软件本体保留在 `D:/Main/transport-workbench-mcp/`。`software show transport-workbench` 查看登记；[调用入口和示例](transport-workbench/README.md) 使用官方 MCP SDK 按需启动原服务，不要求修改助手个人配置。

## 操作底线

先检查当前工具与应用，再核对活动文档，保留未保存修改；没有打开或文档不匹配就说明条件，不悄悄新建空白工程替代。前台鼠标键盘先告知用户且同一时刻只一位助手控制。COMSOL MPh 为独立后端，不接管桌面模型；Origin 外部 Python 版本需匹配；LabVIEW 必须先核对实际 VI、设备和参数。输出留在项目交付目录或原工程明确的输出位置。

上游资料：[COMSOL batch](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_installation.02.043.html)、[Origin 官方 Python 示例](https://github.com/originlab/Python-Samples)、[MATLAB Windows 命令](https://www.mathworks.com/help/matlab/ref/matlabwindows.html)。
