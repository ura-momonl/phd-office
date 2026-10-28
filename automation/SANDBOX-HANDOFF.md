# 可复用沙箱：实施交接

日期：2026-10-15（America/Chicago）  
工作目录：`D:/Main/assistant`  
状态：独立命令沙箱和受控 agent 容器桥接已接入（见 0.1）；日常助手仍走原生工具。日常权限实测与已通过新会话验收的窄规则见 0.2。宿主图片读取缺口仍在，不能称为完整 agent 隔离。

## 0. 本轮接手结果（当前入口）

已选定并验证的路线：**外部 PowerShell → `sandbox/run.mjs` → 本机 Docker Desktop Linux 容器**。不依赖 Workbench，不修改全局 Codex 配置；保留原有日常工具。不是将原生 Windows elevated 的读取限制静默放宽。

```powershell
cd D:\Main\assistant
# Docker 未运行时：docker desktop start --timeout 45
# 运行时已构建；以后需要重建时：node sandbox/run.mjs build
node sandbox/run.mjs run sandbox/examples/task.json
$LASTEXITCODE
```

任务只声明输入目录、容器内命令 argv 和超时。输入副本只读挂载到 `/input`，全新输出目录挂载到 `/work`；任务禁网、非 root、不继承宿主环境变量，不挂载宿主盘或工具接口。包含 Node 24 和 Python 3.11。结果、日志、退出码和本轮容器身份保存在 `.runtime/sandbox/jobs/<UUID>/`，停止方式为 `node sandbox/run.mjs stop <UUID>`。完整用法、资源限制及失败诊断见 [`sandbox/README.md`](../sandbox/README.md)。

已验证：虚构统计任务产出 count=4、sum=17，并由 Python 启动 Node；宿主已知假秘密不可读写、输入与运行时只读、跨目录链接不可到达宿主、Windows junction 输入被拒绝、宿主环境变量不继承、外网与宿主网关不可连接；首次、第二次、命令失败后的新任务、超时及手动停止均按预期工作，没有遗留本轮容器。

验收命令：`node scripts/run-tests.mjs --sandbox --keep`，按正常工具审批使用脱敏隔离副本。最终结果与隔离副本路径写在 `.runtime/sandbox-probes/20261015/validation.json`，逐项实际结果保存在同目录 `container-acceptance.json`。原生后端的对照结果在 `native-results.json`。

**本轮没有接入或调用模型，没有进行邮件回放，没有发送邮件，没有接回 Workbench。** 当前宿主助手的其他上下文和工具仍在宿主上；调用一条容器命令不等于整个 agent 已被隔离。Docker Desktop 本轮已启动，专用镜像已构建；这是宿主状态变化，不能写成“系统未动”。

## 0.2 2026-10-15 18:22 CDT：Codex 日常权限实测

**做了什么：** 修复 `sandbox/sandbox.test.mjs` 两个会话测试的失败清理：断言失败时也关闭桥接 stdin，避免失败后测试进程不退出。更新 AGENTS.md 中“子进程必被拦”的历史前提，同时保留已验证的正常审批路径。经用户具体批准后，新增独立用户级规则 `~/.codex/rules/office-tests.rules`，不改 config.toml 或其他规则。

**验证了什么：** 默认权限的模块 help、Node→Node/Python 均成功；默认权限 `--browser-safety --keep` 21/21。正常工具授权的 `--mail --keep` 170/170；清理修复后 `--sandbox --keep` 7/7。默认权限 Docker 无法读取用户 `.docker` 配置，不能称为免授权可用；修复后这个失败用例在约 1.6 秒结束，4/7 通过、3/7 失败，明确保留失败而非跳过。修复前同一权限失败后不退出，270 秒后精确核对 PID、创建时间和隔离副本路径，停止本轮测试子进程树才写出日志。

默认权限的 `--mail` 也出现多条断言失败并未退出，249 秒后同样只停止本轮子进程树；尚未定位各断言根因，不能归为 `spawn EPERM`，也不能称为通过。正常审批路径 170/170 是对照证据，不是默认路径通过。

**窄规则已完成（18:25 CDT）：** 初次写入被自动审批以“缺少具体持久设置的明确批准”拒绝，未绕过。向用户说明具体命令及宿主权限影响后，用户回复“我批准所有”；重新走正常审批才创建规则。仅允许绝对路径 `node D:/Main/assistant/scripts/run-tests.mjs --sandbox …`，不匹配任意 Node、邮件动作或 `--mail`。规则语义及启动加载方式见 [官方说明](https://developers.openai.com/codex/rules)。

当前旧会话没有热加载新规则，绝对路径默认调用仍被 Docker 配置权限拒绝（约 1.6 秒退出），不能把它记成通过。随后用一次全新 Codex CLI 会话做真实入口验收：原始 `custom_tool_call` 明确提交 `sandbox_permissions:"use_default"`、只有一条测试命令及后续轮询，无提权请求、无重试，**7/7 通过**。新会话 ID `01a141e1-92c0-7073-996a-5aa1d5abd2aa`，记录在 `fresh-rule-probe.events.jsonl`；测试日志在临时副本 `phd-tests-EbsZ0S`。复用时请使用上述绝对路径；旧会话继续正常工具审批即可，不必为此中断现有工作。

**尚未证明：** 原生 setup refresh 文件锁本轮未出现，不代表根治；Claude 当前轮未重测；默认权限的邮件测试根因未定位，继续使用已通过 170/170 的正常工具审批路径。

本轮只有一次有明确目的的新会话模型验收，未访问真实邮箱或修改邮件代码；首次 CLI 参数互斥报错发生在模型提交前，仅修正重复的 --sandbox 参数后提交一次。另一位 agent 可并行处理邮件问题，避免同时编辑 AGENTS.md、本文及 sandbox 测试。完整命令、保留副本与结果：`.runtime/sandbox-probes/20261015/daily-work-validation-codex.json`。

## 0.1 2026-10-15 晚：agent 通过容器工具干活（已通，邮件回放已跑）

用户的目标是“大家不被沙箱卡”，邮件质量验收是当前最大阻塞。采用的路线：**模型和认证留在宿主，Codex 内置 shell 关闭，唯一工具是 `sandbox/mcp.mjs` 暴露的 `sandbox_exec`（离线容器）**。说明与已知缺口见 [`sandbox/README.md`](../sandbox/README.md)“会话桥接”。

- 探针（真模型、已知金丝雀）：无 shell；宿主金丝雀不可读（`view_image` 对文本返回“非图片”，不是权限拒绝，**不排除它读宿主图片**）；`apply_patch` 写宿主被只读沙箱拒绝；容器内断网、`/input` 只读、环境无 KEY/TOKEN。证据：`.runtime/acceptance/codex-only-mail-20261015-r2/probe*/`、`codex-output-probe.md`。
- 回放：`node run-sandboxed.mjs replay`（同目录，已提交一次，`model-submitted-replay.json` 阻止自动重跑），4 次容器调用，输出 `codex-output-replay.md`；提示词里的 arena 路径换成 `/input`（`replay-prompt-rewrite.json` 为空表示无遗留宿主路径），PROFILE.md 复制进了 arena 根。**这是一次样本，只说明路径能跑通，不是质量结论**；与用户回信的对照另做。
- 桥接被宿主强杀时不会自己清理：下一个会话启动时按 `result.json` 里的 pid 清扫已死会话的容器；`sleep 3600` 兜底；手动 `node sandbox/run.mjs stop <UUID>`。测试 `--sandbox` 现为 7/7（含会话桥接和强杀清扫）。
- 未做：把日常 Codex/Workbench 接回；日常的审批/`spawn EPERM` 不属于本沙箱。`features.code_mode_host=false`、`tools.view_image=false`、`include_apply_patch_tool=false` 在 0.163.0 上分别会破坏 MCP 或无效，别再试。

## 1. 用户真正要的结果

一个**有复用价值的沙箱**，能承载不同科研办公室任务及其测试，而不是仅让这封邮件回放通过，也不是依赖关闭工具、放宽权限的临时绕行。

用户最新提出“不开 workbench，在外面跑”。首轮验收应优先从**外部 PowerShell 的独立入口**完成，Workbench 保持关闭，先排除它的启动继承影响。独立入口通过后再考虑 Workbench 接入，不把入口绑定在 dashboard 的运行周期上。

注意：外部运行本身不提供隔离，也不保证消除占用。外部 Codex 若继承相同的全局 MCP 配置，仍可能启动同一个 Node REPL；严格读取白名单是否可用也与 Workbench 是否打开无关。

上一轮只要求整理交接文件，未继续实施。本轮用户要求接手续做，并明确将范围定为可复用命令沙箱；agent 接入留待下一步。后续仍须遵守工具审批、管理员安装和对外动作的边界，不将旧授权当作任意系统改动的永久许可。

## 2. 当前事实与两个独立故障

### A. 历史运行时刷新故障；本轮新版入口未复现

本轮实际 CLI 为 `0.163.0`，全局配置仍为 elevated。未发现 `node automation/run.mjs dashboard serve`，但 Codex 桌面守护进程仍运行同路径 Node REPL。普通读取和独立原生 workspace 假数据命令成功，日志中的相关 setup refresh 返回 `errors=[]`。这说明本轮可运行，尚不能据此认定旧版文件锁机制已被根治。以下为上一轮 `0.162.0` 的历史证据：

- 上一轮 Codex CLI 为 `0.162.0`。
- 用户在外部终端运行官方安装接口后，结果于 `2026-10-15T22:14:24Z` 返回 `mode=elevated, success=true`。
- 最近实际读取的 `C:/Users/24193/.codex/config.toml` 是 `[windows] sandbox = "elevated"`。不要再沿用旧摘要里的 unelevated 状态。
- 重新进入 agent 后，普通命令启动出现 `helper_unknown_error: setup refresh had errors`；有一次连读取命令都未能启动。
- 沙箱日志的具体原因是更新下面文件的运行时读取/执行 ACL 时遇到 Windows 错误 32（文件正被使用）：

  `C:/Users/24193/AppData/Local/OpenAI/Codex/runtimes/cua_node/84464046935436b8/bin/node_repl.exe`

- 已查询到实际进程链：`node automation/run.mjs dashboard serve → node（Codex CLI 包装层）→ codex.exe → node_repl.exe`。Workbench 启动代码未隔离全局 MCP 配置；Node REPL 的命令来自用户级 Codex 配置。
- 因此证据支持“Workbench 启动的 Codex 辅助进程参与了文件占用冲突”，不是简单的外部应用未关闭。尚未采集系统句柄表或修改上游代码；不要把具体 Windows 打开文件参数、所有占用来源或根本修复机制说成已证实。

### B. elevated 不满足本次严格读取白名单

本轮 `0.163.0` 独立探针仍在执行前返回 `elevated Windows sandbox requires effective :root read access`，没有创建预期输出。因此本轮命令沙箱选择 Docker Linux 隔离，不继续尝试用 elevated 承担严格读取白名单。原生 workspace 探针能读写工作目录、也能读取目录外假文件，只能证明日常工作能力，不算干净验收通过。

- 一次独立假数据探针要求：`:minimal` 运行环境及指定目录可读、禁止写入、禁止读取目录外的假参考文件、禁网。
- 它在命令执行前被拒绝：`windows sandbox: elevated Windows sandbox requires effective :root read access`。
- 更早的 unelevated 模式拒绝同类读取分区策略：`cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed`。
- 这不是模型答错，也不是探针断言失败，而是后端不支持该策略。即使彻底解决 A，也不能据此声称 B 已解决。
- 先前助手认为“换成 elevated 就足够”，已被实测推翻。

### 其他已知状态

- 官方 MXC 一次性能力探测返回：`native MXC is unavailable on this executor`，退出码 1；没有更改保存的沙箱模式。当前不能把 MXC 当成可用路线。
- 有一次普通 workspace profile 的假数据命令也因 A 的刷新错误退出，预期写入文件未创建；不能据此推断所有已预配目录永久不可用。
- 上一轮排查未调用模型回放、发送邮件或修改生产源代码；本轮新增了 `sandbox/` 命令沙箱与专用测试入口，同样未调用模型、发送邮件或修改用户科研原始资料。
- 已安装系统级沙箱账户/隔离规则，不是“系统完全未动”。全局配置备份位于原 config.toml 旁，具体路径见安装结果 JSON。
- 只结束过一个路径及创建时间均匹配的当前轮 Node REPL。其他进程因身份无法充分核实未结束。不要复用历史 PID 杀进程。

## 3. 复用边界：实现前必须明确

本节保留整体目标；本轮交付仅为第 0 节的离线 Linux 命令沙箱，不承诺表中完整 agent、联网或 Windows GUI 能力。

保持一个可解释的启动与权限入口。最小交付是可在外部终端启动、检查结果、结束后再次使用的完整路径；不要求先建设通用平台、调度器或虚拟机集群。

至少区分两种真实需要，不能让日常工作能力受单个测试的要求绑架：

| 用途 | 必须具备的能力与约束 |
| --- | --- |
| 日常工作 | 在声明的工作目录内读写；启动所需 Node/Python 等子进程；目录外写入需显式授权；网络及工具按任务授权使用。 |
| 干净验收 | 只读本次输入及必要系统/运行时资料；不能读取宿主对话、记忆、参考答案和不相关项目资料；默认无对外发送、桌面控制及网络能力。 |

具体入口形式、后端和协议尚未确定；不要把这张表直接变成多层框架或大量配置开关。若一种后端无法承担两种用途，应如实划定能力，而不是悄悄降级权限或假装实现。

必要边界：

- **隔离不是复制目录。** 脱敏副本防止改坏真实数据，但不能单独防止读取宿主参考答案、访问宿主凭据或通过 MCP 操作宿主。
- 输入、可写输出、必要运行时、网络和外部工具必须有明确允许范围；凭据不出现在交接、日志和版本库中。
- MCP、桌面、浏览器、邮箱等若运行在沙箱外，必须作为显式授权通道处理，不能把其白名单当成已被文件系统沙箱隔离。
- 保留日常任务确实需要的能力。Node REPL 与 Browser 的用途尚未完整核实，不能为了通过一个测试就永久关闭浏览器、桌面或所有 MCP。验收禁用对外工具与日常保留必要工具不是同一件事。
- 关闭、失败与重用时只清理本次拥有的进程和临时资料；保留失败证据，不删除用户原件，不波及其他会话。无需为了修复文件锁而反复要求用户关闭/重启整台机器。

## 4. 下一步：独立 agent 接入（本轮未实施）

1. **承接已验证入口。** 先读 `sandbox/README.md` 和本轮结果；环境或代码未变时不重复安装、构建或复测旧故障，不复用历史 PID。
2. **明确 agent 的完整边界。** 模型上下文、文件工具、MCP、浏览器、桌面和模型服务认证分别由谁提供，哪些通道允许使用，须在实际启动路径中落实。不能只将 shell 放进容器，就宣称宿主历史、凭据及其他工具都被隔离。
3. **选择一条实际可验证的 agent 路线。** Docker 命令后端已可用；agent 的入口、认证与工具协议尚未确定。用假输入及已存在的宿主假秘密先做窄路径验证，凭据不进入任务输入或日志。不要直接将现有全局 Codex home 挂入容器。
4. **完成独立 agent 验收。** 首次、第二次和失败后新任务均验证工具可用与限制生效；有明确目的才调用模型，不增加自动重试或常驻轮询。原邮件验收输入与参考继续分离，不用本轮命令测试代替回答质量验证。
5. **再决定是否接回 Workbench。** 用户决定接入后才修改其启动路径；调用同一套已验证能力，并使用新代码进程验收。

禁止把以下方法称为修复：关闭沙箱、全盘可读以通过干净验收、改为 full access、移除原本需要的能力、删掉预检或失败断言、隐藏未运行状态、在权限审批拒绝后换壳执行。

## 5. 完成标准：用实际结果验收

不要以配置字段、安装成功、目录存在或模型说“完成”为验收依据。

- **外部可运行：** 不开 Workbench，也能从文档化入口执行一个假数据任务，得到可检查的输出和退出状态。
- **正常能力成立：** 指定输入可读、指定输出可写、所需子进程可启动。若承诺浏览器/桌面/网络能力，按对应真实授权边界验证，不用纯文件探针代替。
- **限制成立：** 不允许的读取/写入确实失败；使用已存在且内容已知的假秘密文件，排除“文件不存在所以读不到”的假通过。至少覆盖目录外文件及指向目录外的链接/重解析路径。
- **验收不泄漏：** 干净任务取不到宿主参考答案、历史对话或凭据；禁用的网络/工具确实不可用，不只检查配置。不要声称覆盖了未测试的通道。
- **可复用：** 同一次安装下，首次、第二次和失败后的新任务均能运行；不同任务的私有输入不互相可见，不要求每轮管理员重装或人工杀进程。复用不等于继承脏上下文。
- **生命周期正确：** 结束后没有本次遗留的不可控进程；必要运行时不会因其正常运行而让后续任务持续刷新失败。
- **接收者能用：** 新接手者仅凭文档能知道启动命令、授权边界、输入输出、结果位置、失败诊断与停止方式，不需要回看本次长对话。

验证报告分开写“做了什么、验证了什么、没验证什么”，区分未进入测试逻辑的权限/能力失败与真正执行后的断言失败。

涉及本项目代码的测试仍按 `AGENTS.md` 使用 `node scripts/run-tests.mjs` 的脱敏隔离副本与正常授权；不要为了方便在真实数据目录运行会改数据的测试。纯沙箱能力探针使用自己新建的假资料。

## 6. 证据入口与历史脚本

以下路径均相对 `D:/Main/assistant`，用户级日志除外：

| 路径 | 用途 / 限制 |
| --- | --- |
| `sandbox/run.mjs`、`sandbox/README.md` | 当前独立命令沙箱及使用说明；只支持本机 Docker Desktop Linux 引擎、离线任务。 |
| `sandbox/Dockerfile`、`sandbox/.dockerignore` | Node/Python 运行时；基础镜像固定 digest，构建上下文只含 Dockerfile。 |
| `sandbox/examples/task.json`、`sandbox/examples/input/` | 无真实资料的可运行示例。 |
| `sandbox/sandbox.test.mjs`、`scripts/run-tests.mjs --sandbox --keep` | 专用真机验收；在脱敏副本里运行，不隐式加入默认完整测试。 |
| `.runtime/sandbox-probes/20261015/` | 本轮原生对照、容器逐项验收与最终验证索引；`protocol/` 仅为本轮调研时生成的 CLI 类型，不是运行依赖。 |
| `agent/codex.mjs` | `codexLaunch` 与 app-server 启动、权限参数；目前未为本任务修改。 |
| `C:/Users/24193/.codex/config.toml` | 全局配置；包含桌面工具运行时配置，不应整本复制进项目。 |
| `C:/Users/24193/.codex/.sandbox/sandbox.2026-10-15.log` | 运行时 ACL、错误 32 和 setup refresh 的实际诊断；按时间取必要片段。 |
| `.runtime/agent/runs/74030b57-ca5c-4a76-b8ca-a62b0edf48e1/sandbox-setup-result.json` | 用户外部安装最终成功的机器可读结果。 |
| 同目录 `sandbox-boundary-result.json` | elevated 拒绝严格读取白名单的实际结果。 |
| 同目录 `sandbox-setup-first-failure.json`、`repl-release-result.json`、`repl-process-details.json` | 更早失败及进程处置证据；不得把历史进程号当当前操作目标。 |
| 同目录 `RESUME.md` | 排障历史；含明确标为被后续结果取代的旧段落，不是当前配置的权威来源。 |
| 同目录 `setup-sandbox.mjs` | 调官方 `windowsSandbox/setupStart` 的临时安装客户端，不调用模型；不是可复用沙箱产品入口，不要再无条件运行。 |
| 同目录 `check-sandbox.mjs` | 最小读取白名单探针；目前结果是后端拒绝，不是已通过。 |
| `.runtime/acceptance/codex-only-mail-20261015-r2` | 原邮件验收输入与失败记录；参考答案在 arena 外。保持输入与参考分离，不能因排障污染测试集。 |

进程链与 MXC 探测的原始工具输出在本对话任务 `3a50d068-cef9-4d12-9630-c6b853290cc7` 的运行记录中。必要时用 `agent show` 定位原文；不要以助手旧摘要替代实际输出。

官方背景：[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。官方文档说明不同后端及其探测方法；本机是否可用以以上实际结果为准，不把文档描述当成本机验收结果。

## 7. 此次交接的边界

已完成：用户本轮要求的可复用命令沙箱、外部独立入口、只读输入及独立输出、Node/Python 子进程、实际读取/写入/网络限制、连续复用、失败/超时/停止后的清理、使用说明与验证索引。  
未完成且不在本轮范围：独立 agent 上下文与工具隔离、Workbench 接入、邮件回答质量验收；旧版原生运行时 ACL 文件锁的根本修复也没有得到证明。  
下一步：等待用户开启 agent 接入任务后，按第 4 节选择并验证完整路径。无需为了继续本轮已完成的命令任务而安装原生后端、关闭用户工具或重新运行邮件测试。
