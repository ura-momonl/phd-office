# DeepSeek 正式聊天与 Harness 按需委派

办公室通用系统提示词由三位助手共用 `prompts/office-system.md`。正式聊天的 `chat.py` 每轮从该文件生成 `office-system.patch.json`，以原生 `system-prompt.config.personaPrefix` 加载；work / ask 都使用它，ask 继续叠加自己的无工具配置。`chat.patch.yml` 只保留 Harness 行为配置，不另抄提示词正文。

## 当前运行时与包内补丁

本机 npm 运行时为 **0.2.1-rc.4**（next 通道），主依赖固定该版本。运行中追加、小鱼独立 `effort` 和工具说明三处本地补丁仍保留；当前三份官方原文件备份均为各包 `lib/index.js.orig-20261026-rc4`。正式聊天每轮 fresh 启动，下一次调用即使用新版，无需重启办公室后端。安装与验证实据见 [`codex-c9d68cd7.md`](../../logs/2026-10-26/codex-c9d68cd7.md)；历史补丁原理及真机结果保留在下文。

## 输入／输出统计修正（2026-10-26）

`token_usage.py` 从本次原生 session 及已登记的子助手事件汇总；以 session ID 和事件序号去重，不混入同一轨迹文件里其他调用。总输入＝非缓存输入＋缓存读＋缓存写，总输出直接取原生 outputTokens。失败、缺少用量事件或压缩使统计不完整时保留已观测值，`usage_partial:true` 表示下界；无观测值仍为 null。两条 JS 入口保留这个区别，完整用量的速率口径不变。

额度与消耗页分列总输入（含缓存）、总输出及原有非缓存指标；部分记录进入合计并明确标注。历史账本此次按原始轨迹校正76条，已观测输入891143835、缓存864186240、输出7525148；未估算未知用量、未重跑模型。备份和逐条差异在 `.runtime/agent/runs/b4772363-8138-48cf-80d5-3f3ec6a790c0/`。页面刷新可读取修正后的历史；新的 JS 入口需后端空闲重载，不打断正在运行的助手。

## Command Code GOAT 通道（2026-10-25）

V4.1 Flash 普通／Fast 在 `connection.py` 声明 `input: ["text", "image"]`，原生 `read_image` 可把本地图片交给模型；旧型号的能力声明不变。每轮新建原生进程时生成配置，因此此处修改在下一轮 DeepSeek 调用生效，无需重启办公室后端；已运行的轮次仍沿用启动时配置。

**2026-10-27 流式断连重试：** Command Code 在长流式响应和大上下文上会中途断开（pi-ai 报 `terminated` / `Request timed out`，都归为 `TRANSPORT`／`TIMEOUT`），而此前 `chat.patch.yml` 关掉了 `llm-retry`、`connection.py` 又写死 `maxRetries: 0`，这类失败直接结束整轮。现在 `connection.py` 的 `office-commandcode` 带 `mode: normal`、`maxRetries: 3`、`backoff` 1 秒起、上限 10 秒；`chat.patch.yml` 挂载 `llm-retry`。执行器只在失败步骤上重跑（同一轮、同一份历史，模型看不到失败与等待），成功轮不重发、首字与吞吐不变；每多一次尝试会重复计一次输入 token。官方通道切回后按 `dsh-llm-deepseek` 自己的策略，无需另改。诊断与统计见 [`deepseek-3f2913f2.md`](../../logs/2026-10-27/deepseek-3f2913f2.md)。

**2026-10-26 连接超时修复：** 本机 Node 24 的默认双栈地址竞速只给每个地址250ms，实测约400ms的有效IPv4握手会被提前放弃，最后报连接超时。`connection.py` 为 Command Code 运行进程及其子工具设置 `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1500`，保留IPv6，不改模型、计费通道、并行数或重试次数；下一轮原生进程即生效，无需重启后端。并列六次真实连接对照：默认6次超时，1500ms和仅IPv4各6次成功；现场与任务续接记录在 `output/literature-rebuild-20261021/formal-start-20261025/connection-recovery-20261026/`。

当前已选择 Command Code；`node automation/run.mjs deepseek provider` 查看通道，`provider official` 可切回官方，`provider commandcode` 切回套餐。切换不发请求、不覆盖密钥；失败不自动转到另一家收费。Key 独立在 `.runtime/commandcode/credentials.json`，字段 `api_key` 和固定 `base_url: https://api.commandcode.ai/provider/v1`。办公室电脑上普通点击该绝对路径链接会用记事本打开；网页预览／下载仍不提供密钥内容。

保留完整官方 Harness 和 SDK，不加代理服务器；每轮的 `connection.py` 配置层复用已安装的 `llm-pi-ai` 插件，走 Chat Completions。默认 `deepseek-flash` 映射为 `deepseek/deepseek-v4.1-flash`，原生工具、记忆、工作区和审批策略不变，推理强度保留 off / low / high / max，失败步骤按「流式断连重试（2026-10-27）」处理。实际模型与 transport 写入结果和用量记录。官方余额继续使用原官方 Key，提示中区分套餐额度，不新增额度查询或轮询。

**普通／Fast 与通道切换、额度（2026-10-25）：** `deepseek-flash`＝V4.1 Flash，`deepseek-flash-fast`＝V4.1 Flash Fast（仅 Command Code；官方通道直接报错）。设置 → 模型与推理里可改「DeepSeek 计费通道」和模型，也可 `provider` 命令切通道。官网价（非高峰，每百万 token）：普通 输入 $0.15／输出 $0.60／缓存读 $0.003；Fast 输入 $0.16／输出 $0.58／缓存读 $0.016。缓存命中率高的长对话里 Fast 的输入成本明显更高，只在需要速度时选。GOAT 套餐文档（commandcode.ai/docs/plans/goat，2026-10-25 读取）的单模型月额度：V4.1 Flash $80（约 20.5 万次请求／月）、V4.1 Flash Fast $60（约 5.75 万次）、V4 Flash $60、V4 Pro $20；基础月额度 $70，5 小时 $14、每周 $35 的窗口上限对所有模型相同。官网定价页另写 GOAT 为 $70／$80，各页未完全统一，以账户 `/usage` 实际扣减为准。顶栏在 Command Code 通道显示套餐窗口剩余（5 小时上限 $14、每周 $35，GOAT），来自 `/alpha/billing/credits`（只读，非公开文档接口，格式变了会显示不可用并保留上次读数）。

**速度实测与「off」修正（2026-10-25）：** Command Code 上办公室的推理强度 `off` 原先没有关掉思考：pi-ai 对 off 什么都不发，而 Command Code 只认 `reasoning_effort:"off"`（`thinking:{type:"disabled"}` 被忽略），模型照样在后台推理，输出多出一倍以上、变慢。现在 `connection.py` 把办公室的 off 以备用档 `minimal`（线上值 off）发出，`wire_effort` 负责转换，low／high／max 与官方通道不变。真机：同一篇约 1200 字短文，输出由 1200–2800 token 降到 740–1010 token。

同一 prompt 流式直连、三条路都真正关闭思考（各 4 次，中位数）：官方 deepseek-flash 首字 1.2 秒、约 122 tok/s、整篇 8.4 秒；Command Code 普通 V4.1 Flash 首字 2.7 秒、约 106 tok/s、整篇 10.4 秒；Command Code Fast 首字 1.6 秒、约 117 tok/s、整篇 8.1 秒。结论：Command Code 不比官方快，Fast 与官方相当，普通版略慢；样本小、波动大。原始数据 `.runtime/speedbench/`。

正式聊天适配器已真实完成中文文件写入／读回（2 次原生工具调用），返回缓存命中 27648 / 41914 输入 tokens；证据 `.runtime/agent/runs/adee9f92-b819-4cbb-80b0-199368b5b9f5/formal-chat-verified.json`。本地文件 7/7、SDK 接线 8/8、官方余额 3/3；浏览器凭据链接点击通过。扩大检查另遇手机布局高度断言失败，未修改布局；完整报告 `.runtime/test-results/2026-10-25T16-33-26-348Z-29040.json`。文件打开入口需后端空闲重载，本轮一次性部署状态在同目录 `activation.json`。

## 自动检测新版（2026-10-25）

用户已批准自动检测并提醒，不自动安装。办公室后端现有节拍每 24 小时查询一次 npm 官方 `dist-tags`，同时看 `latest` 与 `next`，只提示高于本机的版本，不追 `alpha`。发现新版时复用收件箱中的「DSH 发现新版」卡片；点「知道了」后同一候选版本不再重复提醒，「检查升级兼容性」才会发起一次用户请求的助手工作，不会直接安装。后台检测不调用模型、不起子进程或新定时器；失败保留上次成功结果并记录错误，下一天再检查。

`node automation/run.mjs deepseek updates` 立即检查；`deepseek status` 的 `updates` 字段读取缓存。状态在 `.runtime/deepseek-harness/updates.json`，`software/deepseek-harness/update-policy.json` 设 `enabled:false` 可停用自动检查。后端改动在空闲重载后加载。升级前仍需核对下文记载的运行中追加与小鱼推理强度三处 npm 包内补丁，检测器不修改它们、用户级 profile、权限或 SDK。

## 时间上下文（2026-10-25）

用户级 SDK profile 的 `C:/Users/24193/.dsh/profiles/sdk/cordis.patch.yml` 已加载官方 `@deepseek-ai/dsh-time-context`，配置 `timeZone: America/Chicago`。正式聊天每次新启动加载；首步注入当前本地时间、UTC 偏移和时区，后续沿用插件默认 10 分钟刷新间隔。未新增模型调用、轮询或后台任务。work / ask 的实际合成配置与夏令时结束前后的格式验证在 `.runtime/agent/runs/565c323a-c695-4ea5-883d-309169ffb4f9/time-context-verification.json`，原配置备份为同目录 `cordis.patch.before.yml`。

## 本人记忆维护工具（2026-10-25）

用户希望 DeepSeek 自己发起记忆回填和整理，不再让用户在终端代跑。正式聊天 work 轮加载本地原生插件 `memory-tool.mjs`，提供 `office_memory_maintain`。直接调用 `{action:"status"}`、`{action:"ingest",limit:1}`、`{action:"reflect"}`、`{action:"profile",maxCalls:1}` 或 `{action:"search",query:"要回溯的问题",maxRounds:1}`；owner 固定为 deepseek。ingest 还支持 since、facts；search 固定走既有 agentic 回溯，支持 topK、chars 和 maxRounds（1～3，默认3），模型失败不重试，降级结果与具体错误一起留档并向工具调用方报失败。普通关键词检索与读取继续用 CLI；需要模型的记忆操作使用本工具，不在受限 shell 内再起模型客户端。

这是用户授权的专用宿主能力，调用现有 memory2 CLI 和模型通道，不经过受限 shell 的孙进程通信；普通文件／shell 沙箱、其他助手权限、模型与计费配置不变，不提供任意命令、其他 owner 或模型参数入口。工具等待真实结果，域错误和进程失败均返回失败，不自动重跑；取消工具或结束宿主时停止本轮维护进程树。请求、stdout、stderr、result.json 留在本轮运行目录的 `memory-maintenance/<UUID>/`。每轮 fresh 加载，下一次 DeepSeek 工作轮即可发现，无需重启办公室后端。ask 与独立委派不加载此工具。

最初入口离线测试 **24/24**，报告 `.runtime/test-results/2026-10-25T07-48-00-510Z-24692.json`；原生注册和 schema 校验证据在 `.runtime/agent/runs/40785fe1-7e5c-4048-80fa-f85a8036dd0b/native-schema-verification.json`。随后 DeepSeek 正式工作轮已真实调用 status，`ok=true`，结果在 `.runtime/agent/runs/c5425728-2d91-44cb-852d-066df8e1dc92/2/memory-maintenance/e80b4eeb-e478-4b7e-bf8e-105ceb6f9d91/result.json`。

新增 search 入口、固定本人及参数校验、降级不冒充成功、失败原因透传的定向隔离回归 **34/34**，报告 `.runtime/test-results/2026-10-25T19-37-58-941Z-8340.json`。最初 SDK 初始化受限及自动审批拒绝的现场保留在 `.runtime/agent/runs/e763fec0-8afa-4319-910c-5da76db7610e/`。

用户明确同意资料内容和模型目的地后，经正常审批完成真实 DeepSeek→专用工具→既有 Codex 模型的验收：profile 一批成功（calls=1，cells_used=4，文件写回已观测），search 一轮成功（failed_rounds=0，返回3条）。正式 adapter 仅调用两次专用工具，无 shell 或子 agent；DeepSeek 走现有 Command Code 通道，普通沙箱未改。证据 `.runtime/agent/runs/bbd9d5d4-f12d-48fb-9103-ec5ecbc37928/native-verification/verification.json`，同目录保留实际任务、events 和两个维护结果。此次真实验收覆盖 profile 与 agentic，未另跑 ingest 或 reflect。

文献包入口已支持 `deepseek` owner：使用项目 `literature-backfill` skill，从 `node .agents/skills/literature-backfill/scripts/resume.mjs deepseek` 定位；本人在正式聊天中串行读块，复用题名、摘要、前缀保存、合并、内容核对和持锁提交，不走独立 Harness 委派、不启用子 agent。入口准备不调用模型、不自动分配包或入库；选文质量需通过实际试读判断。

2026-10-22 用户授权招募为第三位正式聊天同事：可直接 `@DeepSeek`，不点名时跟随上一位，行首点名可交给 Codex／Claude。`@all` 按三位依次发言，仍最多 10 轮，不自动群聊、不新增后台或定时调用。2026-10-21 的独立委派入口保留原有含义。

正式聊天走 `agent/deepseek.mjs` → `chat.py` → 官方 SDK，工作目录为办公室根目录，载入项目 AGENTS.md 和原生 skills，使用原生文件／shell 工具操作办公室模块。每轮 fresh，控制器提供完整对话原文；2026-10-23 接通 work 轮的运行中追加，每条输入直接提交同一原生 inbox，不等待上一条回执，原生 `agent/inbox/spliced` 确认后才记录送达。拒收、停止和配置不同保留独立排队，不自动重放。2026-10-23 夜修正：SDK 的 `session/prompt` 原本一律按“下一轮”排队，运行中追加要等整轮结束才被读到（一轮可跑十几分钟）；已在本地 npm 发行版 `.runtime/deepseek-harness/npm/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js` 的 `prompt()` 里改为：会话运行中用 `steer`（下一步边界读到），空闲时仍用 `followup`；原文件备份为同目录 `index.js.orig-20261023`。真机验证：6 次各 10 秒的串行工具调用，第 2 次调用后追加“最终回答必须带暗号青鱼”，消息以 `next-step` 入 inbox，约 10 秒后模型读到，同一轮的最终回答带上了暗号。该改动在 `.runtime` 里，重装或升级 npm 包会被覆盖，需照此重打。2026-10-24 同样方式给原生 workflow 的 `agent()` 加了 `effort` 选项（off / low / high / max；不写则继承这一轮的强度；`off` 即关闭思考，真机验证子 agent 请求头为 off、回复里没有推理块）：改 `dsh-workflow-ptc/lib/index.js`（脚本侧允许并转发该选项，共三处：允许集合、字符串类型检查、`readAgentOptions` 的返回对象；host 侧 `childRequest` 和创建子 agent 的 `agentOptions.reasoningEffort`），以及 `dsh-tool-workflow/lib/index.js` 的工具说明补一句；两处原文件备份为同目录 `index.js.orig-20261024`。真机验证：同一个 workflow 里 `effort:"low"` 和 `effort:"max"` 的两个子 agent，请求头里的 `reasoningEffort` 分别是 low 和 max（父级 high）。同样会被重装覆盖。独立记忆 owner 为 `deepseek`，可手动保存和检索，不增加被动记忆整理调用，也不复制 Claude 的私有记忆。模型由 `agent/config.json.deepseek_model` 或当前任务覆盖指定；余额按 API 实际消耗。

work 轮复用 `software/computer-use/mcp.json` 的 Windows-MCP 工具白名单，经原生 `dsh-mcp-client` 加载；实际合成配置保存在运行目录 `deepseek-mcp.patch.json`，ask 和独立委派不挂桌面工具。桌面操作仍遵循 `software/computer-use/README.md` 的共享前台约定。周计划新目标、周用量统计、普通文献回填任务和提示词首轮查看均支持 DeepSeek；原有任务不自动改执行者，Claude 入口和历史保留。

个人人设与 Codex／Claude 一样由用户级全局指令维护：`~/.dsh/AGENTS.md`（本机 `C:/Users/24193/.dsh/AGENTS.md`）。正式聊天使用 SDK 原生的用户级 `~/.dsh` home，由 `agent-instructions` 加载该文件；`chat.patch.yml` 只保留办公室通用工作要求。ask 和 Claude 的安全问答一样关闭指令发现，不加载全局人设；独立按需委派继续用任务自己的隔离 home，不受这次迁移影响。正式聊天的原生 home 状态在 `~/.dsh`，办公室请求、回调轨迹与结果仍保存在下述运行目录；每轮仍用独立 session ID，不恢复旧原生会话。

聊天轨迹、请求和结果留在 `.runtime/agent/runs/<任务ID>[/交接序号]/`：`deepseek-task.json`、`events.jsonl`、`deepseek-result.json`、`native-prompt.txt`。`chat.patch.yml` 保留 workspace-write、拒绝扩大权限，挂载 `llm-retry`（只在失败步骤上重跑，策略见上文），禁遥测及完整会话上传；四个独立 subagent 工具关闭，但正式聊天原生 workflow 的 `agent()` 已在 2026-10-23 运行 9bde487f 中实际启动并收回两条小鱼。独立 Harness 委派仍禁子 agent，文献包目前仍采用已准备的串行方式，这次显示接线不改变其工作方式。ask 调用另叠加 `ask.patch.yml` 关闭工具和指令发现。Windows 原生隔离边界仍见下文，不因成为同事而放开权限。

正式聊天的小鱼事件按原生 session ID 接入既有子 agent 计数、活动行和折叠卡片，显示标签、任务正文（原生提供时）、中途文字及完成／失败状态。子会话文字标记为子 agent，不进入办公室后续给三位同事的聊天历史；原生 workflow 自己向主助手交付最终结果的机制不变。主上下文条只使用根会话用量，小鱼工具调用用子会话 ID 区分，不与主助手或另一条鱼混写。不新增模型调用、采集轮询或自动重试。

推理强度单独读 `deepseek_reasoning_effort`（默认 high，可选 off / low / high / max），不把另一侧的 medium / xhigh 传给 DeepSeek。

2026-10-22 用户批准并已完成官方 `AclWriteGrant` 的工作区初始化（SID `S-1-4-766151334-226752175`），保留原有 owner、其他 ACL 和 workspace-write。证据：`.runtime/agent/runs/6536797d-06d0-40b8-aad8-ad88a0015b98/acl-initialization.json`，同目录 `acl-before.json` 保存原根目录 SDDL。官方工作区授权会跨会话保留 SID、目录删除约束和 Low 完整性标签。

Low 标签也会传播到工作区内的 venv Python 启动器；真机已确认它会让 SDK 宿主本身变成 Low，无法管理正常临时锁。Windows 两个入口现统一经 `python.mjs` 读取该 venv 的 `pyvenv.cfg.executable`，用同一基础 Python 和原 site-packages 启动 SDK；不改变模型的原生工具策略，不以管理员权限运行模型。普通 Windows 宿主的真实 adapter 已成功执行办公室 `help work`、写入并读回中文 JSON，返回预期结果，证据 `.runtime/agent/runs/1c7e7975-dba2-4da6-a363-86bf74a4caff/deepseek-system-python-verified/verified.json`。此修正 software 专项 27/27 通过。

真实后端重载与正式聊天报到由本次一次性续接完成；即时状态和运行/磁盘版本证据见 `.runtime/agent/runs/6536797d-06d0-40b8-aad8-ad88a0015b98/post-restart.json`。一次性续接只等当前工作结束后调用现有受控重启入口，再用 `agent handoff` 交给 DeepSeek 完成真实聊天工作轮，不增加常驻轮询或模型重试。

头像：`dashboard/avatars/deepseek.png`，用户 2026-10-21 提供的蓝发小女仆图，2026-10-22 应用户要求裁成脸部特写（256×256；原图备份在 `.runtime/avatar-edits/deepseek-original-20261022.png`），已登记在软件资产条目的 `avatar` 字段。用户也可在 设置 → 头像 上传自己的图覆盖它，出厂文件不受影响。聊天使用 `/avatars/deepseek.png`，输入框增加 `@DeepSeek` 按钮。

## 调用

顶部额度栏显示 DeepSeek 账户余额（按 API 返回币种，含赠金与充值余额），不换算成订阅百分比或重置时间。余额旁标注当前「峰值／谷值」，不显示更新时间行，悬停仍可看余额明细和成功查询时间；失败保留上次余额并标注。按[官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)的北京时间周一至周五 09:00–12:00、14:00–18:00 判峰值，其余时段、周末及中国法定节假日为谷值（半价）。节假日表当前覆盖 [2026 年国务院放假安排](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)，未覆盖年份在高峰候选时段标「时段待核」，避免把未知节假日误标为峰值。峰谷随现有页面轮询重新计算，不依赖余额查询时间。余额来自[官方只读接口](https://api-docs.deepseek.com/api/get-user-balance/)，复用现有约 10 分钟额度刷新和「更新额度」按钮，不调用模型、不新增定时器；凭据仍只从上述本机 credentials.json 读取。

从办公室根目录运行：

```powershell
node automation/run.mjs deepseek status
node automation/run.mjs deepseek prepare path/to/request.json
node automation/run.mjs deepseek run path/to/request.json
```

请求为 UTF-8 JSON；`prompt_file` 相对请求文件解析。任务正文也保存为 UTF-8 文件：

```json
{"prompt_file":"task.txt","model":"deepseek-flash","max_tokens":64000}
```

`model` 默认 `deepseek-flash`（2026-10-21 本账号 `/models` 已返回此名称），可显式指定账号支持的模型；`reasoning_effort` 可选，由所选模型校验。`max_tokens` 为每次模型请求的输出上限（推理也算在内），不是整项任务的总 token／费用限额；不填时用 `limits.mjs` 的 `DEEPSEEK_MAX_OUTPUT_TOKENS`（64000，官方单次上限 384K），正式聊天轮同样按这个值提交。2026-10-23 的文献试跑 701a83c1 正是被旧的 8192 卡在写选文 JSON 那一步，整轮判 max-tokens 失败；现在这种截断会返回中文原因并带上上限值，不重试。prepare 只读预览，不启动 SDK 或请求 API。

只传入这一份任务正文；不自动带入办公室历史、记忆、邮箱、项目资料或父目录指令／技能。需要的证据由委派者放进任务文件，外部材料不是指令。每项任务从空白工作目录及独立 Harness home 开始；原文件不作为工作目录。不提供自动恢复或自动重放。

2026-10-23 正式聊天出现过一次“召唤失败”：10:29:17 起的任务 892fdfbd 里，dsh 冷启动用了 31.7 秒，超过 SDK 默认的 30 秒 initialize 窗口（当时同在跑的 Claude、Codex 都正常，10:35 同一路径约 2 秒启动完成），那一刻还没有向模型发出请求、没有产生费用，现场见 `.runtime/agent/runs/892fdfbd-60b0-4e9f-96ab-afec781dde12/3/deepseek-result.json`。`delegate.py` 现在把 initialize 窗口设为 90 秒，可用环境变量 `DSH_INITIALIZE_TIMEOUT_SECONDS` 覆盖；没有加重试，窗口内起不来通常是启动本身卡住，再等一轮只会把失败时间翻倍。超时仍以中文提示返回，其他错误和模型调用失败照旧不重试。`test_delegate.py` 覆盖默认值、环境变量覆盖和超时提示三条路径。

**委派仍属于当轮任务预算：每轮显式 Harness 委派和新 queued 卡片合计不超过 queued_cards_per_turn（默认 10）；子 agent 只受同时存在数限制。** 一块任务只选一种委派方式；不给 Harness 再开子 agent。派出者需读取并核对返回结果和产出后才能采用，不把生成的文本视为已核验事实。不得据它自行发送邮件、付款、删除原始资料或扩大用户授权。

## 文件与权限

- 官方 Python SDK 固定版本 `0.2.1rc2`，安装于 `.runtime/deepseek-harness/venv`；唯一执行路径为 SDK 的公开 `dsh_bin` 参数指向本地 npm 发行版 `@deepseek-ai/dsh@0.2.1-rc.2`，位于 `.runtime/deepseek-harness/npm`。Python wheel 自带二进制在本机真实任务中加载 Koffi 失败，保留为 SDK 的传递依赖，但不作为执行路径，也不自动回退。
- 凭据只在 `.runtime/deepseek-harness/credentials.json`，字段为 `api_key`、`base_url`；官方 Harness 使用 Messages 协议，`base_url` 应为 `https://api.deepseek.com/anthropic`，不是通用 Chat Completions 根地址。不把密钥放进请求、参数、源码、聊天回复或用量账本。`.runtime/` 已整体忽略。父进程的其他账号 token 和自定义 DSH 环境变量不传入子进程。
- 原生配置使用 `sdk` profile 加 `delegate.patch.yml`；关闭完整会话上传、遥测、模型重试、额外子 agent 和自动加载父目录指令／文件系统技能。SDK 自带的自动压缩仍可能产生额外模型请求；按实际返回记录，不把每项任务称为只调用一次模型。
- **先用默认工具权限执行**；npm 运行时已实测能在默认权限下完成 SDK 初始化。具体任务若遇到权限拒绝，再通过正常工具审批申请该次运行；不要换壳绕过，或永久放行所有 Node 命令。真实写读验收是在正常批准的宿主运行中通过的，不据它承诺所有默认权限任务都能完成。安装包的版本／帮助成功不代表完整运行成功。
- 原生 shell／文件写入策略为 `workspace-write`，只允许新任务工作目录，申请扩大权限时 `approval:never` 会拒绝。Windows 上游 ACL 后端只提供部分执行隔离，**不是容器，也不提供“读不到宿主资料”或禁止联网的保证**；不要用它处理需要强数据隔离的任务。

每项任务保留在 `.runtime/deepseek-harness/jobs/<UUID>/`：`task.json` 为实际提交输入，`workspace/` 为产出，`home/` 为原生日志，`events.jsonl` 为回调轨迹，`result.json` 为最终状态／回复或失败原因。工具会返回结果文件和工作目录路径。只有原生 finish reason 为 completed 且回复非空才算完成；错误／截断不自动重试。Ctrl+C 终止本次子进程树；失败保留现场。

用量追加到现有 `.runtime/usage/runs.jsonl`；原生未明确报告 token 时标 `usage_known:false`，不填零费用。它不使用 Codex／Claude 订阅，按配置的 API 服务计费。

## 已安装的 dsh-ops

2026-10-22 应用户要求，已通过本地官方 DSH CLI 将 `dsh-ops@0.4.1` 安装并启用到正式聊天使用的 `C:/Users/24193/.dsh/profiles/sdk`。Windows Bash 可选载荷为 `@dsh-ops/bash-win32-x64@0.2.1`。保持插件默认配置：file、shell、ptc、discovery 开启，隐藏官方工具、panel 采集及 TUI 侧栏关闭，原生 PowerShell 保留。

本机没有全局 pnpm，安装用的 `pnpm@10.28.2` 位于 `.runtime/dsh-plugin-tools/node_modules/.bin`；将此目录临时加入当前进程 PATH 后，官方入口为 `node .runtime/deepseek-harness/npm/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile sdk add --save-exact dsh-ops@0.4.1`。用户 profile 与包缓存写入按正常工具授权执行，不调整原生 sandbox/approval。

正式聊天每轮启动新的 DSH 进程，下一轮即加载插件，不需要重启办公室后端。ask 叠加层关闭新增的四个 OPS 工具组件，维持原有无工具行为；独立委派的隔离 home 不会自动继承用户 profile 的安装。

真实正式聊天 adapter 已成功执行 `ops_read_files` 中文读取、原生 `write/read` 中文 JSON 回环、`pwsh` 办公室帮助命令及 `ops_bash pwd`，五次工具调用均成功。安装前 profile 文件备份、work/ask 实际合成配置、调用轨迹和核对报告在 `.runtime/dsh-ops-install-20261022/`（入口 `verification.json`）；脱敏定向回归 17/17，报告 `.runtime/test-results/2026-10-22T23-02-58-244Z-23480.json`。

## 重装与验证

```powershell
python -m venv .runtime/deepseek-harness/venv
.runtime/deepseek-harness/venv/Scripts/python.exe -m pip install deepseek-harness-sdk==0.2.1rc2
npm install --prefix .runtime/deepseek-harness/npm --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.2
```

无模型回归由 `node scripts/run-tests.mjs --software` 运行。真实小任务需另外通过官方 SDK 验证，不能用 mock 通过代替。

依据：[官方 SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)、[沙箱边界](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)。
