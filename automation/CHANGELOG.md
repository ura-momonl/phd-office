本文件保留旧变更记录；更早的记录（2026-10-06 至 2026-10-21）在 `automation/changelog-archive/2026-10-06_to_2026-10-21.md`。新助手工作日志统一写在 [`logs/`](../logs/README.md)，不再往本文追加。

## 2026-10-26 Codex：全办公室旧记忆系统退役，不归档

- 用户明确范围为全部旧系统。先关闭旧被动提取，核对发现 Claude、DeepSeek 各有 1 条有效旧记忆未迁入，Claude 另有 9 条更正历史；补齐后逐条核对 75 条有效记忆与 9 条历史，正文、情境、保留原因及完整原条目字段一致。原来源指针、标签等写入 memory2 情节的 `Legacy` 节，更正关系转为弃用映射，Codex 的 5 条置顶完整保留。没有另存旧库归档，没有启动付费历史对话回填。
- 三位统一启用 memory2，删除 `memory/`、`.runtime/memory/`、旧迁移脚本、旧 CLI 注册、被动提取配置/节拍、旧提示词和失败回退。身份检查与原生记忆覆盖移入 `memory2/owner.mjs`；每日留言改从 memory2 Markdown 取材料；设置页直接控制 `memory_v2.auto`，不再写旧配置。读取失败明确报不可用，不伪装成无记忆。
- 新增退役回归（身份、留言、更正记录、读取失败不恢复旧库）。脱敏隔离初跑 333 项，修复旧配置/旧提示词夹具，并让设置页的模型测试自行建立前提；逐文件最后一次验证 31 文件 / 333 项全通过（非单次全绿运行）。汇总 `.runtime/agent/runs/10127080-be8f-49fe-a4fd-309feb0559c6/retirement-test-summary.json`；相关原始报告由该文件索引。提示词 lint 76 片段 / 0 错误，snapshot 29 项无差异。
- 真实 `memory2 context` 经正常宿主权限调用本地 GPU 检索，命中 Codex 的收尾教训，5 条置顶全出；新代码临时启动的 HTTP 服务 `/health` 报 `memory2:true`、无旧标志、代码 current。迁移、删除及运行凭据在上述运行目录。当前工作台后端仍是本轮开始时的旧进程，须助手任务空闲后重载；没有中断正在工作的任务。当前用法见 `memory2/README.md`。

## 2026-10-26 Codex：修复完成任务的合并消息异常占用

- 定位 disc 阶段1的自然故障：助手已通过 `work update` 登记文件并完成步骤，最终回复使用相对路径；执行器只从回复提取绝对文件路径，丢掉已登记交付，误转 waiting_user；异常处理再转 failed 时同样缺少重新打开原因，两次抛错，合并补充消息留在 active，挡住重启。
- 收尾保留最新 done 记录中的实际交付文件，并继续检查文件存在；真实缺文件转等待处理、原生执行报错转失败时写明状态变更原因，使合并消息同步结束。不放宽重启时的运行中保护，不新增模型、轮询或自动重试。旧残留已由刚才重启的恢复机制标为中断，不再占用；本轮未改科研数据和历史消息。
- 隔离复现先出现同一“重新打开完成/失败的步骤须填写原因”异常；修复后 63/63 通过，覆盖三条合并补充、登记后报错／文件消失、实际 Edge 重启按钮和 Windows 后端重启。共享执行器及消费者回归另 129/129 通过。报告 `.runtime/test-results/2026-10-26T17-50-30-889Z-3256.json`、`.runtime/test-results/2026-10-26T17-51-27-605Z-15332.json`。新增回归进入 `--lifecycle`；后端空闲重启后加载本次修复。

## 2026-10-26 DeepSeek：常驻块预算补齐，5 条置顶不再被截掉

- Codex 用她迁入的真实条目复现：默认 `pinnedTokens: 120` 只装得下 5 条置顶里的前 3 条，被截掉的正好是两条工作教训。实测 5 行合计 180 token（单行 30～47），头部说明 20 token。
- 默认预算改为 400，沿用旧系统置顶入口的同一预算；预算不够时块尾补“（另有 N 条常驻记忆，本轮未列出：memory2 ledger 可见）”，不再静默丢弃最新的几条（只有一条都放不下时不出该行，避免只有提示没有内容）。
- 用 Codex 真实库渲染核对：5 条全出，含两条教训；常驻块加头部约 200 token/轮。`memory2/context.test.mjs` 新增超额提示用例，9/9 通过（进程内直接 import 运行）。未调模型、未改 owners、未回填。

## 2026-10-26 DeepSeek：memory2 支持“钉住＝每轮常驻”

- 为 Codex 迁库补上旧系统的置顶语义：`pin` 之前只等于“不归档”，新注入按话题检索，置顶的短线索基本召不回。现在 `memory2/context.mjs` 在画像后渲染常驻块，只出一行 `日期 《主题》 [id]（常驻）`，按 `pinnedTokens`（默认 120 token）截断；用“常驻”而非“相关度”标记，`ledger.parseInjected` 不把它算作召回，账本不被刷高。`migrate-legacy.mjs` 迁完把旧库 pin 写进账本 pinned。没有 pin 的库输出不变（Claude、DeepSeek 目前都是 0）。
- 提示词新增 fragment `prompts/fragments/memory/v2-standing-heading.md`（`prompt lint` 87 条 0 错误，`prompt snapshot` 无变化）；`help memory2` 的 pin 说明同步更新。
- 顺手替 Codex 跑了免费的第一步：`migrate-legacy codex` 迁入 9 条旧条目（9 情节、9 事实、5 条置顶进常驻）。未改 `memory_v2.owners`、未回填、未调模型。
- 验证：`memory2/context.test.mjs` 新增常驻用例，8/8 通过；`ledger`、`inject`、`md`、`reflect`、`search`、`extract`、`index`、`profile`、`llm`、`embedder`、`agentic` 各文件在进程内直接运行全部通过。`scripts/run-tests.mjs` 在本轮沙箱里无法使用（默认副本目录 `D:\Main\.test-tmp` 在会话工作区之外，`mkdtemp` EPERM；改指工作区内又触发“复制到自身子目录”；runner 起子进程同样 EPERM），所以 `auto.test.mjs`、`cli.test.mjs` 这两个必须经 runner 的文件未跑。

## 2026-10-26 Codex：步骤说明不再随自动刷新收起

- 项目操作步骤的“步骤说明”补接现有展开状态保存逻辑，以任务 ID 区分；每 5 秒刷新后保留展开或主动收起的状态，不影响其他步骤。不改任务数据、不新增轮询；刷新页面即可加载，无需重启后端。
- 实际 Edge 项目页先复现刷新后自动收起，修复后定向隔离测试 11/11 通过，覆盖完成／进行中步骤、连续两次自动刷新和独立开合；报告 `.runtime/test-results/2026-10-26T17-24-39-323Z-32252.json`。

## 2026-10-26 Codex：已交办项目步骤的动态 DAG 后继接续

- 按用户最终确定的规则，后继建卡的接续资格只看来源是正在执行、已授权的项目操作步骤；该来源创建的助手后继登记为待办，`delegated_by` 记录来源步骤。撤掉先前附加的同项目、同日志主题、直接依赖和工作类别判定，也不再自动补日志主题；节点内容和依赖由执行 agent 决定，程序沿既有执行器按实际依赖调度。用户步骤仍不交给助手自动执行，其他建卡入口保持原规则。
- 未新增模型调用、规划轮、定时器或重试，未改提示词与全局自主等级。按用户要求不运行测试；仅核对修改内容和实际任务登记。助手通过 `work add` 启动的新 CLI 进程直接加载此逻辑，现有后端不必为这条 CLI 接续路径中断重启。
- 将本次明确要求继续的 disc 阶段2（`ce0ed6f2`）从 open 排入待办，保留原负责人、目标、依赖与来源；读回已由现有后端接手为 active，负责人 Claude。排队请求及回执在 `.runtime/agent/runs/7d8cecbb-6d79-44a4-972c-d9229ecb0f0f/`；本次未演练后续多阶段运行。

## 2026-10-26 Codex：对话轮次不再混入项目操作步骤

- 用户指出中途补充和关心的话被列为“待归入日志主题的步骤”。项目框架页原先只排除已完成或取消的聊天，现统一使用 workSnapshot 的 turn 标记排除所有对话轮次，含进行中的合并补充及失败轮次；已绑定日志节点的聊天也不显示成步骤。项目卡步骤计数同步排除聊天，仍保留助手工作中提示、原始会话、实际步骤和待验收交付。不修改真实任务或中断运行；刷新页面生效，无需重启后端。
- 脱敏定向回归 44/44 通过，含存储→快照 API→实际 Edge 项目页的复现；报告 `.runtime/test-results/2026-10-26T17-11-15-713Z-26380.json`。截图对应三条真实对话仍保留，修正后的渲染不再将它们列为步骤。

## 2026-10-26 Codex：修复 DeepSeek 输入／输出漏计并明确总量

- 用户指出输入输出 token 偏少。原生根 session 与其子助手现由 `software/deepseek-harness/token_usage.py` 汇总，按 session 与序号去重；失败过程保留已观测下界，以 `usage_partial` 标注，不再整条丢弃，也不伪造完整用量。正式聊天与独立委派都保留字段；完整调用的速率口径不变。
- 额度与消耗页新增总输入（含缓存）、总输出；保留原非缓存指标，说明缓存是输入子集。部分用量计入已观测合计，CLI 另报 partial_usage。历史按原轨迹校正76条，输入743132390→891143835，缓存722543744→864186240，输出5227376→7525148；其他提供方记录未改，重复校核0条待改。原账备份、应用回执在 `.runtime/agent/runs/b4772363-8138-48cf-80d5-3f3ec6a790c0/`。
- 定向隔离检查48/49通过，新增统计和桌面／手机页面测试、Python汇总及既有用量检查均通过；另一个三人交接测试期望提示词中重复出现“当前请求”，实际只在对话原文中保留，失败点不涉及用量路径，未顺手修改。报告 `.runtime/test-results/2026-10-26T17-02-32-127Z-10224.json`。最终页面专项与runner检查12/12通过（`2026-10-26T17-05-26-457Z-27108.json`），桌面／手机截图已查看；独立逐条复算274份调用、11027条消息，与原生totalTokens逐条吻合，6430条其他提供方记录不变，见同运行目录 `repair-verified.json`。页面刷新可显示已校正历史；新采集的JS接线需助手及后台空闲后重载，未中断现有任务。

## 2026-10-26 Codex：复用旧库归档中的重合全文

- 用户要求把约4000篇的旧库备份与现库重合部分补回来。找到 `workspace/archives/literature-reset-20261021-0130`：4157条题录、3101份已登记全文，2511份全文与现库有效文章重合；61份现库已有，补回2450份，失败0。当前全文记录482→2932，未新增文章、未改当前摘要／选文／项目等字段。
- 逐份核对原归档题录的DOI对应关系、原SHA-256与归档manifest、PDF大小和完整签名，保留原身份与版本证据。现库直接引用归档PDF，原备份不变，不复制约10.35GiB文件。未重审文章或启动解析／向量化。
- 原fetch完成在途文章后暂停，回执279条保留；恢复后以现库已有文件重算剩余目标并继续6路。恢复前catalog、逐篇记录和读回验证在 `output/literature-fetch-20261026/archive-restore/`；2450条链接均通过资料库文件路径解析，3种类型的样本通过实际fetch离线缓存核验，见 `receiver-verification.json`。

## 2026-10-26 Codex：全文抓取三路并发续跑

- 用户批准将当前无宏取文批次改为3路并发。保持单一 Node 写库进程；Zotero 获取在进程内排队，不因插件 busy 跳过原生路线；arXiv 元数据共用既有3.1秒间隔。单篇来源顺序、PDF身份校验、预算及无宏边界不变，不需重启后端。
- 批次入口 `output/literature-fetch-20261026/start-live.ps1`，运行前21条回执保留并跳过；实时进度的 `current` 改为在途文章数组。STOP 停止派发并等待在途结果，不强杀下载。
- 脱敏专项和既有 fetch 回归138/138通过，覆盖OA三路重叠、Zotero逐篇尝试与失败后继续、arXiv共享节奏；报告 `.runtime/test-results/2026-10-26T16-22-13-060Z-5000.json`。实际续跑结果见该批次的 `live/progress.json`、`live/attempts.jsonl`。
- 用户随后要求尝试更高并发，批次调至6路；先让原在途文章完成，保留并跳过72条已尝试记录。单篇库代码不再改动；语法检查和真实6路在途／新增成功回执已核对。3→6的短时观察记录在同批次 `speed-comparison.json`，不是同一文章集的受控性能测试。

## 2026-10-26 Codex：文献入库后收尾遗留派工

- 修复文献包已由其他运行入库、原正式派工仍停在 open/queued 的状态脱节。入库及相同结果的重复提交共用 `literature/rebuild-work.mjs`，依据实际回执、逐条决定和当前 catalog，收尾待核为零的对应未启动派工；附上成果路径，明确不是原对话运行成功。失败、取消和正在运行的历史保持原状。
- `literature reconcile-work <包ID|all>` 默认只预览，`--apply` 修复历史残留；不重筛文献、不调用模型、不恢复已取消的下载。不增加后台轮询，也不依赖后端重启。
- 隔离专项及既有入库/队列回归 31/31 通过，含首次入库与重复提交的实际脚本路径；报告 `.runtime/test-results/2026-10-26T16-13-45-940Z-1864.json`。真实收尾 050、110、118、119、121 五个 open 派工，8 个失败记录保持不变，catalog 与原入库回执逐字节未变，再次预览无残留；证据 `output/literature-rebuild-20261021/formal-start-20261025/work-sync-20261026/VERIFIED.json`。

## 2026-10-26 Codex：修复 DeepSeek Command Code 批量连接超时

- 并列真实连接对照定位到 Node 24 默认250ms双栈地址竞速：正常IPv4 TCP握手实测约400ms，过早换地址后最终报 `UND_ERR_CONNECT_TIMEOUT`。同一接口默认6/6超时，1500ms等待与仅IPv4各6/6成功；未动并行上限，也未把超时当作余额不足。
- `software/deepseek-harness/connection.py` 只给Command Code原生进程及其子工具设置 `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1500`，保留IPv6、模型、计费通道及零自动重试；官方通道不变。隔离专项与runner检查18/18通过（含Python子进程实际读取1500ms设置），报告 `.runtime/test-results/2026-10-26T06-43-19-275Z-31428.json`。下一轮进程即生效，不需重启正在运行的后端。
- 先恢复036和037验证真实主模型与工具调用，再恢复其余73个任务；036已有145条成功入库，仅继续交付收尾。连接对照与排队回执在 `output/literature-rebuild-20261021/formal-start-20261025/connection-recovery-20261026/`；后续稳定运行证据随该目录记录，不将排队成功写成全部文献已完成。

## 2026-10-26 Codex：验证中途缩小并行数不打断已有任务

- 用户要求保护正在进行的线程。核对现有 `saveSettings` 与 `drain`：设置只写配置，调度只在启动新任务前检查 `max_active_agents`，不会因运行数超过新上限取消已有任务；无需修改运行逻辑、调整真实配置或重启。
- 新增 `agent/concurrency.test.mjs`，通过实际设置保存和任务调度复现 3→1：三个已运行任务继续完成，运行数为 2、1 时排队任务不启动，降到 0 后按新上限逐个启动；五个原始结果全部保留，无中断或重复启动。使用假模型与脱敏副本，专项 1/1、含 runner 检查合计 11/11，报告 `.runtime/test-results/2026-10-26T06-36-08-442Z-31504.json`。首次副本目录创建遇 EPERM，正常授权后完成。

## 2026-10-26 Codex：精简 Command Code 顶栏

- 按用户要求去掉保留额度时的「上次读数」，避免名称被挤到第二行；仍显示名称、百分比和两个额度窗口，查询失败详情保留在悬停提示中，无有效读数时仍标「不可用」。
- 脱敏定向测试 14/14 通过，受控 Edge 验证 1440、1100、950 宽度下名称单行、百分比不重叠、不溢出。报告：`.runtime/test-results/2026-10-26T06-25-25-292Z-31740.json`。

## 2026-10-25 Codex：个人量化月度纸面跟踪

- 跟踪 E-01/E-04 主规则及两个基准，使用独立前向账本与虚拟本金，不接账户、不下单、不调用模型。复用 trigger 的现有节拍：月末封存目标，下一交易日记录收盘模拟成交，每月一份只读简报卡片。`trigger paper-status` 查看账本、下一阶段与加载状态；初始化和手动到期检查入口见 `workspace/shared/personal-quant/README.md`。
- 日线按同一新快照的复权价格比值推进，避免分红回溯调整造成虚假损益；数据缺失或错过记录窗口会记缺失，不补造旧交易。规则、原始数据与过程有记录；正式初始化与测试的假行情分开。新增接线需后端空闲重载后加载，状态由运行心跳和 activation.json 区分。
- 验证42/42通过（`.runtime/test-results/2026-10-25T22-11-39-984Z-27744.json`）；正式账本2026-10-25封存，四组均为$3000起始现金，尚无前向成交。首个信号2026-10-30，首笔模拟成交计划2026-11-02。初始页及验收记录在 `workspace/outbox/personal-quant/paper/`。

## 2026-10-25 Claude：memory_v2 注入的画像改为按整句截断

- 画像每条原来在第 100 个字符处硬切并加“…”，常断在半句话里（如“保持 s…”）。`memory2/context.mjs` 的 `renderProfile` 改为按句号截断，只有第一句本身超长才硬切；新增对应单测。同时把 `context.test.mjs` 里“默认关闭”的断言改用未启用的 codex，避免读真实配置时对已启用的 claude 误报。`context.test.mjs` 7/7。
- 跨话题检索抽测（文献、邮件、周计划、TUI、queue、采购、仪器等 9 问）：有记忆的话题命中且排序合理；没有记忆的话题（采购报销）原始检索仍返回 0.05 左右的杂项，但注入门槛（minScore 0.3 / snippetMinScore 0.5）会挡掉，实际注入为“没有检索到足够相关的记忆”。账本的加权/遗忘已在 `ledger.mjs`，此前“无时间衰减”的说法已过时。

## 2026-10-25 Codex：DeepSeek 记忆专用工具补齐 agentic 回溯

- 用户同意按已有专用工具修复记忆功能，保留普通 shell 沙箱。`office_memory_maintain` 新增 `action:search`，映射既有 memory2 agentic 检索；owner 固定为本人，query 必填，可带 topK/chars/maxRounds（1～3），不开放任意命令、模型参数或其他 owner。search 的模型失败不自动重试；降级结果保留在 result.json，但工具报失败。`memory2/agentic.mjs` 的 rounds 现在透出 decider.error，CLI 不再只给 failed:true。工具说明、help 与 README 已同步；下一次 DeepSeek 正式工作轮加载，无需重启后端。
- 相关定向脱敏测试 **34/34**，报告 `.runtime/test-results/2026-10-25T19-37-58-941Z-8340.json`；提示 lint 无错误，snapshot 30 项无变化。初次真实运行受限和审批拒绝现场在 `.runtime/agent/runs/e763fec0-8afa-4319-910c-5da76db7610e/`。用户随后明确同意资料内容及模型目的地，经正常审批真实通过：profile 一批处理4个cell并写回（calls=1），agentic 一轮返回3条（failed_rounds=0）。正式 DeepSeek adapter 仅调用两次专用工具，普通 shell 沙箱未改，无后台任务或子 agent；证据 `.runtime/agent/runs/bbd9d5d4-f12d-48fb-9103-ec5ecbc37928/native-verification/verification.json`。此次未另跑 ingest/reflect，不扩展成所有 shell 子进程均已恢复的结论。

## 2026-10-25 Claude：修正 Command Code 上推理强度 off 无效

- 实测发现 Command Code 通道下办公室的 `off` 没有关掉思考（pi-ai 对 off 不发任何参数，Command Code 只认 `reasoning_effort:"off"`），`connection.py` 现经备用档 `minimal`（线上值 off）发送，`wire_effort` 转换，只影响 Command Code 的 off；单元测试已加。同一 prompt 流式对比：官方、Command Code 普通、Fast 的整篇耗时约 8.4／10.4／8.1 秒，Command Code 并不比官方快。下一次 DeepSeek 调用起生效，无需重启后端。

## 2026-10-25 Claude：按模型的输出速率记录

- 用户要记录各助手的 token 速率。不新增采集：从现有调用记录（`usage/runs.jsonl` 的 output_tokens 与 duration_ms）派生，`usage/metrics.mjs` 的 `speedGroups`。口径＝输出 token ÷ 整次调用耗时（含排队、读上下文、推理，不是纯生成速度）；中位数只统计完成的、无工具调用且输出 ≥ 300 token 的调用，含工具的调用（子 agent token 记在主调用上）只作参考列。入口：`usage speed [天数]` 和「额度与消耗」页的「输出速率」表；`usage/speed.test.mjs` 覆盖口径。
- 近 7 天中位数：gpt-6-luna 81、claude-sonnet-5-5 60、gpt-6.1-sol 25、deepseek-flash（官方）62 tok/s；Command Code 的 DeepSeek 普通／Fast 还没有符合口径的样本。

## 2026-10-25 Claude：Command Code 普通／Fast 切换、设置页切通道、套餐额度显示

- 用户要 Command Code 的普通 DeepSeek 与 Fast 版可切换，并要对应额度显示。`deepseek-flash`＝V4.1 Flash，新增 `deepseek-flash-fast`＝V4.1 Flash Fast（`connection.py` 映射；官方通道遇到 fast 直接报错，不静默降级）。设置 → 模型与推理新增「DeepSeek 计费通道」，模型清单带两档；切通道经 `selectConnection` 校验凭据，fast 与官方通道互斥，校验失败不写任何文件。
- 额度：Command Code CLI 的 `/usage` 用 `GET api.commandcode.ai/alpha/billing/credits`（API Key 即可，非官方文档公开接口），新增 `usage/commandcode-quota.mjs`，复用现有约 10 分钟额度刷新，只在选中 Command Code 通道时查询，只读不调模型。顶栏在 Command Code 通道显示「5 小时／每周剩余」两个窗口，悬停看已用／上限金额、重置时间、本月套餐余额；官方通道仍显示 DeepSeek 官方余额。TUI 底栏同步。失败保留上次读数并标注。
- 验证：新增 `usage/commandcode-quota.test.mjs`（3 项）与 Python fast／官方互斥用例；相关 9 个测试文件 62/62、Python 14/14；真机用 Fast 版跑通一次小任务（transport=commandcode，用量写入账本），额度接口返回与读数一致。后端空闲重载后加载新代码。

## 2026-10-25 Codex：DeepSeek 接入 Command Code，并支持本机编辑已登记凭据

- 用户已本地填写 Command Code Key，现以独立凭据和显式通道选择接入；复用官方 Harness 内置 pi-ai 适配器，不改 npm 包或用户 profile、不加代理、不自动回退／重试。正式聊天和按需委派共用通道，实际模型与 transport 留在结果和用量记录；官方 Key 与余额查询保持独立。默认模型为 DeepSeek V4.1 Flash，help 与软件 README 已同步。
- 修复聊天中这个凭据文件无法打开：同源本机 POST 可用记事本编辑唯一已登记路径，HTTP GET／下载、手机、其他内部文件和指向其他真实路径的 junction 仍拒绝；不将密钥正文带回页面。原有普通文件行为不变。
- 正式聊天真实写读验收通过（2 次工具调用，41914 输入、27648 缓存、204 输出 tokens）；证据 `.runtime/agent/runs/adee9f92-b819-4cbb-80b0-199368b5b9f5/formal-chat-verified.json`。相关文件打开 7/7、SDK 接线 8/8、余额 3/3，真实浏览器链接点击通过；扩大检查的手机高度断言失败及 agent 原有“当前请求”断言失败未改。最终报告 `.runtime/test-results/2026-10-25T16-33-26-348Z-29040.json`。默认测试副本创建和 SDK 用户 profile 初始化曾被 EPERM 拒绝，经正常审批后完成；未改变工具沙箱。
- 本轮结束后通过原有空闲重启接口一次性激活，不中断工作；状态在本轮 `activation.json`，30 分钟结束等待，不留常驻任务。

## 2026-10-25 Codex：DSH 每日检测新版并在收件箱提醒，不自动安装

- 用户批准「自动检测、提示新版，安装时再处理兼容性」。新增 `software/deepseek-harness/updates.mjs`，复用后端现有节拍，每 24 小时查询 npm 官方 latest / next 标签；不追 alpha、不降级，不调用模型、不启动安装器或子进程。`update-policy.json` 已启用；`deepseek updates` 可手动检查，`deepseek status` 可读缓存。help 与 README 已同步。
- 复用一张用户收件箱卡片，知道了后同一候选不重复提醒；新候选重新提示，已安装到候选后自动关闭过期提醒。「检查升级兼容性」只在用户点击时发起检查，不批准安装。网络／数据错误留记录并保留上次成功结果，下一天再查，不立即重试。三处 npm 包内补丁、SDK、权限与用户级 profile 未改。
- 脱敏定向最终 **29/29**，报告 `.runtime/test-results/2026-10-25T15-39-59-647Z-13684.json`，包含首日、次日、后续日去重、已读后新版重现、失败与恢复及无安装副作用。首次夹具残留已读记录和误匹配正则已修正；真实检查另发现 npm 地址 404，改为官方 `/-/package/.../dist-tags` 后再次通过全部测试。
- 真实检测发现 next `0.2.1-rc.3`，已通过正在运行的后端 HTTP 状态核对「DSH 发现新版」卡片及两个按钮；证据 `.runtime/agent/runs/5e1450e1-22ea-4d21-b019-cc0dfcf381c8/live-verification.json`。每日自动检查需新后端加载；本轮的一次性空闲激活记录在同目录 `activation.json`，仅通过现有拒绝打断活动工作的重启接口，30 分钟结束等待，不新增长期轮询或模型任务。

## 2026-10-25 Codex：补上 DeepSeek SDK 的本地时间上下文

- 按用户要求，在用户级 SDK profile `C:/Users/24193/.dsh/profiles/sdk/cordis.patch.yml` 插入官方 `@deepseek-ai/dsh-time-context`，配置 `America/Chicago`，其余插件配置保持原文。经正常工具授权写入并备份；正式聊天下一轮 fresh 加载，无需重启办公室后端。
- 已核对 work / ask 的官方 CLI 合成配置，并执行插件真实 pre-step 回调，验证 10 月的 `-05:00` 和 11 月夏令时结束后的 `-06:00`。无模型调用。默认权限下配置查看命令因刷新用户目录的 `cordis.yml` 被拒，经正常授权后完成。结果与备份在 `.runtime/agent/runs/565c323a-c695-4ea5-883d-309169ffb4f9/`，主要证据 `time-context-verification.json`。
- 写入问题定位为正式聊天 `workspace-write` + `approval: never`：办公室目录外拒写，当前版本的会话策略只有一个工作区根，不支持追加可写目录。尚未放开沙箱，已向用户询问是否将正式 work 轮改为本机完整读写；ask 和独立委派可保持现有隔离。

## 2026-10-25 Codex：DeepSeek 本人记忆维护接入专用原生工具

- 用户要求帮助 DeepSeek 自己运行 ingest / reflect，不再由用户在终端代跑。新增 `software/deepseek-harness/memory-tool.mjs`，在正式 work 轮通过 `chat.py` 加载 `office_memory_maintain`：只提供本人 status / ingest / reflect / profile，复用现有 CLI、模型通道与用量记录，不开放任意命令、不改变普通 shell 沙箱、Docker、全局权限或后台节拍。下一次 DeepSeek 工作轮加载，无需重启后端。
- 请求、输出与结果保存在本轮 `memory-maintenance/<UUID>/`；取消时结束维护进程树，失败与部分失败不标成功、不自动重跑。help deepseek 与 Harness README 已同步。
- 新增 7 项回归及相关接线、runner 检查最终 **24/24**；报告 `.runtime/test-results/2026-10-25T07-48-00-510Z-24692.json`。本机 DSH 原生注册和 schema 检查通过，证据在 `.runtime/agent/runs/40785fe1-7e5c-4048-80fa-f85a8036dd0b/native-schema-verification.json`。首次软件专项另有 1 项对话提示断言失败（41/42，不经过新工具），未修改该断言。
- 真实 DeepSeek 调用及一次本人画像更新的验收在启动前被自动审批拒绝，没有调用模型或处理真实记忆；已向用户说明资料处理与用量，等其明确同意后从本轮 `verify-memory.mjs` 接续。不能将离线验证记成真实调用已恢复。

## 2026-10-25 Codex：对话读取不再逐条查询无卡片的历史任务文件

- 用户反映“正在读取对话…”偶尔等待很久，并同意继续定位和修复。真实接口曾记录两条消息的新对话等待 8.1 秒；随后真实浏览器 12 次切换为 239～431 毫秒，8 秒峰值未稳定复现，尚不能归因于本次修复。
- `dashboard/inbox.mjs` 将待处理／已处理候选判断放在卡片文件读取之前，避免每次状态汇总遍历读取无卡片的历史任务；不改消息、任务、卡片可见性、轮询或模型调用。同一份现有资料只读对照：普通视图卡片文件查询 3487→0 次，已处理视图 3491→46 次，两个视图各四轮输出 hash 全部相同。对照脚本及结果为 `.runtime/tmp/chat-inbox-compare.mjs`、`.runtime/tmp/chat-inbox-comparison.json`。
- 新增 4000 条历史轮的真实 HTTP 回归，修前明确失败为 4000 次无效查询；修后通过。待处理、已处理、已解决、取消、合并、删除状态的覆盖及现有真实浏览器呈现、未读回归共 **39/39**，报告 `.runtime/test-results/2026-10-25T06-43-26-793Z-25032.json`。测试副本已由 runner 清理，真实业务资料仅只读比较；默认创建副本受限后经正常工具审批运行。help dashboard 已同步。后端仍承载当前任务，未重启，改动需空闲重载后生效。

## 2026-10-25 Codex：记忆回填在启动拒绝时停止整批尝试，并如实返回失败

- 用户要求检查「DeepSeek少女是否想成为人」里两位助手的工具故障。核对原始输出及上游 Windows ACL 文档，DeepSeek 的 `spawn EPERM` 对应受限孙进程的命名管道 stdio 限制；Claude 的错误则是 Anthropic 服务端 auto classifier 没给出 verdict，并非命令被判危险。
- `memory2/extract.mjs` 对 `EPERM/EACCES` 不再重复启动，也不继续后续 cell；保留已完成项并报告 `aborted:process-start-denied`。CLI 和自动 ingest 遇到该状态不再另起事实补齐；CLI 的 ingest 有失败返回非零退出码。普通内容错误仍保留原来的局部处理与续做行为。
- 文件 stdio 候选在默认受限环境中越过启动后，又遇到 Codex 自身状态目录写入拒绝；候选已撤回，没有改权限或增加宿主桥。已有后端记忆维护本来就按节拍读取最新配置，不必仅为 owners 变动重启；已纠正 `PORT-PLAN.md` 的旧说法。完整回填本轮尚未执行。Claude 独立分类请求的官方方案已告知用户，未自行切换。
- 脱敏 `--memory2` 100/100，通过报告 `.runtime/test-results/2026-10-25T06-28-24-918Z-3868.json`。默认测试创建副本被拒后，经正常工具审批执行成功；没有真实记忆库写入。改动的后端代码需空闲重载后生效。

## 2026-10-24 Claude：DeepSeek 文献包流程改成 off 小鱼初筛 + review-pack 复核

- 起因：pkg-deepseek-003 核对时发现，skill 和参考文档四处仍写“DeepSeek 不派子 agent、本人串行读”，而她当天已能用 `agent(...,{effort:"off"})` 派 off 小鱼；新对话读到旧文会走错路。同一包里 001／002 两块对同类论文（量子点／自旋量子比特）的收排口径相反，块内复核看不出来，靠核对才发现。
- 新增 `literature-backfill/scripts/review-pack.mjs <包ID>`（只读、不调模型、不写库）：生成拟收、相关但不收、scope=out 摘要判的阅读包，REPORT.md 给块间收录率对比、scope=out 理由在论证“与低维无关”却含低维词的条目、每条排除项的库内题名近邻。拿 pkg-deepseek-003 回测，8 条标出的里有 6 条后来改判，块间收录率 48%／70% 一眼可见。
- SKILL.md 的 DeepSeek 一节重写为：派 off 小鱼 → 合并 → review-pack → 回原文复核（scope=out 摘要判全读，不抽样）→ admit；复核后改判用补收小包。launch／resume 的提示、continuation／coordinator／review-and-admit／reader-card、literature-dispatch 的过时说明同步；FUTURE-SCREENING-STRATEGY 第 51 行括号里的 DeepSeek 说明改为现状，标准本身没动。旧版备份在 `.runtime/skill-edits/literature-backfill/20261024-113614/`。没有新增模型调用或后台任务。

## 2026-10-24 Claude：交接可选“回执”，子对话做完后把结果送回发起者

- 用户指出：助手交接出去的新对话是独立线程，对方回复里的 `@Claude` 只会在子对话里新起一轮，唤不醒发起交接的那条对话。`agent handoff` 请求新增可选 `notify_back:true`：对方在新对话里完成第一轮后，`agent/run.mjs` 的 `sendReceipt` 把她的最终回复（至多 4000 字）作为 `role:handoff`、`handoff.receipt:true` 的消息排进发起交接的对话，由发起者本人接续。回执只发一次（子对话消息记 `receipt_task_id`），回执本身和之后在子对话里的追问都不再回执；不加定时或轮询，只在子对话完成时触发一次 drain。
- 接手提示新增片段 `turn/handoff-receipt`（“这是某某向你交回的结果，不是用户的新发言，也不新增用户授权”），对话页标签显示“交接回执”；`prompt snapshot` 新增 `turn-handoff-receipt`，已接受。`help agent` 的 handoff 说明同步。
- 隔离测试：`handoff.test.mjs` 4/4（新增回执测试：无 notify_back 不回执、有则发起者收到一条、只一次、追问不重复、提示不含“创建的新对话”），`prompts.test.mjs`、`agent.test.mjs` 85/85、`continuation`、`workflow`、`user-priority`、`codex-output`、`efficiency` 通过。`chat.test.mjs`、`midway-handoff.test.mjs`、`agent/deepseek.test.mjs` 各有 1 个失败，去掉本次回执代码后同样失败，是先前就有的旧断言（“当前请求”位置随 10-23 交接时序改动），未处理。后端需空闲重载后才采用新代码。

## 2026-10-23 Codex：按真实时序交接，提示词页开放全部轮次

- 用户指出交接输入顺序本身有错，不应再用提醒文字修补。`agent/run.mjs` 将交接轮的用户消息、中途补充、助手回复放回同一份按实际顺序排列的历史；不再把旧用户原话放在末尾重复为“当前请求”。移除 Claude 未完成修改中的同事回复提醒及其片段，原生续接仍只补未见消息，角色、附件和完整原文保留。直接收到的新用户请求仍放在末尾。
- 提示词页“按运行”列出最近 100 段对话的全部保留输入，取消每位助手只列首次和总计 30 条限制；后续轮次、重复交接均可选，对话轮次与交接序号分别显示。同步 README、help 和模板快照。没有新增模型调用、重试或定时任务。
- 脱敏相关回归首轮 205/208；3 个失败是旧格式断言和已移除片段引用，修正后两个文件连同 runner 检查 25/25。其余 11 个文件首轮全部通过，包含十次交接、长历史、纠正与附件、原生续接。真实浏览器已选择第二轮并核对原生增量正文；35 轮和同助手多次交接测试通过。prompt lint 无错误，snapshot 29 案无差异。真实资料只读列表返回 434 条输入（331 条后续轮、18 条交接），约 497ms。
- 测试初次在副本目录 mkdtemp 被默认权限拒绝，经正常工具授权运行；无真实模型调用、无生产数据变更。后端仍需空闲重载才采用新代码，未中断当前任务。依据 `.runtime/test-results/2026-10-24T04-25-48-064Z-10444.json`、`2026-10-24T04-26-55-565Z-8224.json`；本轮记录 `.runtime/agent/runs/2735405a-741d-4775-b64d-22e7ce0953cd/verification.md`。

## 2026-10-23 Codex：将编码拒绝改为执行前自动纠正

- 用户明确批准后，将 `agent/codex-utf8.mjs` / `powershell-read-check.ps1` 从缺编码即拒绝改为 AST 定位补入 `-Encoding UTF8`，同时为本次命令设置 UTF-8 控制台与文字管道；仅作用于本项目 Windows PowerShell 的内容读取。显式 Encoding、Byte/Unicode、参数块与 using 语法保留，注释/引文不当成命令，重复经过不叠加。不会修改源文件字节、profile、区域设置或启动审批参数。
- 针对先前审批对 `PreToolUse allow+updatedInput` 的疑虑，先在项目外自建临时目录注册仅该目录生效的候选 hook，现有办公室拒绝式实现不动。两次有界原生调用证明：未写编码的中文读取及 Node 管道正常；随后 `require_escalated` 调用的已改写命令仍进入原生 user 审批，客户端 decline 后没有执行。获得正常工具审批后才推广两个正式文件；没有使用信任/权限 bypass，也不把 allow 当作提升许可。临时 hook、临时信任与临时目录均已清理，正式 hook 登记及其他 hook 未改。
- 脱敏测试 **15/15**，覆盖实际 PowerShell 启动、别名、Unicode/Byte、中文/emoji/管道、幂等、参数块与 using；真实办公室 `invokeNative` 入口再验收一次，不带编码的原始命令只执行 **1 次**就正确返回中文和 emoji，无错误重试。正式 `workspace-write`、`on-request/auto_review` 沿用现有适配器。help 已替换旧的拒绝式说明，没有新增提示词。
- 依据 `.runtime/agent/runs/afa4add9-550f-4742-8049-63184d8b0461/verification.json`、`read/checked.json`、`approval/checked.json`、`office-accept/checked.json`。首次实验末尾清理因 Windows 进程目录尚未释放而失败，客户端退出后经正常审批清理并核对不存在，未重跑模型试验。显式 Bash 的额外宿主检查被 WSL `E_ACCESSDENIED` 拒绝，不据此宣称 Bash 主机整链已验收。

## 2026-10-23 Codex：阻止缺编码读取，并执行已批准的旧快照清理

- 实测本机 Codex 命令带 `-NoProfile`，所以创建 PowerShell profile 不能修复此通路，本轮没有创建 profile。自动补编码的 `allow+updatedInput` hook 被审批拒绝，未安装该方案；改为正常审批通过的拒绝式 `PreToolUse` hook（`agent/codex-utf8.mjs`、`agent/powershell-read-check.ps1`），只在本项目的 Windows Codex 命令中检查真实 PowerShell AST。Get-Content 及别名缺 Encoding 参数时执行前返回 `TEXT_ENCODING_REQUIRED`；显式编码、引文和注释不被改写。只返回 deny 或空对象，不决定 PermissionRequest、不改变沙箱或普通审批，没有新增提示词。
- 在 `C:/Users/24193/.codex/hooks.json` 追加一个 hook，经原生配置 API 信任这个单一已审阅定义；其他 hook 的逻辑与内容核对一致。原文件及配置备份在本轮 `hook-install/`。新客户端直接读取配置，无需修改后端代码。首次原生验证暴露带空格 node 路径的启动语法错误，已修正并新增实际启动回归；保留失败记录，不把单元测试当原生生效。
- 最终脱敏测试 **14/14**；原生 Codex 日志确认缺编码调用被 PreToolUse 拒绝，正确 UTF-8 调用返回 `文献粗筛：二维量子材料`，实际执行工具 1 次。这是拒绝错误默认读取，不是修改 PowerShell 默认编码，也没有验证所有其他编码通路。
- 用户明确批准后，经正常权限审批执行了旧全文库快照及根目录 tmp/ 清理：18 个目标、**3,511,719,093 字节**。逐项验证解析后的路径在指定目录内；最新 `20261020-before-force-ingest/library.sqlite` 仍在（840,523,776 字节），所有选定旧目标已不存在。未清其他类别或改清理保留期。账本 `.runtime/housekeeping/ledger.jsonl`，完整依据 `.runtime/agent/runs/24594f9d-e500-4654-b2f3-27ec77930dab/verification.json`。

## 2026-10-23 Claude：定时清理 housekeeping

- 用户要求加定时清理，防止项目随历史文件越来越大。新增模块 `housekeeping`（`plan` 只列出会删什么、`run` 立即执行、`log` 看删除记录），每天由后端现有 10 秒节拍在 `backupData` 旁调用一次，不起新进程、不调模型。
- 只有规则表里的类别会被删：运行原始事件日志 `events.jsonl`（10 天，同目录的提示词、报告、结果文件保留）、验收副本（14 天）、`.runtime/tmp`（7 天）、测试报告（14 天）、`.test-tmp` 里的测试副本和浏览器会话（2 天）、skill/文档旧版备份（30 天）、入库前 catalog 快照（超过 10 天且只保留最新 3 份）。最近一天内改过的永不删，不跟随符号链接，每次删除写入 `.runtime/housekeeping/ledger.jsonl`。后又加两条：`.runtime/literature-edits` 里文献全文库 sqlite 快照（约 800MB 一份）只留最新 1 份，根目录 `tmp/` 7 天；这两条的首次删除（约 3.3GB）被权限审批拦下，未执行，由下一次每日运行或用户手动 `housekeeping run` 执行。`housekeeping/policy.json` 可停用或调整天数。
- 当前实际 plan：1654 个事件日志约 287MB，其余类别暂无到期项（项目 10-05 才开始积累）。隔离测试 5/5（含文件夹日期旧但有新写入的子文件不删、保留最新 3 份、联接目录不被穿透、每天只跑一次）。后端需空闲重载后首次执行。

## 2026-10-23 Codex：用户消息优先于尚未发送的助手交接

- 用户确认：Codex 已点名 Claude，但给 Claude 的输入尚未发出时，新消息可以插队；不写 `@` 仍交给 Codex，显式点名按用户指定。输入已交给 harness 后不撤回、不重排，原生何时读入上下文不变。
- `agent/run.mjs` 在原任务记录暂存剩余接收者、累计轮数和原路由，让已到达的用户消息按先后顺序先执行，再从原处接续；不新建交接任务，不提前完成原任务。原目标与已经送达的同链纠正保留，插队期间已处理的新消息进入历史；完成后还原原路由并清除暂存阶段，停止与任务依赖保持有效。
- 三位适配器共用同步 `beforeSubmit` 边界：Codex 在 `turn/start` 前、Claude 在无异步间隙的初始输入前、DeepSeek 在任务交给 harness 前核对；未发输入的准备可以让位，不记作模型调用。默认接收者在真正发送前不提前切到下一位。没有新增模型自动重试、轮询或定时任务，help 已同步。
- 较广的周边回归曾通过 **238/238**；保留原目标、完整插队历史及还原任务路由后的最终候选 **80/80**，包含 12 个插队专项和 HTTP→路由→接收内容验证。最终报告 `.runtime/test-results/2026-10-24T02-40-02-870Z-32492.json`；代码与通过副本哈希一致。只在脱敏副本恢复“提前换默认接收者”和“漏掉发送前检查”两个错误分支，专项均按预期失败；证据 `.runtime/agent/runs/4f408529-6a64-406f-b3bb-619c013ee8cb/user-priority-verification.json`。本轮保留的副本已清理，prompt lint 无错误、29 个 snapshot 无变化；测试没有真实模型调用。
- 后端仍有其他助手工作，本轮未中断或重启；空闲重载后用于实际对话。

## 2026-10-23 Codex：恢复中途行首 @ 的实际交接

- 用户截图中的 Codex 中途发言有行首 `@Claude`，但旧分支仅保存为 `interim`，不进入路由。`agent/run.mjs` 现在把主助手中途点名加入既有交接链，当前助手完成后接续；接收者获得原中途文字、最终成果和完整用户目标，不要求最终再重复一次点名。同一待接收者只启动一次，最终另点名的接收者也保留。仍沿用同一对话串行与最多 10 轮；子 agent 文字、行内提及、自称和 ask/card 不触发主对话交接，停止后不启动接收者。
- 交接登记只保存在原中途消息的 `handoff_to` 上；`dashboard/app.js` 显示“已登记交接 → Claude”，区分实际登记与普通文字提及。没有新增交接工作流、后台轮询或原生模型调用，help 已同步。
- 周边脱敏回归 **200/200**，报告 `.runtime/test-results/2026-10-24T01-57-52-598Z-3888.json`；最终去掉重复活动记录后的专项 **19/19**（9 个交接用例及 10 个入口自检），报告 `.runtime/test-results/2026-10-24T02-00-04-514Z-34112.json`。真实 Edge 页面在源助手仍运行时显示登记标记，完成后出现接收者回复；模型接收边界使用假 runner 核对，不消耗模型额度。
- 最终 `agent/run.mjs`、页面与专项测试的哈希均与通过副本一致。仅在脱敏副本恢复旧“中途只显示”分支，截图回归按预期失败；反例日志、哈希及验证结果在 `.runtime/agent/runs/fe3f1247-9f4e-4331-aedc-89b6a2a01c23/midway-verification.json` 和 `midway-bad-control.log`。本轮保留的 15 个副本已清理；prompt lint 无错误，29 个 snapshot 无变化。
- 在线仍有其他助手工作，未中断或重启。以上验证覆盖磁盘代码的新进程，后端空闲重载后才用于实际对话。

## 2026-10-23 Codex：每个模型旁配独立推理强度

- 设置页的每个模型选择框后都配一项小型强度选择；补齐 Claude、Codex 对话和邮件／文献／汇报任务。Claude 与 Codex 不再共用同一个编辑项，保留原有 high 默认值。任务模型切换时强度选项随助手切换，包括手动输入模型；DeepSeek 使用 off / low / high / max，其他两位使用 low / medium / high / xhigh。
- 三类任务的强度由 `work/policy.json` 持有，创建时记录到任务并传至执行器；改默认不改旧任务，显式强度可覆盖。改负责人同时清除原模型和强度。对话、标题、邮件判断与记忆整理各用自己的设置，保存不启动任务或新增模型调用。help 已同步。
- 脱敏设置页 21 项、聊天 36 项、工作流 21 项、文献路由 9 项通过；新增执行器 2 项及共用入口 10 项通过（去重共 99 项）。初次执行器测试因误导入私有函数失败，改用现有公开步骤编辑接口后定向复验 12/12 通过；原始失败日志保留。真实 Edge 已验证相邻布局、切换选项、手动模型、放弃修改、HTTP 保存及刷新保留，截图已目视核对。记录在 `.runtime/agent/runs/3255a012-77a0-448b-b916-08b2a00d11bb/verification.json` 与 `model-efforts.png`。
- 后端仍有其他助手工作，本轮未重启；在线界面需空闲重载后端后使用。测试后 `agent/run.mjs` 有同事对中途点名的并行改动，已读差异，强度传递代码未变；其余四个实现文件与通过副本哈希一致。本轮没有真实模型调用或修改已有真实任务。

## 2026-10-23 Codex：工作输入分块与程序计数

- `agent/run.mjs` 将办公室背景、历史引文、运行材料、同事回复与当前请求分别组装；历史以逐条 JSONL 保留来源角色和完整原文，交接回复只出现一次，最新已送达用户纠正仍作为当前请求并带附件。Codex/Claude 适配器实际传入原生 text 内容块，正文可无损重建；不把同事的文字提升成用户/system 消息，不清空原生历史或删用户资料。运行 manifest 记录分块。DeepSeek 使用同一分层正文，其独立 harness 尚不传多块。
- Claude work 将设置中的并发值传入原生 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`，深度设为 1；ask 不增加这些变量，自动审批保持不变。只约束原生 Agent 新建路径，恢复旧 agent 等原生豁免仍存在；不复制原生计数器。Codex 原有原生限制保留。
- `work/run.mjs` 用 SQLite 原子入队收据实现用户轮的 queued 卡片额度；open 不计，首次排队计入，同卡同轮不双计，取消/回退不返还。交接及已合并补充追溯原用户轮；中途点名的后继任务记录原消息 ID，保留完整目标与附件，也不重置额度。聊天轮内部记录不当成卡片。超额不写队列；队列未写入时撤回本次新收据，卡片已可见但轮次日志写失败时保留收据。未将后台自主任务视为新的用户授权。
- 常驻每轮数量提醒从 233 字缩为运行配置一行，机械限制移交程序；未新增行为提醒。help 与提示词管理说明同步。脱敏综合回归 **281/281**，最终入队故障专项 **22/22**（含 12 个入队用例与入口自检），prompt lint 无错误、29 个 snapshot 无差异。两位原生客户端各一次只读分块验收均返回正确用户目标，工具调用为 0；原生日志确认保留 3 个 text 内容块。记录 `.runtime/agent/runs/8723676b-b36a-4f88-8ca2-32bd2767f3ac/RESULTS.md`；尚未空闲重载线上后端，不以此短验收宣称长流程质量已恢复。

## 2026-10-23 Codex：设置中分别选择邮件、文献、汇报的新任务模型

- 设置 → 模型与推理新增“新建任务默认模型”三项下拉框，均可选择 Codex、Claude、DeepSeek 模型或手动输入；执行助手随模型切换。默认值与模型由 `work/policy.json` 统一持有，不在 `agent/config.json` 另养副本，沿用原设置变更日志。当前三项保留 DeepSeek / deepseek-flash。
- 新任务保存创建时的默认模型，单项指定可覆盖；之后改默认不改旧任务。普通聊天不继承任务模型，后台收件判断和其他任务分工不变。手动改负责人会清除原助手的模型；普通文献回填入口未指定助手时也跟随设置。保存设置不启动任务，不新增模型调用或定时任务。
- 脱敏定向回归 **124/124**，报告 `.runtime/test-results/2026-10-24T00-26-55-139Z-26900.json`；包括真实 Edge 三项选择、HTTP 保存、刷新保留，以及设置→新建任务→执行器收到正确助手和模型的模拟调用链。设置截图已目视核对，留在 `.runtime/agent/runs/3a4183a5-975e-41cd-b49c-de310ca75753/settings-tested.png`，当前五个实现文件哈希与通过副本一致。
- 续接时后端已重载，运行/磁盘指纹均为 `624a7069e4`；真实只读 `/api/settings` 返回三项设置及三位助手的选项，无需再重启。核对结果在同目录 `verification.json`。未为验证改动真实设置或创建真实任务。

## 2026-10-23 Codex：DeepSeek 接手新任务的首轮试用移植

- 用户希望先尝试 DeepSeek 代替 Claude。新建邮件、文献和汇报任务的默认负责人从 Claude 改为 DeepSeek；保留显式 @Claude、已有任务、聊天历史、Claude 私有记忆及原有后台调用分工，没有新建后台模型任务。
- DeepSeek work 轮增加原生 inbox 的运行中输入桥，每条输入独立提交，不等上一条送达回执；只有根会话的 `agent/inbox/spliced` 才确认送达，拒收、进程关闭和运行配置不同仍留独立排队。每轮 fresh/full-history 的原路径不变。桌面工具复用唯一 `software/computer-use/mcp.json` 白名单，ask 和独立委派不挂载；原生配置层保存在本轮目录，未更改用户级配置或沙箱策略。
- 周计划新目标、周用量统计、普通文献回填入口和提示词首轮列表补齐 DeepSeek。脱敏定向回归 **100/100**，包括输入回执分离、两条补充不互相等待、Unicode、三位交接保留用户目标、任务分工、周计划和现有界面。报告 `.runtime/test-results/2026-10-24T00-16-32-684Z-31076.json`；prompt lint 无错误，29 个 snapshot 无变化。原生 MCP 模块实际配置 schema 校验成功，11 个工具名单与共用文件一致。
- 原生验收：默认权限启动先被 SDK 用户 profile 写入 EPERM 拦住；正常宿主审批又因 Snapshot 将向 DeepSeek API 发送窗口内容而拒绝。用户随后明确回复“允许”，获正常审批后一次真实 `deepseek-flash/high` 任务成功完成只读 Snapshot、weekly 帮助命令及中文 JSON 写读；运行中两条输入均收到根 inbox 的实际送达回执，并进入最终回复。6 次工具调用均成功，结果与逐项核对在 `.runtime/agent/runs/2e69bd5d-2f87-43e3-a3cd-b516138ae089/native-smoke-approved/verification.json`、`checked.json`；先前失败现场仍在原目录，未改路径绕过审批。在线后端仍是旧进程，其他助手任务尚在运行，本轮未重启或声称在线能力已生效。

## 2026-10-23 Codex：交接保留用户目标，Bash 不再掩盖中间失败

- `agent/run.mjs` 将同轮上一位助手的回复保持为进度上下文，当前请求仍取用户原文；已有回执的中途纠正及附件成为接手者当前请求，原目标留在历史。不再用“前面的发言已回应过”降级用户目标；删除 `turn/request-handed` 及其渲染入口，复用现有 previous/request，没有新增规则提示词。保留 @ 顺序、续接、长正文和交接排重。
- 现有 Claude `PreToolUse:Bash` hook 先执行原来的不安全内联源码拒绝，再仅将命令加上 `set -e -o pipefail`，保留 description、timeout 等原参数，不返回 allow、不更改审批。Python/普通命令失败及流水线失败不再被末尾 grep 成功掩盖；显式 if/或条件的处理仍按 Bash 语义，短截流水线的 SIGPIPE 也会报告失败。
- 文献历史 local-rules 已退出 brief，本轮不重复改 skill；新增旧任务夹带大型历史规则文件的回归，验证 brief 不读、不输出该文件，仍保留唯一标准与题名窗口。
- 脱敏回归 **191/191**，包含真实 Git Bash 复现旧的“失败后仍完成”，以及经部署 hook 改写后的非零退出、末尾标记不执行、正常条件处理和中文源码保真。报告 `.runtime/test-results/2026-10-23T23-50-51-399Z-10012.json`；prompt lint 无错误，29 个 snapshot 仅接受了删除旧交接包装的预期变化，之后无差异；副本由入口清理。
- 原生 Claude CLI 的单次只读验收被 session limit 拦在工具调用前，未执行 Bash、未重试，不据此宣称原生整链通过。现场与文件哈希在 `.runtime/agent/runs/13d924c5-0d2e-43a2-a4ad-3c8116af5a22/`。线上后端未重启，空闲重载后新工作轮才使用改动；没有修改 TUI 图像或加入通用语义验收门禁。

## 2026-10-23 Codex：移除运行中输入的 Workbench 拼包与补送调度

- 用户明确要求：上下文齐了就直接输入，何时进入模型上下文交给 Claude Code／Codex CLI；仍是一条接续的对话，不改成三路并行。先完成 Codex、Claude；DeepSeek 的运行中输入通道本轮未接。
- `agent/run.mjs` 删除 `followup_of` 归属、旧拒收输入随新消息拼包重送、开轮回收拼包、交接下一位自动消费未送达输入及 Workbench 的 `accepting` 判断。每条消息单独写原生通道，不等上一条回执；原生拒收后仍作为自己的独立输入保留，不悄悄换接收者。回执、停止归属、已见消息集合仍用于记录实际送达，不用于选择输入时机。显式原生配置随输入传至适配器，不能在该原生调用中应用的启动配置由适配器报告并留给新轮，不静默丢弃。
- 界面将等待原生回执的消息标为“正在提交原生输入”，不再冒充“排队中，等当前轮结束”。保留后继助手所需的前序回复上下文、附件、原生续接和原有停止语义，help 已同步。
- 脱敏定向回归 **97/97**，覆盖 HTTP 连发、回执独立与拒收、界面状态、原生协议、接续和文件上下文；报告 `.runtime/test-results/2026-10-23T23-44-12-808Z-9100.json`。测试副本由入口清理。首次测试的 1 个失败是调整测试生产入口后丢了明确接收者的 fixture，已修正；不是权限失败当通过。prompt lint 无错误，29 个 snapshot 无变化。
- 真实 Claude CLI、Codex app-server 各连续写入两条消息，两条回执均成功，最终都按序返回 `WIRE_ZERO / WIRE_ONE / WIRE_TWO`，工具调用均为 0；证据 `.runtime/agent/runs/1b4a19c1-d7e5-41d9-b157-85eb2b36533c/input-native/`。Codex 首次在工具沙箱中找不到 home，未进入模型请求；正常宿主授权后的独立运行成功，未重复调用 Claude。用量按适配器正常记账。
- 在线后端仍有其他助手工作，未中断或重启；本条验证的是磁盘代码的新进程与真实原生输入通道，不声称在线旧进程已生效。

## 2026-10-23 Codex：删除模板字符串问题的重复提示解释和纠正

- 按用户要求，删去两个项目 skill、`automation/CLAUDE-REVIEW.md` 和 agent help 中与 Shell 吞源码有关的解释、提醒和纠正；UTF-8 编码等未涉及本次修复的内容保留。两个 skill 整目录旧版在 `.runtime/skill-edits/<名称>/20261023-182701/`。
- hook 的长篇原因和改写指导改为简短错误 `SHELL_SOURCE_QUOTING`，执行前拒绝逻辑不变；没有新增替代提示词。更新对应回归断言。
- 脱敏专项 **14/14**，报告 `.runtime/test-results/2026-10-23T23-27-40-270Z-5956.json`；prompt lint 无错误，29 个 snapshot 无变化，`prompt where` 查询 `node -e` 和 `反引号` 均无命中。两个 skill 的 Claude 链接与本体内容一致，`settings skills` 确认链接正常。

## 2026-10-23 Codex：在 Bash 执行前阻止 Node 内联模板字符串被 Shell 吞掉

- 原始现场：Claude 运行 `da98a305` 用双引号包住 `node -e` 写测试，嵌套模板字符串在 Shell 层丢失，留下空的 `page.goto()`／`page.locator()`。原工具请求保存在 `agent/fixtures/shell-template-incident.json`，作为回归输入。
- `agent/claude.mjs` 为新开和续接的 work 轮加载原生 `PreToolUse:Bash` 命令 hook，`agent/shell-guard.mjs` 在执行前拒绝跨 Shell 引用层传递反引号／$ 表达式的 Node 内联源码（包括多层反斜杠转义），返回文件工具写 `.mjs` 或完整单引号引用的修正办法。不重写源码、不自动批准；普通脚本、测试入口、单引号保护的源码仍走原有审批。纯 ask 不挂 hook，常驻提示词和用户级设置未变。检查本身只运行本地 Node，不调用模型。
- 最终脱敏定向回归 **162/162**：覆盖原始请求、含空格的可执行路径、命令链、注释／heredoc 数据与后续命令、原有工作轮／续接／工作目录消费者。真实 Git Bash 坏对照复现源码被改写，hook 标出拒绝；安全单引号和 `.mjs` 路径保留中文与模板字面量。报告 `.runtime/test-results/2026-10-23T23-23-52-125Z-10656.json`，副本已由入口清理；prompt lint 无错误，29 个 snapshot 无变化。
- 单次原生 Claude CLI 验收确认该 hook 确实阻止 Bash 执行；接续的 Write 被现有自动审批以 no verdict 拒绝，未重试、未绕过，因此不声称完成原生 Write→执行全链路。原始事件与结果在 `.runtime/agent/runs/dd2fd688-560e-436f-bc2a-560390e75bbd/shell-native/`，用量已记账。接口依据为 [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)。
- help 已同步。在线后端仍是旧进程，本轮未中断正在执行的工作；后端空闲重载后，后续 Claude work 轮开始使用检查。

## 2026-10-23 Claude：多发言者 @ 消息不再整条排队，排队的消息在界面上标明

- 依据：用户截图（“@Claude @Codex …”在 Claude 运行时显示“等待执行”、消息下面却是上一件事的回复）及“@ 排队一直没修好”。10-18 起运行中到达的 103 条用户消息里 94 条追加成功，9 条排队：7 条同助手却排队（追加窗口已关、轮被停、DeepSeek 无输入通道），1 条换助手，1 条就是多发言者。
- 改动：`agent/run.mjs`——多发言者消息第一位等于正在发言的助手时也追加进运行中的轮，原生确认后为其后点名的助手另建一条排队轮（同一段原话，运行链结束后接着跑）；追加被拒时不另建，消息仍整条排队。`dashboard/app.js`——排队中的用户消息标“排队中，等当前轮结束”，排队条显示完整顺序（如 Codex → Claude）。
- 验证：脱敏 `automation/chat.test.mjs` 46/46（新增 2 项；临时恢复旧判断时追加用例失败）；顺手更正一条停在“@all 只有两位”的旧断言（现为三位）。后端未重启，重启后生效。
- 未改：DeepSeek 的 `onReady(null)` 表示她没有运行中输入通道，她运行中发的话仍整条排队到她这轮结束（只做了排队标注）；换助手（@Codex 而 Claude 在跑）按“轮流不并行”仍排队。

## 2026-10-23 Codex：DeepSeek workflow 小鱼接入现有子 agent 显示

- `agent/deepseek.mjs` 按根／子 session ID 分流原生通知，接入 `subagent.started/finished`、catalog 与 workflow 标签。小鱼使用现有活动计数和折叠卡片，记录原生提供的任务正文、中途文字和最终结果；子工具 ID 带子会话前缀，不与其他鱼混写。主助手的 held/final 文字、送达回执和上下文 token 只由根会话更新。
- 复用原有 `subagent:true` 消息标记及后续提示词过滤，不把小鱼的中途文字、任务正文或工具输出额外写入三位同事的主聊天上下文；原生 workflow 给主助手交付最终结果的方式不变。没有新增模型调用、轮询、重试，也没改文献包串行入口或委派配置。同步 dashboard help 与 DeepSeek README，澄清正式聊天 workflow 已能开小鱼、独立 Harness 委派仍禁用子 agent。
- 脱敏定向验证 **33/33**，覆盖流事件分流、失败／停止、回执与上下文隔离、三位同事后续提示词、既有活动栏和 TUI 消费者。真实 HTTP＋Edge 核对运行中两个子 agent、默认折叠、展开内容、完成归零及刷新保留；最终报告 `.runtime/test-results/2026-10-23T22-28-30-070Z-12032.json`，截图 `.runtime/agent/runs/e725a17a-8a52-4bce-8071-45461f310eb8/ui-final/`。本轮保留的脱敏副本已清理。
- 离线回放真实运行 `9bde487f`：识别小鱼一号／二号各自完成结果，两个子文字均标记来源，未冒充根助手中途发言；主上下文为根会话实报 27128 token。回放结果同目录 `native-replay.json`，不产生新模型用量。prompt lint 无错误，29 个 snapshot 无变化。在线后端仍是旧进程，其他工作结束后空闲重载再使用；未中断现有任务、未改写历史聊天。

## 2026-10-23 Codex：为 DeepSeek 接通文献包串行处理入口

- literature-backfill 的 resume、launch、admit-reviewed 及 literature-dispatch 支持 `deepseek` owner；DeepSeek 在正式聊天本人串行读取，共用现有题名粗筛、摘要分页、前缀保存、机械合并、内容复核及持锁提交。launch 返回 `serial.next_task`，不生成子 agent 派工；dispatch 默认单路、每块 100 篇可调。Codex／Claude 原有模型和并行派读不变，无新增模型调用、重试或后台任务。
- 同步两个项目 skill、阅读卡、续接／协调说明和 DeepSeek README；选文标准只补充阅读者执行方式，不变更收排口径。两个 skill 原目录已备份到 `.runtime/skill-edits/<名称>/20261023-171129/`。PowerShell 读者使用 UTF-8 JSON 文件提交，保留 Bash 读者现有 heredoc 用法。
- 脱敏定向验证 **43/43**，覆盖 DeepSeek 串行任务、题名与摘要断点、只读导航、归属隔离、输入变化、损坏前缀保留、合并和审核后幂等入库，以及 Codex／Claude 旧路径；报告 `.runtime/test-results/2026-10-23T22-15-41-745Z-7340.json`。prompt lint 无错误、29 个 snapshot 无变化；两个 skill 格式检查通过。测试副本由入口清理。
- 实际 `resume.mjs deepseek` 已可读取当前状态，尚无她名下文献包；本轮未请求 DeepSeek API、未分配真实包、未改现有文献结果或 catalog。选文质量留待独立小包试读核对，脚本可直接使用，无需后端重载。

## 2026-10-23 Codex：修复 TUI 外围留白露出黑边

- 截图中的内容区为陶土底色，外围留白却回到终端黑色。原实现仅在应用期望颜色改变时发送 OSC 11；移除这份颜色缓存，让现有重绘重新声明终端底色，宿主重置底色后下一帧即可恢复。沿用原有主题、CRT/Sixel 开关与退出恢复行为，不新增定时器、轮询或模型调用，命令用法不变。
- 脱敏定向回归 **54/54**，新增真实 `run('start')` 输出路径覆盖连续重绘、聊天页、换主题、关闭 CRT、关闭效果但显示 Sixel 和退出恢复。旧实现确实在连续重绘断言失败；最终报告 `.runtime/test-results/2026-10-23T18-58-54-686Z-12444.json`，副本由入口清理。
- Windows Terminal 1.25.2733.0 的独立假数据窗口中，主动重置终端底色，修复前复现外围黑边；修复后同场景恢复统一底色，右侧与底部七处采样均为 `[27,25,23]`。截图与采样在 `.runtime/agent/runs/9bfbf94c-b32c-42b2-b23e-7ace7f6f9419/border-after.png`、`border-after-pixels.json`，底色重置及恢复输出在 `border-after.json`。测试窗口已自动正常退出。重新运行 `piri` 加载修复，无需重启后端；未重启用户当前 TUI、未修改终端全局设置。

## 2026-10-23 Codex：TUI 拖选与滚轮、输入框点击定位同时可用

- 原先默认开启鼠标捕获，但只请求点击事件，解析器还丢弃拖动事件；因此终端原生选字被接管后，TUI 本身没有选字实现。现请求按键拖动报告（1002 + SGR），在 TUI 内按屏幕单元格拖选、高亮，支持正反方向、跨行、中文、emoji 和组合字符。Ctrl+C 复制选区，无选区时仍退出；Esc、其他按键或滚轮解除选区，继续更新画面。Windows 复制使用 `clip.exe` 的 UTF-16LE 输入，其他终端沿用 OSC 52。
- 滚轮路径和输入框单击定位保持；拖动期间不反复移动插入光标，其他可点击项改在松开时激活，避免选文字时误打开页面。选区保留显示时暂留原帧，避免流式回复和动画把正在选取的文字挤走；后端照常刷新。Alt+M 和 `/mouse` 的原生选字备用模式保留，帮助已同步。不新增模型调用、轮询或后端接口。
- 最终脱敏定向回归 **64/64**，报告 `.runtime/test-results/2026-10-23T18-31-39-351Z-22912.json`，副本已由入口清理。独立隐藏真实控制台注入 VT 鼠标报告，实际读回高亮属性变化、滚轮上下滚动及点击草稿中间插入后的 `abXcd`，退出码 0；证据 `.runtime/agent/runs/82cf8fdd-201b-4394-9c6e-d7b60185d4e6/native-result.json`。这是终端报告到真实控制台的验证，不是物理鼠标全链路验收；桌面工具未找到独立测试窗口，未完成前台鼠标复测。剪贴板含非文本格式，为保留用户内容，跳过原生剪贴板写入验收；选区复制内容已由回归核对。
- 重新运行 `piri` 加载前端修复，无需重启后端；未重启用户当前 TUI。测试过程中同期另一任务的新对话入口改动已保留，并包含在最终回归中。

## 2026-10-23 Codex：统一 TUI 新对话入口到主页

- 移除 `/home`，`/new` 改为回到现有主页；Ctrl+N、对话列表“新对话”的回车和鼠标点击共用同一入口。补上该按钮缺失的点击区域，不再进入空聊天页。
- 返回主页时解除当前会话选择，不删除旧对话；新消息仍沿用 TUI 启动文件夹。同步命令菜单说明。现有 TUI 重新运行 `piri` 加载，无需重启后端。
- 脱敏定向回归 **51/51**，覆盖五种新对话入口、旧对话保留、启动文件夹传递及鼠标选择等。报告 `.runtime/test-results/2026-10-23T18-24-07-409Z-10904.json`；副本由测试入口清理，未接管用户正在使用的 TUI。

## 2026-10-23 Codex：子 agent 换波次时不再提前关闭用户输入

- 用户在文献粗筛中发送“没额度了”，主助手仍继续派子 agent。原始运行 `1b541852` 的事件 559 显示：主助手已开始第 2 波，最后一个第 1 波子任务退出，空子任务列表却触发关闭 stdin；上一轮 `result` 的完成标记没有随主助手再次工作而清除。
- `agent/claude.mjs` 在主线程的 user／assistant 事件到达时清除旧完成标记，子 agent 自身的输出不改变主线程是否完成。保留真正完成时关闭输入和向同事交接时结束当前轮的行为；不增加模型调用、重试或轮询。
- 脱敏定向回归 **36/36**，新增跨波次追加输入用例；临时撤去修复时该用例在“子任务归零但主助手仍工作”处失败，随后恢复。报告 `.runtime/test-results/2026-10-23T17-52-16-528Z-7452.json`，取证与验证摘要 `.runtime/agent/runs/5800d298-dd15-426c-aaec-d72391d9be10/validation.json`。
- 本机 CLI 连接本地假模型时，普通工具执行中和后台子任务运行中均收到追加输入。适配器跨波次原生复测被本地假服务的 auto-mode 分类器不可用中止，未据此宣称原生端到端通过，未改变权限策略。线上后端仍有其他助手任务，未重启；修复尚待空闲重载后生效。

## 2026-10-23 Codex：修复系统启动目录误绑导致的 setup refresh 报错

- 沙箱日志与失败会话的 `continuation.json` 表明，TUI 继承的 `C:\Windows\System32` 被保存为额外可写目录；原生 elevated 刷新尝试为它添加写 ACE，遭遇 Windows 错误 5。此次不是此前的 Node REPL 文件占用故障。
- TUI 与后端共用 `automation/workdir.mjs` 解释工作目录：办公室目录和 Windows 系统目录不作为额外项目目录；正常项目目录保持原行为。新对话不再误绑，旧会话运行时忽略历史系统目录，提示与实际工具权限一致，不改历史记录或用户级沙箱配置。实际 Codex 启动参数改变会使旧权限会话的续接签名失配，从新线程继续。
- 修复前两项回归确实失败；修复后脱敏回归 **161/161**，报告 `.runtime/test-results/2026-10-23T17-10-01-097Z-4380.json`。无模型原生沙箱连续两次读写假数据及 Node 子进程成功，证据 `.runtime/agent/runs/c44b1076-5e21-46d7-a6a7-527729319c72/native-smoke-result.json`。默认嵌套沙箱因低权限用户没有 home 而无法启动的记录另存 `native-smoke-default-result.json`，成功运行使用正常工具审批。
- 当前运行后端仍是旧代码；其他助手任务结束后重载后端，已有 TUI 重新运行 `piri` 加载前端修复。未修改系统目录 ACL、未关闭或降级沙箱、未重放失败模型任务。

## 2026-10-23 Codex：更新用户第二版曲线

- 已将用户最新保存于 `2026-10-23T08:03:11.486Z` 的曲线原样更新到 `tui/mascot-curves.json`，与 `.runtime/tui-curves/selection.json` 的 SHA-256 相同；黑位 RGB 为 `[39,26,29]`。只更新参数，不改渲染逻辑、原图或调节工具。重新运行 `piri` 加载。
- 旧应用版留在 `.runtime/agent/runs/3f7c090e-35a3-4b07-bf43-eed51d89461d/previous-mascot-curves.json`。调节页及服务继续保留。
- 用户随后明确不需要测试；此前启动的定向测试在处理停止请求时已结束，未追加验证。已有记录在 `.runtime/test-results/2026-10-23T08-04-56-082Z-4736.json`，编辑器与应用版渲染核对记录在 `.runtime/tui-curves/applied-verification.json`。

## 2026-10-23 Codex：应用用户选定曲线，保留调节工具供反复修改

- 用户告知“调好了”，并要求保留 HTML 以后反复调整。已将保存于 `2026-10-23T07:54:48.196Z` 的 `.runtime/tui-curves/selection.json` 原样接入 `tui/mascot-curves.json`，两份文件 SHA-256 相同。没有重新调色或改动用户控制点；黑位 RGB 为 `[48,35,50]`，沿用用户实际选择。
- `tui/mascot.mjs` 统一生成已应用调色板，ANSI 缩放与 `tui/hero.mjs` 的默认 Sixel 渲染共用，曲线只应用一次。保留无损原图、透明度、标题和背景；原有 CRT 光照不变。重新运行 `piri` 加载，无需重启后端。
- `tui/curve-editor.html`、配套脚本与 `node automation/run.mjs tui curves` 均保留，本机页面继续运行；未来编辑仍载入已保存参数，保存草稿与已应用版分开，用户选定后再接入。
- 脱敏定向回归 **60/60**，覆盖全部九帧、三套主题、CRT 开关、ANSI 与 Sixel 已应用调色板和单次曲线应用；报告 `.runtime/test-results/2026-10-23T07-57-58-560Z-39804.json`。另在新 Node 进程中核对默认首页渲染与用户选定的实际编辑器预览，288000 像素 RGB 字节完全相同，结果 `.runtime/tui-curves/applied-verification.json`。测试副本由入口清理，未重启用户正在使用的 TUI。

## 2026-10-23 Codex：曲线开放完整亮部和白点

- 按用户补充，曲线范围开放到完整 0–255；暗部、中间调、亮部及黑白端点均可上下调整，继续使用单调光滑三次插值。默认深棕预设保留亮部原色，但不再强制锁定。仅调整角色，不改标题、背景或原始图像。
- 保存参数改为 `version:2`、`highlightLock:null`，仍使用 `max-channel-rgb-offset`。旧页面或旧保存中的 0–128 控制点会保留并扩展亮部控制点。已重启独立调节服务并保留旧页面的提交令牌，用户可先保存未提交的调整，再刷新同一地址；未重启办公室后端或用户 TUI。
- 脱敏定向回归 **20/20**，包括亮部控制点拖动、白点数值调整、预览、保存恢复及旧参数扩展；报告 `.runtime/test-results/2026-10-23T07-31-01-888Z-29548.json`。实际页面已确认运行新版并目视核对截图 `.runtime/tui-curves/preview.png`。用户保存后，由助手读取 `.runtime/tui-curves/selection.json` 接入 TUI，不自动应用。

## 2026-10-23 Codex：独立光滑曲线调节页，非主页关闭 CRT 屏闪

- 用户希望自己调曲线，调好后由助手读取参数。新增 `node automation/run.mjs tui curves`，在本机 `http://127.0.0.1:23487` 提供 RGB 暗部曲线、原图对照、九帧选取及实际首页渲染器预览。使用单调三次插值，默认黑位为深棕 `#30231c`；按像素最亮通道生成 RGB 偏移，128–255 亮部保持原色，不改原始图片、背景或标题。可拖动、添加、删除控制点或输入数值。
- 点击“保存参数给 Codex”后写入 `.runtime/tui-curves/selection.json`（包括控制点、插值和亮部锁定方式），不自动套入 TUI。已保存的选择会在再次打开页面时载入。曲线实现位于 `tui/curves.mjs`，页面和服务位于 `tui/curve-editor.html`、`tui/curve-editor.mjs`；`renderHero` 新增可选调色板，用于同一路径预览。
- 聊天、对话列表及工具详情页不再经过 CRT 处理，也不再因 CRT 每 100ms 触发重绘；首页保留原效果和动画，正常流式回复与运行指示不受影响。现有 TUI 重新运行 `piri` 加载，无需重启后端。
- 脱敏定向回归 **58/58**，含真实 Edge 拖点、预览变化、保存读回、重新载入、窄屏布局及非主页多时间点/开机阶段无 CRT；报告 `.runtime/test-results/2026-10-23T07-20-55-188Z-47060.json`。另已打开实际本机调节页渲染并目视核对，截图 `.runtime/tui-curves/preview.png`。测试入口默认权限创建副本失败后，经正常工具审批完成；副本已由入口清理。没有接管或重启用户正在使用的 TUI。

## 2026-10-23 Codex：按用户指定调整亮部加亮系数

- `tui/hero.mjs` 的 `SCAN.lum` 从 0.05 改为用户指定的 0.35，其余参数不变。已读回核对，沿用用户要求，不运行测试或界面验收。重新运行 `piri` 加载。

## 2026-10-23 Codex：修正过暗、底部黑边与边缘脏纹

- 用户连续指出人物与标题过暗、边缘有脏纹、渐变留下黑边、面部失去原图的铁青神态。上一轮降低照明后仍叠加较深扫描线，压暗过头；底部把像素乘到接近黑色而不是混合至背景。已改 `tui/hero.mjs` 与 `tui/sixel.mjs`，本轮继续按用户要求不跑测试、预览或终端验收。
- 柔光改为 `{floor:0.86,gain:0.14}`，扫描线深度由 0.5 降为 0.28。脸部肤色/灰影区域保留 85% 原图颜色，保留刘海下灰影与下半脸肤色的区别，不用统一滤镜替代表情。标题和人物保留已有像素布局与动画。
- 底部以不透明度混合至实际 `CRT_BG`，末行不再残留近黑色；移除空白背景上的扫描线基值，只对光晕相对底色的增量调制。近底色处平滑收敛，抖动强度随光晕减弱且不允许压出黑洞。Sixel 调色板分桶改为记录真实样本均值，而非固定桶中心，避免暗部被人为改成相差数级的颜色。
- 已读回核对修改。修改前副本在 `.runtime/agent/runs/b4ef5893-7433-4a09-adc4-7817ed0f8ec9/hero-before.mjs` 与 `sixel-before.mjs`；实际显示效果尚未核对，重新运行 `piri` 加载。

## 2026-10-23 Codex：收敛首页曝光，保留冷阴影

- 用户认为人物过亮、失去面色铁青的感觉，批准按本轮评审调整，随后明确先不跑测试。本轮仅修改 `tui/hero.mjs` 并读回核对差异；没有运行测试、渲染预览或启动 TUI，画面效果尚未验收。
- 柔光参数从 `{floor:0.55,gain:0.62}` 调整为 `{floor:0.57,gain:0.34}`，峰值由 1.17 降为 0.91；扫描线亮部加亮系数从 0.2 降到 0.05，接缝深度保持 0.5。保留平滑光照、底部淡出与光晕收边。
- 去掉全局黄暖白点，改成接近中性的亮部与轻微偏青的阴影；高光肩部按 RGB 峰值生成共同缩放系数，避免各通道分别压缩导致漂白。光晕只由经过局部光照后的较亮像素产生，人物和标题本体不再叠加有序抖动，周围渐变继续保留。
- 修改前副本：`.runtime/agent/runs/6a15d8fe-dd8d-4121-8b3b-9ac7837319c3/hero-before.mjs`。重新运行 `piri` 后加载改动，无需重启后端；视觉比较与回归留到用户恢复验证时继续。

## 2026-10-22 Codex：TUI 九帧慢速角色与重绘首页标题

- 用户要求替换 TUI 图标、重做首页大标题，并指定 Claude 完成类似《动物井》的老电视扫描线与其他做旧特效。本轮完成图标和标题，特效交给 Claude 接续。
- 使用用户最后补充的 `1ca7a63f-6a75-41ee-b7b7-22bdf0b8ad3c.png`。原图存 `tui/assets/mascot-sheet.png`，九帧按从左到右、从上到下提取成无损调色板数据 `tui/assets/mascot.json`；纯 ANSI 半块渲染，500ms/帧、4.5 秒循环，空闲首页也播放。保留透明背景，按空间使用 32/24/16 像素尺寸；小高度回到文字标题，为多行草稿和光标留位置。标题重绘为七像素字形的 PIRI / OFFICE，不改名称和对话路由。
- 脱敏定向测试 **52/52**，报告 `.runtime/test-results/2026-10-23T04-53-43-353Z-20088.json`。真实隐藏控制台运行 4.77 秒，TTY=true、退出码 0，无后台任务且未到首次状态轮询即输出 10 次不同绘制，证据 `.runtime/tui-mascot-native-smoke.json`。ANSI 视觉预览 `.runtime/tui-mascot-0.png`、`tui-mascot-1500.png` 已看；它们是终端控制序列的浏览器预览，不是用户终端截图。没有操作用户当前窗口。
- 测试入口首次将副本放在源码子目录，因 Node 不允许自复制而失败；恢复默认位置后遇到目录权限，走正常工具审批完成测试。测试副本由入口清理。重新运行 `piri` 加载前端改动，无需重启后端。

## 2026-10-22 Codex：TUI 控制台操作不再启动 PowerShell 脚本

- 用户要求不再弹 `console-mode.ps1` 的 Security warning。该文件无来源标记，单文件解除阻止和显式本机标记在原主机策略下都未解决执行拒绝；无效标记已撤销，未更改系统或用户执行策略。
- 控制台辅助入口改用本机已有的 Python（当前 PATH 为 `C:\Python314\python.exe`），通过标准库 ctypes 调用同样三个 Win32 API，保留读取、鼠标、原生拖选和原值恢复。启动/切换和 `/keys` 均走 `tui/console-mode.py`，不再启动 PowerShell 脚本，不加策略覆盖或自动解除阻止。旧 `.ps1` 删除被文件工具拒绝，已无生产调用，不强制删除。
- 脱敏定向回归 **50/50**，报告 `.runtime/test-results/2026-10-23T03-22-37-599Z-46568.json`。新增回归在独立隐藏的真实控制台，以独立 Win32 读回核对模式切换和退出恢复；辅助进程无需 PowerShell 脚本或策略覆盖。当前旧 TUI 未重启；已显示的旧警告选 D，退出后重新运行 `piri` 加载新实现，无需重启后端。

## 2026-10-22 Codex：PIRI 默认滚轮与输入框点击定位

- 用户报告 TUI 滚轮再次失效，并要求鼠标点到输入文字哪里就从哪里输入。前一次为原生拖选默认关闭捕获，导致应用收不到滚轮/点击；输入框也尚无点击定位处理。现默认启用捕获，Alt+M 或 `/mouse` 仍可切回原生拖选。帮助与命令说明已同步；不改变后端接口和刷新频率。
- 输入框按实际终端单元格映射到原始草稿位置，保留空格、换行和 UTF-16 偏移，支持中文与 emoji；首页居中、聊天侧栏和多行折行共用同一份定位布局。移动到长草稿前面时显示区域跟随光标。控制台辅助脚本不再带执行策略覆盖参数。
- 新回归在修复前复现三项失败；最终源码的脱敏定向回归 **49/49** 通过，报告 `.runtime/test-results/2026-10-23T03-12-43-243Z-40124.json`。独立假数据控制台实机验收没有取得滚轮/点击的有效证据，不计为通过；本轮测试窗口和进程已清理，未向真实对话发送消息。当前运行中的 TUI 未重启，重新运行 `piri` 才加载本次前端修复，无需为此重启后端。

## 2026-10-22 Codex：PIRI 恢复和切换对话时沿用后端工作目录

- 用户确认 TUI 新对话绑定启动文件夹，已有对话保留原目录，让终端入口与 WebUI 的使用方式区分开；不改变 WebUI 新建对话的行为，也不把助手进程的启动目录改到外部文件夹。
- 修复两处断点：`dashboard/ui-state.mjs` 的精简对话索引现在保留 `session.workdir`；`tui/app.mjs` 标题直接读取该记录，不再读取或保存偏好文件里的 `workdirs` 缓存。没有绑定目录的旧对话不会继承当前启动目录；新对话仍发送启动目录，续聊不改绑定。
- 脱敏隔离定向回归 **69/69**，包括真实新进程 HTTP 后端到 TUI 的中文目录恢复、来回切换、过期缓存忽略、无目录会话、新建对话及原绑定不变；既有 WebUI 状态与嵌套交接测试也通过。报告 `.runtime/test-results/2026-10-23T03-09-14-790Z-37352.json`，完整输出 `.runtime/tui-workdir-verification.log`。测试副本已由入口清理。
- 在线后端尚未重启（仍有助手任务运行）；待任务与后台空闲后用 `/reload` 重启后端，再重新运行 `piri`，两端一起加载此修复。“有些指令运行不了”的具体指令和报错仍未提供，本修复不作为该问题已解决的依据。

## 2026-10-22 Codex：PIRI 首页精简、自动跟随回答者、恢复原生选字

- 用户希望首页简洁，只留有特色的标题、三位助手剩余容量和初始输入框；现移除首页的今天/待办、日期统计、回答者选项排和快捷入口排，保留圆角输入框与底栏。Claude/Codex 显示最紧的账号额度窗口，DeepSeek 显示 API 余额；窄屏分行，工作文件夹移到底栏。不新增接口、模型调用或刷新周期。
- 原因：旧版持久保存 `target=Codex`，每次发送都补 `@Codex`，盖过后端跟随上一位的路由。现启动时自动跟随，底栏及输入颜色显示实际上一位回复者；Alt+1…4 或 `/who` 只指定下一条，发送成功恢复自动，显式 @ 优先。旧 target 偏好不再读取/保存，路由仍由原后端负责。
- 旧版持续启用鼠标捕获并关闭经典控制台 Quick Edit，普通拖选被挡住。现在默认关闭捕获、启用原生选字；Alt+M 或 `/mouse` 切换滚轮/点击模式，↑↓/PgUp/PgDn 保留。状态刷新不再重开捕获，退出恢复原始控制台输入标志。
- 脱敏 TUI 定向回归 **46/46**；真实后端 110×30 和 40×12 首页帧已核对，预览 `.runtime/tui-minimal-home.ansi`、`.runtime/tui-minimal-narrow.ansi`。独立隐藏的真实控制台运行通过启动/切换/刷新/退出检查：默认及刷新后 `0x2C8`（Quick Edit=1、鼠标事件=0），捕获时 `0x298`，退出恢复原值 `0x1F7`；此检查核对模式与控制序列，未在用户窗口手工拖选。证据 `.runtime/tui-console-smoke.json`，回归报告 `.runtime/test-results/2026-10-23T02-16-56-750Z-23400.json`。重新运行 `piri` 生效，不需要重启后端，也没有接管用户当前窗口。

## 2026-10-22 Codex：PIRI 输入框改为参考图的细线圆角框

- 按用户提供的 `屏幕截图 2026-10-22 205525.png`，把首页和对话页原来的两条分隔线改成完整圆角细边框，保留左侧提示符、回答者配色和提及高亮；边框颜色更淡。单行仍占 3 行，多行随草稿展开，文字和光标为边框留出空间。不改发送、滚动或后端。
- 脱敏定向回归 43/43，覆盖三套主题、窄屏、侧栏、多行、空输入和满行光标；真实后端首页及对话页 110×30 快照已核对。报告 `.runtime/test-results/2026-10-23T01-57-30-976Z-4412.json`；预览 `.runtime/tui-rounded-home.ansi`、`.runtime/tui-rounded-chat.ansi`。重新运行 `piri` 生效，不需要重启后端；未接管用户正在使用的窗口。

## 2026-10-22 Claude / Codex：PIRI 输入与回复样式收尾

- 用户希望输入框和输出区更有特色，保持简约、不扩成完整 WebUI。接续 Claude 已写入的样式：输入分隔线按回答者配色，正文中的 `@Claude / @Codex / @DeepSeek / @all` 分色；运行中用 `↳` 提示追加，命令用 `⌘`。三位助手分别用 `✻ / ◆ / ◈` 标记，最终回复显示该任务耗时；代码围栏带语言标签与细边线，diff 保持红绿配色。
- Codex 补齐样式回归，并修正耗时统计：只把助手的最终回复当作结束，系统通知不占用最终回复的位置。没有新增后端接口、模型调用、依赖或刷新机制。
- 验证：脱敏定向回归 42/42（TUI 32 项及测试入口 10 项）；真实后端的本对话 130×34 帧与首页快照成功生成。测试报告 `.runtime/test-results/2026-10-23T01-50-57-786Z-44476.json`，对话预览 `.runtime/tui-style-chat.ansi`；未操作用户当前 PowerShell 窗口。样式由 TUI 进程加载，退出后重新运行 `piri` 生效，不需要重启后端。

## 2026-10-22 Claude：终端界面（piri）可在任意文件夹启动，助手读写该文件夹

- 依据：用户希望在各个文件夹下直接启动终端界面，让助手获得查看、编辑当前文件夹文件的能力。
- 改动：对话请求新增可选 `workdir`（绝对路径的已有文件夹）。`agent/run.mjs` 的 `submit` 只在**新建对话时**把它记到 `session.workdir` 并校验（不存在或不是文件夹则拒绝；等于办公室根目录则不记）；已有对话保持原文件夹，换文件夹不会改变一条原生线程的沙箱。`execute` 把 `workdir` 交给执行器；`agent/claude.mjs` 用 `--add-dir` 加入，`agent/codex.mjs` 把它加进 `sandbox_workspace_write.writable_roots`，两家进程仍从办公室根目录启动（办公室命令、AGENTS.md 注入、线程续接都不变）。新增片段 `turn/workdir`，只在新线程的首个完整提示里说明文件夹。DeepSeek 暂不接入。
- 终端界面：`piri` 不再切到办公室目录，在哪运行就以哪个文件夹为工作文件夹；首页和对话标题显示它，新对话带上它，已有对话不再发送。
- 验证：新增 `automation/workdir.test.mjs`（4 项）和 `tui/folder.test.mjs`；脱敏副本里 `agent.test.mjs` **127/127**，prompt lint 无错误。真实调用：Claude 在办公室目录启动、`--add-dir` 另一个文件夹，读取并追加成功；Codex 带 writable_roots 写入成功（不带时在本机配置下也写成功，未能证明必须加）。在线后端需空闲后重启才用上；重启前带 `workdir` 的请求会被忽略该字段，不报错。

## 2026-10-22 Codex：为正式 DeepSeek 聊天安装 dsh-ops

- 用户指定的 `dsh-ops@0.4.1` 已通过官方 CLI 安装到用户 `sdk` profile，保留插件默认开关与官方文件／PowerShell 工具，不改变沙箱或审批策略。每轮新进程会自动加载，无需重启办公室后端。
- `software/deepseek-harness/ask.patch.yml` 关闭新增的四个 OPS 工具组件，维持 ask 无工具行为；补充对应配置回归，更新 Harness README 的安装与验证记录。
- 真实聊天 adapter 的 OPS 中文读取、原生中文写读、办公室 pwsh 命令、OPS Bash 共五次工具调用成功；work/ask 实际合成配置已核对。脱敏定向测试 **17/17**，prompt lint 无错误、snapshot 29 案无变化。备份与证据在 `.runtime/dsh-ops-install-20261022/verification.json`，测试报告 `.runtime/test-results/2026-10-22T23-02-58-244Z-23480.json`。

## 2026-10-22 Claude：点掉决定卡片时，对应的“等你”步骤一起结束

- 依据：pkg-claude-020 和 Discord 测试都是用户早已点过验收、步骤却一直停在 `waiting_user`。原因是 `acknowledgeInbox` 只改 `review.state`，`waiting_user` 只有助手回合收尾时才会改，两个状态各管各的。
- 改动：`dashboard/inbox.mjs` 的 `acknowledgeInbox` 对 `waiting_user` 的步骤，在能通过 `validateOutcome` 时同一次 `update` 里把状态改成 `done`（还欠产出的保持原状，卡片照样验收）；`undoAcknowledgment` 一并恢复状态。
- 验证：新增 `dashboard/ack-status.test.mjs`（3 项）；与 `agent`、`ui-state`、`codex-output`、`efficiency` 的脱敏定向测试共 143 项通过。在线后端要重启后才用上新代码。

## 2026-10-22 Codex：启动与重启不再要求输入两个 R

- 用户明确授权后，为 `dashboard/server.mjs` 的重启命令、`dashboard/Start-Dashboard.vbs` 和 `remote/Start-Discord.vbs` 加上进程级 `-ExecutionPolicy Bypass`；不改变系统／用户级执行策略，不批量解除其他文件的下载标记。
- 脱敏定向回归 **15/15**。在重启入口与其加载的 `Backend.ps1` 上同时写入并读回真实 `Zone.Identifier`，经网页／HTTP／cmd／PowerShell 链路完成两次重启；两个原样 VBS 入口对带标记的无害脚本与加载脚本也无需交互运行。原有托盘单实例、任务保护、草稿保留及离线 Discord 生命周期均通过。报告 `.runtime/test-results/2026-10-22T22-31-15-952Z-8312.json`，副本已自动清理。
- 当前真实后端仍是旧进程；还有助手任务运行，未重启。VBS 下次启动即使用新参数，后端重启命令需空闲重载后生效。已同步 `help dashboard`。

## 2026-10-22 Claude：任务队列拆成步骤和对话轮两个文件

- 依据：用户指出 `work/queue.json` 实打实地旧。数过：3856 条里 3822 条是聊天消息留下的对话轮记录，真正的步骤 34 条，周计划和看板只用后者，只有后者有人维护；两种东西混在 9.8 MB 一个文件里，对话轮记录的失败、等待状态看上去像一堆过期待办。
- 改动：`automation/files.mjs` 在 `work/turns.json` 存在时把 `work/queue.json` 读成合并的一份、写时按 `isTurnRecord` 拆开（步骤优先，对话轮日志内容没变就不重写），其余 70 多处调用不用改；`work/run.mjs` 新增 `splitQueue`（一次性迁移，旧文件留在 `.runtime/work-edits/queue-before-split-*.json`）；`dashboard/server.mjs` 启动时迁移；`dashboard/Backend.ps1` 判断是否有助手任务在跑时同时读 turns.json；`scripts/run-tests.mjs` 脱敏副本同步清空 turns.json。`work split` 可手动运行。
- 验证：`work/queue-split.test.mjs`（2 项）脱敏定向通过；用真实队列副本演练迁移，3856 条逐条内容一致、顺序一致，queue.json 85 KB、turns.json 9.6 MB。与收件箱相关的 `agent`、`ui-state`、`calendar` 测试 151/151 通过（该次改动前的收件箱代码）。未跑全量。
- 边界：在线后端仍是旧代码，迁移在下次后端重启时自动发生；重启前 `work/queue.json` 仍是单文件。

## 2026-10-22 Claude：DeepSeek 上下文长度补全窗口与分项

- 依据：用户让做 DeepSeek 的上下文长度模块。原来 DeepSeek 只有请求 token 总数，概览栏没有窗口、没有分项。
- 改动：SDK 的 `request/context` 事件自带 contextWindow（deepseek-flash 为 1,000,000），`deepseekEvent` 转成 window 上报，概览栏显示 “tokens / 1M · 百分比”；DeepSeek 没有可读的原生记录，`context-breakdown.mjs` 新增 `deepseekTracker`，在事件流经时累计用户消息、文字、推理、工具调用与结果的估算，用首末两次请求的真实用量按原方法标定固定开销，`invokeDeepSeek` 返回 `contextBreakdown`，`agent/run.mjs` 在 deepseek 轮次结束后写入 parts。不新增模型调用、轮询或重试。
- 验证：`agent/deepseek.test.mjs`（新增 1 项，6 项）与 `dashboard/deepseek-chat.test.mjs` 脱敏定向通过（17/17），未跑全量。用已有两份真实 DeepSeek 事件记录回放：窗口 1000000，分项相加等于最后一次请求总量（5105、5435），固定开销约 4.7k，两次一致。
- 边界：真实界面上的分项条要等后端重启并跑一轮 @DeepSeek 后才能看到（在线后端仍是旧代码）；子 agent 事件、图片 token 按固定估算，分项为估算值。

## 2026-10-22 Codex：DeepSeek 人设统一到用户级全局指令

- 个人人设原文迁至 `~/.dsh/AGENTS.md`，正式聊天改用原生用户级 home；办公室 `chat.patch.yml` 只留三位共用的工作要求。ask 仍关闭指令发现，独立委派仍保留隔离 home，不改权限策略或增加模型调用。
- 原生指令加载器已读到全局人设与项目指令，迁移前后人设原文逐行一致；脱敏定向回归 **44/44**，prompt lint 无错误、29 个 snapshot 无差异。证据 `.runtime/agent/runs/620579f3-7ea2-41f1-af9d-f97b97319913/native-global-verified.json`；报告 `.runtime/test-results/2026-10-22T21-23-32-570Z-26032.json`。下一个正式工作轮由 Python 入口直接读取新配置，无需重启办公室后端。

## 2026-10-22 Claude：DeepSeek 回复不再重复；头像可在设置里调

- `agent/deepseek.mjs`：DeepSeek 每段文字原先立即存成过程文字，最后一段又作为最终回复再存一次，对话里出现两遍。现与 Claude／Codex 一致：最后一段文字扣住当最终回复，只有后面还跟着工具调用或下一段文字时才作为过程文字发出。真机验证：先说话、调用工具、再回复的一轮，过程文字只有开头一句。
- 设置页新增“头像”标签（`dashboard/avatar-tuner.js`、`dashboard/avatars.mjs`）：一行四个头像，点“更换”选图后在圆形裁剪窗口里拖动、缩放取景，确定后浏览器裁成 256×256 上传；存 `dashboard/avatars/custom/<谁>.*`，`dashboard/avatars/view.json` 记录谁换过，经 `/avatars/view.css` 的 `content:url()` 在所有 `img[data-who]` 上生效。“还原默认”删掉上传即可，出厂头像文件不动。DeepSeek 出厂图改为脸部特写（原图备份在 `.runtime/avatar-edits/`）。测试 `dashboard/avatar-tuner.test.mjs`。

## 2026-10-22 Codex：DeepSeek 第三位正式聊天同事接入

- 后续用户批准管理员级初始化，已通过官方 `AclWriteGrant` 为办公室工作区物化持久授权，保留原 owner 和其他 ACL。继承的 Low 标签会让工作区内的 venv 启动器把 SDK 宿主也降为 Low；两入口改用该 venv 的基础 Python + 原 site-packages，仍使用官方 workspace-write 工具策略。真实普通宿主的办公室 CLI 与中文读写已通过，最新 software 专项 **27/27**；后端空闲重载/正式聊天报到的一次性接续记录在 `.runtime/agent/runs/6536797d-06d0-40b8-aad8-ad88a0015b98/post-restart.json`。

- 新增 `@DeepSeek`、三人 `@all` 顺序发言、默认跟随上一位及真实交接来源；接入官方 SDK 的办公室工作目录、完整历史 fresh 轮、独立记忆 owner、原生工具轨迹、终止和真实用量。不新增自动群聊、模型重试或后台调用，原独立委派入口不变。
- 输入框、原头像、姓名、上下文、项目/任务归属与提示词页面识别第三人；设置增加 DeepSeek 模型和原生 off/low/high/max 强度，不混用另一侧的 medium/xhigh。
- 接入阶段受影响范围脱敏 **203/203**，`prompt lint` 无错误、29 个 snapshot 无差异；真实 Edge 手机截图已核对。早期 shell 两次独立验收被 Windows ACL 初始化拒绝，后续授权与修正见本节首条。证据：`.runtime/agent/runs/1c7e7975-dba2-4da6-a363-86bf74a4caff/DEEPSEEK-CHAT-STATUS.md`。
- 回归中原 UI 测试的“每次 projects 刷新必读整份文献库”断言与既有缓存实现冲突；改为验证完整返回数据和无跨页读取，未改文献实现。自身 `--keep` 的 17 个副本已清理，报告和截图保留。

## 2026-10-22 Codex：文献 API 工具导航与 WoS 查询入口

- 新增 `node automation/run.mjs literature wos "<WoS查询>" [--limit=1..50] [--page=1..] [--sort=TC+D]`：显式查一页题录与被引次数，返回官方记录、查询时间及额度余量；不自动翻页、重试、写 catalog 或下载全文。优先读取 `WOS_API_KEY`，否则使用本机 `wos.credentials.local.json`；密钥不进入输出，认证／限流等失败保持非零退出。
- `help literature` 开头与 `literature/README.md` 顶部补上按用途选工具的入口，列出 WoS、OpenAlex、Crossref、Springer 摘要、Zotero 全文和 Wiley TDM。Wiley 的 token 路径、官方调用方式及“已保存、尚未 API 实测／未接入”状态已写清；原有 `fetch` 路线不变。
- 脱敏定向测试 **143/143** 通过（WoS 8 项、原全文 125 项、runner 10 项），报告 `.runtime/test-results/2026-10-22T19-29-25-066Z-21496.json`；正式 CLI 单次 DOI 查询成功返回真实题录、被引次数及每日 5,000 次额度，证据 `.runtime/agent/runs/6f163ee2-6859-4934-9409-a0645f03fe77/wos-cli-smoke.json`。默认权限首次在副本目录创建处被拒，正常授权后测试跑完并自动清理副本；无新增模型调用或后台任务，CLI 无需重启后端。

## 2026-10-22 Claude：对话、项目、文献、提示词页加载变慢的修复

- 文件状态基线不再扫描 `output/`、`tmp/`、`workspace/archives`（原每个工作轮同步哈希约 2.7 万个文件，阻塞后端约 2.6 秒；现约 1000 个文件、0.37 秒）。
- `/api/state?page=projects` 不再带整份文献库（约 81 MB），只带关联到项目的论文，文献库按文件大小与修改时间缓存；`literature/view.mjs` 的列表来源同样按输入文件的大小与修改时间缓存，翻页或搜索由约 0.7 秒降到约 0.07 秒。
- `prompts/run.mjs`：`fragments()` 不再对每个片段重读全部片段，`lint()` 只扫描一次代码与常驻文件；提示词总览由约 10 秒降到约 0.5 秒。输出内容不变。
- 清理：孤立的文件基线（约 1.3 GB，957 个）、已完成的交接定时器和旧的零散脚本都移到了 `.runtime/archive/stale-20261022/`（删除操作被权限拦下，未真删；确认后可整目录删除）。
- 未跑测试套件（用户当前要求暂不跑全量）；后端需空闲重启后生效。

## 2026-10-22 Codex：去掉提示词运行页的两处标签

- 按用户圈图移除“真实运行透视 · 应用层”和“本轮文字”，保留助手、轮次、字数、运行 ID、来源分块及原样全文；不改提示词内容。刷新网页生效。
- 脱敏定向回归 13/13 通过，真实 Edge 覆盖原样全文与来源分块中标签及空标题元素消失、正文与切换保持正常；当前办公室 HTTP 已返回修改后的脚本，无需重启。报告：`.runtime/test-results/2026-10-22T18-56-59-496Z-43372.json`。

## 2026-10-22 Codex：全量测试修复、精简与逐文件隔离

- 默认全量改为按复制边界自动发现 `*.test.mjs`，从 64 个文件补齐到 68 个（原漏测的 companion 3 个文件，以及新增 runner 回归）；Docker 仍明确单独用 `--sandbox`。专项选择集中在 `scripts/test-suite.mjs`，修复 `--usage` 未参与互斥校验的问题；新增 `--help`、只读 `--list` 和 `--files=路径,...` 定向复验。
- 每个文件都从不再修改的脱敏基线建立自己的副本和 Node 进程，`--jobs=1` 也不共享模块缓存或上一个文件留下的配置、队列、运行时文件；默认完成即清理。修复原 worker 复用磁盘副本导致的 notes、PowerShell、speech 等顺序污染，并增加先污染一份、下一份仍干净的回归。复制／清理异常先等其他 worker 结束，不删除它们仍在使用的现场。
- 复制排除 `literature/archive` 和顶层 `tmp`，不再把归档全文、旧题录和科研预览带入副本；初始复制清单的实测文件体积从 311,510,413 bytes（297.1 MiB）降至 10,914,330 bytes（10.4 MiB），约减少 96.5%。真实科研原件未修改。
- 完整汇总日志、逐文件实时日志和 JSON 报告统一留在 `.runtime/test-results/`，不再依赖 `--keep`；流输出使用 UTF-8 分块解码，非零退出、信号终止、零测试和取消不会误报成功。
- 修复三处实际行为：Claude 交接识别正则里的退格字符改回词边界；`agentSnapshot()` 与其他会话读取一样先应用待写流事件，实时查询不再读到旧状态；设置页保留未保存表单，清理旧的干净控件后再加载，离开技能页再返回不会覆盖草稿。顶栏为导航留出可滚动空间，1100px 下不再横向溢出或把文字挤成竖排。
- 清理已过时的提示词短语、默认提示长度和软件验收类型断言；技能检查只判自己的夹具，余额夹具归还原始文件。旧响应测试等待实际完成或取消，文献空结果等待完成态而非加载中零行，设置草稿在加载完成后再验，保留相应覆盖。
- 最终默认全量 **857/857、68 文件、4 并发、209.2 秒，失败／取消／跳过均为 0**；真实离线 Docker 专项 **13/13、19.8 秒**（含 10 项 runner 检查）。无真实模型调用。全量对应 Chicago 14:00:59 的固定脱敏快照；Claude 14:04–14:05 更新的 `prompts/run.mjs`、`literature/view.mjs` 在该次快照之外，未算作本轮全量已覆盖。报告：`.runtime/test-results/2026-10-22T19-00-59-616Z-39532.json`、`2026-10-22T18-51-55-030Z-40900.json`。验收记录、源码哈希、截图及失败基线完整日志在 `.runtime/agent/runs/a57de5f5-96f7-4d46-a454-f02829836427/`。
- 已同步 `edit-and-verify-office-code` 的自动发现和日志入口；旧 skill 目录保存在 `.runtime/skill-edits/edit-and-verify-office-code/2026-10-22T1842-test-suite/`，Codex 本体和 Claude 链接内容哈希一致。本轮用了 2 个只读子 agent 审查清单、复制边界和慢路径，主助手完成修复和实际复验。自留测试副本已清理；真实后端未重启，运行时修复待空闲重载。

## 2026-10-22 Codex：嵌套 handoff 的整链状态与展示

- 修复原先只看直属子对话的问题：父对话、各层交接卡片的运行／排队状态及未读提示沿整个后代链汇总。后端按当前打开的分支携带所有层级的消息和任务详情，界面递归展示，仍按来源轮次放置，可逐层展开或进入独立页；不改写各轮任务自身的完成记录。
- 脱敏副本新增投影与真实 HTTP／Edge 回归，覆盖四层交接、只有最内层运行、排队、结束、最内层最终回复的未读及已读、展开保持、刷新和独立页来源。新用例与原单层用例定向 4/4 通过，截图已查看。把副本中的侧栏汇总临时退回旧的一层逻辑后，新 UI 用例在外层运行提示处失败，复现原漏报；未改真实数据。
- `--handoff --keep` 共 12/13 通过；唯一失败仍是 `automation/handoff.test.mjs:77` 对旧提示词短语“让你保守工作的语句”的断言，与本次改动无关，未修改。测试日志、截图在 `.runtime/agent/runs/435fc2ea-2e4e-441e-8217-f156bf6cbe64/`。同步 `help agent`；真实后端尚有助手任务运行，未重启，整链详情投影需空闲重载后生效。

## 2026-10-22 Codex：子 agent 总卡片与历史隔离

- Codex 原生子线程接入已有子任务卡片，用线程 ID 关联过程和最终结果，保留原生回传与主助手最终回复判定；Claude 仍沿用自己的 Agent/Task 接口。原生事件未提供的 Codex 任务说明不补造。
- 按主助手任务轮次及来源合成默认收起的总卡，显示“已完成 x/y”，运行中、失败和已结束另列，展开后查看各子任务。已标记但缺少独立归属的旧发言收进历史记录，不猜测身份、不计入任务数量，也不删除原记录。
- 两家子 agent 原始发言均不再额外拼进后续主聊天历史，覆盖新线程、续接和换助手；主助手自己的进度和汇总仍保留。同步 README 与 `help agent`。
- 最终定向测试 11/11 通过：原生事件／持久化／历史隔离 7 项，真实 Edge 会话与分组卡片 4 项；核对动态分母、成功／失败／停止区别、轮次隔离、展开及刷新，已查看截图，8 份受测源码哈希一致。证据：`.runtime/agent/runs/6dcca5ca-e2bf-4b6b-9697-1144a6e4c969/`。旧代码对照能复现历史注入及散落消息，日志在 `.runtime/agent/runs/0da887b6-7acf-4933-bb73-051460136ce1/`。
- 扩展 `--activity` 结果为 169 通过、3 失败、1 超时，未全过：提示长度断言、拥堵等待停止断言、Claude 后台交接超时、活动栏心跳记录缺失。长时间未结束后仅停止了已核对的测试进程树，未改这些路径。初次临时验收遗漏身份环境清理，以及分组后等待折叠元素可见的问题，均已修正并重验。无新增模型调用、轮询或子 agent；未重启真实后端，后端空闲重载后启用新的归属记录和历史筛选，前端刷新可显示总卡。

## 2026-10-22 Codex：预告进度条轻扫亮光

- 按用户要求，在有效额外预告期间给 Codex 进度条已填充部分增加每 4 秒轻扫一次的亮光，保留文字流光，不加框或底色。不改变实际剩余额度宽度或低额度警示色；预告失效后撤下，减少动态效果时隐藏亮光。
- 脱敏额度回归 39/39 通过，真实 Edge 核对亮光移动、13% 填充宽度与底色保持、Claude 不受影响、无效预告撤下及减少动态效果；截图已查看。日志和截图在 `.runtime/agent/runs/f22729bb-3a5e-4c49-b801-70df2a437934/`，刷新网页生效。

## 2026-10-22 Codex：预告改为仅文字流光

- 按用户调整，只让顶栏“重置……前 · 预告”文字呈紫绿流光，去掉额度区框、底色、外发光和星光，并移除首次星光的本地记录逻辑。额度数字、进度条与普通重置时间不变，预告失效即恢复普通文字；减少动态效果时显示静态紫色字。
- 脱敏 `--usage --keep` 回归 39/39 通过；真实 Edge 检查文字渐变实际移动、无框无底色、轮询不重建动画节点、失效撤下与减少动态效果，截图已查看。结果在 `.runtime/agent/runs/8fd3ef0d-3332-49f1-aba3-facbccfb47ad/`，刷新网页生效，无需重启后端。

## 2026-10-22 Codex：额外重置预告柔光与首次星光

- 有有效额外预告时，顶栏 Codex 额度区显示紫绿柔光与缓慢流光，仍明确标注“预告”；低额度颜色及悬停里的自然重置时间保持不变。预告失效、无预告或读取失败时撤下效果；时间未解析时不亮起。
- 首次发现一条预告时闪过三颗星，以浏览器本地记录避免刷新、轮询或同一预告恢复后反复播放。未变化的额度节点不重建，流光不被现有 5 秒状态刷新重启；系统选择减少动态效果时只保留静态柔光。没有新增模型调用或定时器。
- `node scripts/run-tests.mjs --usage --keep` 脱敏副本回归 39/39 通过；真实 Edge 覆盖首次／再次／新预告、无效预告撤下、减少动态效果，以及 Codex 额度刚更新但额外预告已过期时仍发起刷新（验证了 Claude 此前的刷新修复）。日志与已查看截图在 `.runtime/agent/runs/7c624dcf-1e3e-49e7-a82e-7d78f77d36f3/`。刷新办公室网页后生效，无需重启后端。

## 2026-10-22 Claude：定时交接模块 trigger

- 用户要求基于 handoff 做定时触发模块。新增 `node automation/run.mjs trigger add|list|show|cancel`（`help trigger`）：助手登记 {at 或 in_minutes, text, title?…}，到点由后端现有 10 秒节拍调用 `sendChat`（与 `agent handoff` 同一路径），以登记时的助手身份和来源任务新开交接对话。数据在 `.runtime/trigger/triggers.json`。
- 边界：只触发一次，不循环、不重试；发送前先写 firing，崩溃只记 failed 不重发；后端当时没运行，晚到 `grace_minutes`（默认 120）内补发，超过记 missed 不发送。等待期间无新增进程、定时器或模型调用。
- 验证：`run-tests.mjs --handoff` 中 `trigger/trigger.test.mjs` 4/4（到点触发一次、未到点不触发、宽限内外、取消、失败不重试、firing 中断、参数校验）；CLI add/list/cancel 真机冒烟通过。同一次运行里 `automation/handoff.test.mjs:77` 对旧提示词短语的断言失败，改动前就存在，未处理。提示词 lint 无新增，快照无变化。后端需空闲重载后才会开始检查到点项。未改 `scripts/handoff-at.mjs` 和 Codex 的一次性脚本。

## 2026-10-22 Codex：一次性定时交接唤起

- 用户要求 03:31 自动唤起 Claude 接着修复交接块。新增 `scripts/handoff-at.mjs <UTF-8 schedule JSON>`，格式 `{at: "含时区的 ISO 时间", request: {title, text}}`，等待期间不调用模型，到时仅调用一次现有 `agent handoff`；状态及回执写在 schedule 文件旁的 `.state.json`。
- 独立进程运行，不依赖 Claude 会话存活；电脑需保持唤醒、办公室后端需运行。无重试、轮询或周期任务，不改 prompts。增量用例覆盖等待、不提前发起、已结束来源任务的身份、Claude 路由与重复启动。


