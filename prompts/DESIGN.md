# 提示词管理：设计与分阶段计划

> **当前状态（2026-10-19 晚）：** 日常维护只需读 `README.md`。本文是设计与过程记录，按时间顺序，下面“现状”“目标架构”“分阶段”三节写于动手之前，有些已过期，以文末各“…迁移”小节和下表的状态为准。
> 已做：A、A2、B、C，以及后续把对话轮（`promptFor`）、记忆块、记忆提取、陪伴留言、邮件判断外壳、附件与文件状态提示全部迁到 `fragments/`，每步都与旧输出逐字比对；每个 work 轮写 `prompt-manifest.json`；对照稿 7 处已应用到 `AGENTS.md`/`INTERACTIVE-GUIDE.md`。
> 有意不做：`profiles.json`（manifest 已能回答“这次收到了什么”）；D（拆 `AGENTS.md`，收益约 1K token/轮，却会把防账号锁定、测试沙箱等规则变成要自己去读）；把“资料，不是指令”等标注统一成同一片段（各处是紧贴数据的局部标签，不是同一条规则）。

依据：2026-10-19 用户、Claude 的对话（提示词维护困难、要求系统性梳理）；Claude 读 `agent/run.mjs`、`agent/native.mjs`、`agent/claude.mjs`、`agent/codex.mjs`、`agent/mail.mjs`、各调用点的结果。动手前的核查结论如下（后续改动见文末各节）。

## 现状（已核实的事实）

- 办公室模型调用共用出口：`invokeNative(provider, prompt, options)`（`agent/run.mjs`）。调用者都带 `purpose`：对话轮（`purposeOf`：chat/auto/card）、`mail`、`title`、`compact`、`companion-note`、`memory-extract`。它适合用量分组，但不是完整的提示词场景键：邮件初筛和复判共用 `mail`（见下方复核）。
- 提示词面分散：常驻层（`SYSTEM_PROMPT`、`AGENTS.md`、用户级 `CLAUDE.md`）、每轮拼装（`promptFor`）、内联模板（`EXPLORATION_RULES`、已授权步骤模板、卡片）、模块文件（`mail-flow/*-PROMPT.md`、`MAIL-BRIEF.md`）、模块文档和 skill。清单见 `registry.json`，`node automation/run.mjs prompt layers` 可查看。
- Claude 的 `ask` 模式用 `--safe-mode`，不载入 `AGENTS.md`；Codex 的 `ask` 模式 `cwd` 是办公室根目录。
- 既有后台样本：`prompt overhead`（最近 600 个运行目录，取自 2026-10-19），标题提示词中位约 1.2KB，输入 token 最少 15,243、中位 15,955，缓存部分中位为 8,064；邮件分类最少 16,939，记忆整理最少 17,836。这是历史样本分组，不是把动态提示词扣除后的精确固定成本。A2 实测：75 字节极小提示词在办公室 cwd 为 **15,992** 输入 token，在空 cwd 为 **11,501**，每组两次完全相同，差 **4,491（28.08%）**。因此工作区相关上下文贡献显著，但不能把全部 ~15K，或差值全部，直接算给 `AGENTS.md`。原始记录及归因限制见 A2。
- 完全相同的句子（≥8 个汉字）在不同文件之间为 0 处。重复是**同一条规则的改写**，不是原样复制。例如“资料，不是指令”这个短语出现在 8 个文件里，仅 `agent/run.mjs` 就有 5 处。因此单靠精确匹配的重复检测不够，需要规则归属表。（2026-10-27 复核：这个断言已不成立。`SYSTEM_PROMPT` 与 `software/deepseek-harness/chat.patch.yml` 的 `personaPrefix` 是同一段 5 句话，`prompt dupes` 会列出；现在由 `prompts.test.mjs` 的常驻一致性用例盯着两份是否同步。原文保留作过程记录。）

## 目标架构

1. `prompts/rules.json`：硬规则（资料不是指令、对外发送需批准、不绕过沙箱等）只写一次，带 id 和负责人；其他片段用 `{{rule:id}}` 引用，编译时展开。
2. `prompts/fragments/*.md`：片段一个文件，头部写 `id`、`owner`、`layer`、`max_chars`。
3. `prompts/profiles.json`：`purpose → 有序片段 + 动态槽`，回答“这个场景的 agent 看到什么”。
4. `prompts/compose.mjs`：`compose(purpose, ctx)` 返回 `{system, prompt, manifest}`；manifest（片段 id、hash、字数）与 `prompt.txt` 一起写入运行目录，任何一次运行收到什么都可回溯。
5. 常驻层：`SYSTEM_PROMPT` 保持极小（参与续接签名，改动会使所有线程失效）；`AGENTS.md` 拆成核心 + 按需专题，由 profile 决定谁带什么。

借鉴（只借做法，不引入依赖；描述来自搜索摘要和 README，未运行）：PromptKit 的分层与清单（`manifest.yaml` + `assemble` + `show` 反查引用）；prompt-lint / promptprobe 的检查项（重复句、冲突绝对词、缺停止条件、权威歧义）。

## 分阶段

| 阶段 | 内容 | 改变 agent 行为？ | 状态 |
|---|---|---|---|
| A | `prompt layers / dupes / where / overhead / run`（只读，`prompts/run.mjs`，登记表 `registry.json`） | 否 | 已完成，4 条测试通过 |
| A2 | 对比 Codex ask 的办公室/空 cwd 输入开销（单文件归因有限，见下） | 否 | 4 次调用已完成；工作区差值 4,491 token |
| B | 规则片段 `rule/*` + `lint`（引用缺失/循环、代码引用不存在的片段、孤儿片段、规则句被原样贴到别处的线索） | 否 | **已完成**（采纳 Codex 复核：不做独立 `rules.json`，规则就是被引用的片段） |
| C | 迁出 `agent/run.mjs` 里的内联文案（任务/探索/卡片/标题/压缩），渲染结果与旧代码逐字相同并加快照测试 | 否（逐字比对证明） | **已完成** |
| C2 | 同法迁出 `promptFor` 固定句子、记忆块、记忆提取、陪伴留言、邮件判断外壳、附件与文件状态提示；加 `prompt-manifest.json` | 否（逐字比对证明） | **已完成**（见文末各节） |
| D | 拆分 `AGENTS.md`、按场景裁剪 | **是**，需单独验收并说明续接签名影响 | **不做**（理由见顶部） |

## A2 受控对比（2026-10-19，Codex）

使用当时的 `agent/codex.mjs` 副本，原有相对 import 解析回原文件，仅加入实验用 cwd 参数；生产代码未改。四个全新 ephemeral ask，按办公室→空目录→办公室→空目录顺序执行；同一提示词（75 UTF-8 字节）、`gpt-6-luna`、`medium`（现有标题配置）、`baseInstructions`、`read-only`、`approvalPolicy: never` 和 launch overrides。不续接、不自动重试；没有 API key 接入或后台任务。

| cwd | 第 1 次 inputTokens | 第 2 次 inputTokens | 每次 cachedInputTokens | 每次输出 / 工具调用 |
|---|---:|---:|---:|---|
| `D:/Main/assistant` | 15,992 | 15,992 | 8,064 | 5 token / 0 次 |
| 系统临时目录中的空目录 | 11,501 | 11,501 | 8,064 | 5 token / 0 次 |

- 四次均返回 `OK`，事件里的 tokenUsage 与包装器返回值吻合，用量账本四条均为 completed。合计输入 54,986（含缓存 32,256），输出 20；不把输入 token 降幅等同于订阅费用降幅。
- 实测支持**工作区相关输入减少 4,491 token**；cwd 同时影响指令发现、项目 skill、可能的配置和环境描述，不能独立量出 `AGENTS.md` 的贡献。空目录仍保留用户级定制，不是“裸模型”。11,501 的内部组成未进一步拆分。不能据此声称已导出完整模型输入。
- [OpenAI 官方指令发现文档](https://developers.openai.com/codex/guides/agents-md)说明存在用户级及工作目录相关的指令发现；这是机制依据，不代替本机单文件隔离实验。`registry.json` 的 `codex-ask(unverified)` 暂保留：本轮证明了 cwd 差异，未逐文件证明注入内容。
- 默认权限首次启动报 `Could not find home directory`，未进入模型调用。通过正常 `require_escalated` 审批后执行四次对比，原失败现场保留；未改变登录环境、沙箱参数或持久权限。四次调用后临时 cwd 清理曾报 EBUSY（进程退出中的目录锁），随后单独清理成功，未重复模型调用。
- 运行前后 SHA-256 核对：`AGENTS.md`、`agent/{codex,native,run}.mjs`、`agent/config.json`、`automation/config.json`、`scripts/run-tests.mjs` 均未变。空实验目录已清理。

证据目录：`.runtime/agent/runs/88213502-1953-49bf-a39b-f4cf9564ae0d/`。`a2-host/a2-results.json` 为四次返回值、原文件 hash 和清理结论；`a2-verification.json` 为逐次事件与用量账本复核；`a2-host.log` 含原始执行及 EBUSY；`a2-results.json` / `a2-probe.log` 保留默认权限失败。实验副本及脚本也留在该目录，不进入生产入口。

## B—D 架构复核：建议修正后再定，不在本轮实施

1. **先有明确的调用场景，不把用量标签变成第二个路由器。** `agent/mail.mjs` 的 `screen` / `judgment` 共用 `purpose: mail`，但模板、模型和输出解释不同；交互还涉及 provider、ask/work 和续接。可用 `mail.screen`、`mail.judgment` 等明确 profile id，调用方选定，保留原 purpose 记账。编译层只组合文本与来源，不接管调度、授权、模型选择和业务判断。
2. **规则归属不等于强求所有语境逐字同文。** B 先记录规则 id、权威正文路径/段落、适用场景；不要马上把全部规则再抄进 `rules.json`。人读的模块文档与模型指令可引用同一依据，但任务特定的短提醒不必一律消除。近似重复检测只报候选，不能证明语义冲突、自动合并或当作安全证明；检查片段越界需先明确允许的场景。
3. **原生文件发现与程序编译是两个边界。** Codex/Claude 自行读取的 `AGENTS.md` 不会经过计划中的 `compose`；直接把原文替换成 `{{rule:id}}` 会留下未展开占位符。D 必须确定原生文件的唯一维护来源与真实加载方式，不能只改 profiles 就声称常驻层已裁剪。不要让 registry、profiles、规则表各维护一份正文。
4. **文本快照的结论有限。** C 的逐字一致只能证明所覆盖输入下的应用层字符串相同；还须保留 system/baseInstructions、顺序、动态数据与不可信材料的边界、ask/work、输出契约、续接和工具/权限参数。`prompt.txt`、manifest 不等于完整原生输入；未观察的用户配置、原生注入层应明确标未知。
5. **拆 AGENTS 不保证续接自动更新。** `continuationSignature`（`agent/codex.mjs`）包含 launch、model、effort、SYSTEM_PROMPT；`claudeSignature`（`agent/claude.mjs`）包含 model、effort、systemPrompt，两者目前都不含 `AGENTS.md` 文件 hash。修改 SYSTEM_PROMPT 会改变签名，修改 AGENTS 并不由办公室签名机制保证失效。D 需另定并验证旧线程何时采用新规则，不能笼统说“所有修改都会让线程失效”。
6. **提示词隔离与能力隔离分别验收。** Claude ask 明确传 `--tools ''`、`--safe-mode`；Codex ask 当前明确 read-only / never 并关闭桌面 MCP，但没有在调用参数中全面禁用工具。本轮零工具调用不证明工具不存在。后续如要承诺“无工具的纯分类器”，需单独选定、验证原生能力边界，不能靠一句提示词或换 cwd 代替。

## 隔离全套测试结果（2026-10-19）

- 已执行 `node scripts/run-tests.mjs`（默认权限，4 个脱敏副本，54 个测试文件），新增的 `prompts/prompts.test.mjs` 在副本里 **4/4 通过**。
- **全套未通过**：有完整摘要的 worker 合计 592 项，555 通过、37 失败；另有两个 worker（`mail-flow/actions.test.mjs`、`automation/codex-output.test.mjs`）运行超过 7 分钟仍未退出，按 PID、父 runner、脱敏路径核对后经正常审批终止，不能把它们当作“0 项通过”，592 也不是全套实际用例总数。54 个文件中 11 个退出非零（含这两个）。
- 已读到的失败包括 Codex 初始化退出、Python 缺 `pyvisa`、`pdftotext` 不可用、设置默认 provider 断言不符、重启测试 TypeError，以及同一副本后续命令遇到 `bridge.lock` 的 EEXIST。它们不是一个统一的“权限失败”，也未证明全是既有问题；没有做未改动基线对照，不归罪于新增 prompt 模块，也不声称与其无关。
- 清理说明：`Stop-Process` 曾报内部 NullReferenceException，复查确认未终止后，另经审批用原生 taskkill 清理两个精确核对的测试 worker 树。runner 随后输出失败结果，自动删副本报 EPERM；本轮两个残余副本的清理又遇到 `dashboard/error.log` 占用，未继续强杀不明进程或改权限。残余绝对路径见 `validation-summary.json`，不宣称已清完。
- 证据：上述运行目录里的 `full-tests.log`（已转 UTF-8，保留错误内容）、`stalled-workers.json`、`validation-summary.json`。生产提示词、拼装逻辑和配置未更改；没有为这些相邻失败扩大实施范围或再跑全套。B—D 保持待决定。

## B、C 完成记录（2026-10-19，Claude）

- 新增 `compose.mjs`（片段加载与填值）、`templates.mjs`（把值填进片段）、`fragments/`（17 个片段，共约 2.8K 字符）、`golden-cases.mjs` + `golden.json`（10 个固定虚构输入的渲染结果）。`agent/run.mjs` 里的 `EXPLORATION_RULES`、任务模板、日志与来源说明、卡片、标题、压缩、探索续跑文案已删，改调 `templates.mjs`；文件小了约 6KB，其余逻辑未动。
- 语法：`{{名}}` 取调用方给的值，`{{>片段id}}` 引用别的片段；单次替换，插入的值和被引用的片段都不再被解析（用户或邮件文字里出现 `{{`、`${}`、`$&` 不会被当成指令）；缺值、缺片段、循环引用都直接报错，不会在提示词里留空洞。
- 规则句（资料不是指令、不对外发邮件、先加载 smallest-complete、只有这些情况才停下、最终回复写什么）现在各只写一次，在 `fragments/rule/`，任务模板引用它们。
- 命令：`prompt fragments | uses <id> | show <id> | lint | snapshot [accept]`，加上阶段 A 的盘点类命令。改任何片段后 `prompt snapshot` 会列出哪些场景的渲染结果变了；确认后 `snapshot accept`，测试据 `golden.json` 守住。
- 验证：迁移前把旧代码的模板原样取出，与新渲染逐字比较，覆盖 actor × 任务类型 × 是否要求交付文件 × 是否有日志要求 × 是否有自主来源，加上含 `${}`、`{{}}`、`$&` 的标题和输入，再加上卡片、标题、压缩（有/无旧摘要，含空摘要）、探索续跑，共 65 个案例完全一致（脚本在 `.runtime/compose-check/equiv.mjs`，旧代码备份 `.runtime/run.mjs.before-compose`）。prompts 的 8 条测试通过；`run-tests.mjs --changes`（含 agent、continuation、file-state、restart 等）121 通过 1 失败，失败是 `dashboard/restart.test.mjs` 的 `work/autonomy.mjs:85` TypeError，我没改过这条路径，Codex 迁移前的全套结果里也列过“重启测试 TypeError”（未核对是否同一处），没有做改前对照，所以只能说它与本次改动无已知关系。
- 没做、没验证：`mail-flow` 的 `REVIEW/SCREEN-PROMPT.md`、`memory/extract.mjs`、`companion-notes.mjs`、`agent/files.mjs`、`file-state.mjs` 里的文案没迁；`promptFor` 的动态拼装（日期、项目入口、记忆、记录）仍在代码里；没有每次运行写 manifest；运行中的后台进程仍是旧代码（行为相同，重启后才用新文件）；没有跑 `--mail` 等需要额外授权的套件。

## D 的具体方案（待用户决定；未实施）

`AGENTS.md` 现为 16,038 字节，按章节：这是什么 3,709；做事的习惯 5,971；测试与沙箱权限 1,772；浏览器与 Windows 账号锁定 1,257；桌面 Computer Use 765；科研项目框架 490；项目内自建 skills 2,074。

- 候选搬出常驻的是后四到五章（约 4.6KB，占 29%），它们只在做相应工作时才相关。但“浏览器与账号锁定”是防 Windows 账号被锁的安全规则，搬到“按需读”意味着 agent 没读到就可能直接 `chromium.launch()`。所以这类规则要么留在常驻层，要么在 `prompt` 里做一个可核对的触发（例如脚本 `browser-launch.mjs` 本身拒绝直接调用），不能只靠“记得去读”。
- 对 Codex 的 ask 类后台调用（标题、邮件分类、记忆整理），空 cwd 少 4,491 token（见上，仅表示整个工作区上下文，不是 `AGENTS.md` 单项）。要拿到这部分，需要让后台调用用一个不含办公室指令文件的 cwd，这会同时改变 skill、配置和环境描述的发现，属于行为改变，要逐项验证后用户同意。
- 续接：`AGENTS.md` 不在两家续接签名里，改它不会让旧线程自动失效，旧线程何时用到新规则要实测。

## 规矩与程序现状的核对（2026-10-19，Claude）

逐条对照 `AGENTS.md`、`INTERACTIVE-GUIDE.md` 与代码，找已被程序强制或每轮重复注入的规矩。结论、七处对照改动及依据见 `.runtime/prompt-apply-20261019/proposals/NOTES.md`（七处已于同日应用，对照稿已从 `prompts/` 移出）。要点：
- 已被程序做掉：邮件回复的引用与回读核对（graph 原生回复）、24 小时防重复发送、`MAX_TURNS`、记忆 owner 隔离、Edge 合并 switch 的测试。
- 每轮已注入、AGENTS 里重复：项目资料入口命令、模块入口与 `help handoff|card|review`、@ 转交、邮件工作说明。
- 看似受控实则靠自觉：子 agent/卡片 ≤3 预算、统一用 `launchEdge`（无 lint）、桌面单一控制者（无锁）、skill 覆盖前备份、“用户已批准”本身。
- 更正：此前估计精简能省 1.5～2KB，实际 AGENTS.md 仅 −140 字节；大幅减量要靠 D。

## 对照稿已应用（2026-10-19，Claude，用户"到做完吧"授权）
- 七处改动已写入 `AGENTS.md`（−140 字节）与 `mail-flow/INTERACTIVE-GUIDE.md`（+181 字节）；另把 `mail-flow/README.md` 第 106 行"用户明确无引用则不使用reply选项"改为与新规矩一致。改前原件备份在 `.runtime/prompt-apply-20261019/`。
- 邮件引用规矩的变化：graph 通道的回复一律由服务器生成原生引用；要无引用就新建邮件（须用户批准）。
- 验证：`prompt lint` 无错误，`prompt snapshot` 10 个案例不变，`run-tests.mjs --changes` 124/125 通过；唯一失败是 `dashboard/restart.test.mjs` 的 `work/autonomy.mjs:85`（`item.project_ids` 为 undefined），该文件最后修改 2026-10-17，早于本次改动，不在改动路径上。
- 未做：D（拆 `AGENTS.md`）——收益约 1K token/轮，且会把防账号锁定、测试沙箱等规则变成"需要自己去读"，没有可核对的触发就不做；mail、memory、companion 文案迁移；四件"规矩换成程序"。

## promptFor 固定句子迁移（2026-10-19，Claude）
- 把对话轮 `promptFor` 里的固定文案迁到 `prompts/fragments/turn/`（25 个片段），代码经 `prompts/templates.mjs` 的 `turn.*` 取用；`promptFor` 只决定哪些段出现、什么顺序、哪些条件下重发（续接哈希逻辑未动）。`agent/run.mjs` 里用 `say` 引用，因为 `promptFor` 自带名为 `turn` 的参数。
- 验证：新旧 `promptFor` 在真实会话上逐字比对——抽 20 个任务（含带阶段、邮件证据、卡片来源的）× 每种身份 6 种选项（普通、带上一条发言含 `{{x}} ${y} $&`、递话、pilot、两种续接），Claude 与 Codex 各 144 次有效比对（`OFFICE_MEMORY_OWNER` 限制，另一身份的记忆会按设计抛错，所以分两次跑），0 处差异。比对脚本 `.runtime/turn-migrate/equiv.mjs`，旧代码 `.runtime/turn-migrate/run.mjs.old`。
- 这次比对抓出一个真错误：`promptFor` 的参数 `turn=0` 遮住了导入的 `turn`，已改名；快照与 lint 单独都发现不了，是新旧比对发现的。
- 新增 7 个快照案例（共 17）；`prompt lint` 无错误（条件取用的片段必须以字面 id 调用，否则 lint 会判为孤儿）；`prompts.test.mjs` 8/8；`run-tests --changes` 124/125，失败仍是 `dashboard/restart.test.mjs`（`work/autonomy.mjs:85`，与此无关）。
- 未迁：`memory/run.mjs` 的记忆文案（每轮注入，含条件文案）、`mail-flow/MAIL-BRIEF.md` 与邮件模块的 prompt、`agent/files.mjs` 附件说明、`automation/file-state.mjs` 文件状态提示、`dashboard/companion-notes.mjs`。后台进程仍是旧代码，重启后生效。

## 运行 manifest（2026-10-19，Claude）
- `prompts/compose.mjs` 新增 `traceFragments(fn)`：记录一次同步渲染用到了哪些片段（含被引用的）及次数。
- `agent/run.mjs` 的 work 轮在每轮目录写 `prompt-manifest.json`：任务、轮次、身份、提示词字数和 sha256、所用片段列表（续接轮另有 resume 提示词的字数和片段）。prompt.txt 被压缩后重写时，manifest 同步更新。不含提示词正文。
- 范围：只覆盖 `promptFor` 这条对话轮路径。任务模板（`taskPrompt`）在入队时已渲染进任务目标，不在 manifest 里；ask/卡片、标题、压缩、邮件分类、记忆整理等后台调用没有 manifest。
- 验证：`memory/memory.test.mjs` 断言 manifest 的 sha256 等于实际发给模型的提示词、关键片段在列、递话片段不在；`prompts.test.mjs` 9/9（含 `traceFragments` 测试）；`run-tests --memory` 204/204；`run-tests --changes` 124/125（仍是无关的 `dashboard/restart.test.mjs`）；`prompt lint` 无错误，`snapshot` 17 例不变。
- 后台进程需重启才会写 manifest；`prompt run <运行目录前缀>` 可看到该文件。

## 记忆块文案迁移（2026-10-19，Claude）
- `memory/run.mjs` 的 `memoryContext` 里的固定文案（头部、写入提示两种、失效 ID、完整性两种提示、整理线、入口标题、未放入入口数、本轮相关标题、无自动匹配）迁到 `prompts/fragments/memory/`（11 个），经 `templates.mjs` 的 `memoryText` 取用；条目内容、排序、预算（4 条、1600 token）和哪些段出现的判断仍在 `memory/run.mjs`。
- 验证：新旧 `memoryContext` 在真实记忆库上逐字比对，8 个查询 × 3 组旧注入 ID = 24 次，全部相同（含 16 次有失效 ID、3 次有自动召回、21 次无匹配）；真实库到不了的分支（完整性 changed/baseline、整理线、两种写入提示、入口未放满）用旧内联模板字符串对照新片段，6 项相同。比对脚本 `.runtime/turn-migrate/equiv-memory.mjs`，旧文件 `.runtime/turn-migrate/memory-run.mjs.old`。
- 快照 18 例，lint 无错误，`prompts.test.mjs` 9/9，`run-tests --memory` 204/204。
- 注意：`memoryVersion` 是对 `memory/run.mjs` 等源码的哈希，所以这次迁移会让它变化，属预期（它标记的是代码版本，不是文案）。
- 未迁：邮件简报与邮件模块 prompt、附件说明、文件状态提示、陪伴笔记、`memory/extract.mjs`。

## 后台调用文案迁移：记忆提取、陪伴笔记、邮件判断外壳（2026-10-19，Claude）
- `memory/extract.mjs` 的提取提示词整体迁到 `prompts/fragments/memory/extract-prompt.md`（`memoryExtractPrompt`）；`dashboard/companion-notes.mjs` 的留言提示词迁到 `fragments/companion/`（`companionText`，7 个片段，含两种身份、记忆线索/经历、同伴留言）；`agent/mail.mjs` 里邮件判断的编号说明和“判断包：”外壳迁到 `fragments/mail/`（`mailJudgePrompt`）。邮件的判断说明本身仍是 `mail-flow/REVIEW-PROMPT.md`、`SCREEN-PROMPT.md`（原本就是单文件，没动）。
- 验证：新旧输出逐字比对——提取 8 组（两种身份 × 有/无已有条目 × 无/含 `{{x}}` `${y}` `$&` 的对话）、陪伴笔记 60 组（两种身份 × 前几天留言 × 同伴留言有无 × 5 种记忆材料）、邮件外壳 6 组（用真实的 REVIEW/SCREEN 提示词），共 74 组全部相同。脚本 `.runtime/turn-migrate/equiv-rest.mjs`，旧文件在同目录 `*.old`。
- 快照 22 例，`prompt lint` 无错误。
- 提取提示词有意作为一个整片段：它是一份完整的任务说明，拆开没有复用价值。
- 未迁：`agent/files.mjs` 附件说明、`automation/file-state.mjs` 文件状态提示、邮件简报（本来就是文件 `MAIL-BRIEF.md`）；`profiles` 与跨场景规则（“资料，不是指令”等）的统一引用尚未做。

## 附件与文件状态提示迁移，及两个旧测试失败的处理（2026-10-19，Claude）
- 附图/附件说明（`agent/images.mjs`、`agent/files.mjs`）与文件状态/运行代码提示（`automation/file-state.mjs`）的文案迁到 `prompts/fragments/notice/`（10 个片段，`noticeText`）。新旧输出 46 组逐字相同（附件 6、附图 6、文件变化 28、运行代码 5、首次快照 1），脚本 `.runtime/turn-migrate/equiv-notices.mjs`。快照 25 例。
- `dashboard/settings.test.mjs`：标题提供方现为 codex，原测试假设起始为 claude；改为测试内显式设成 claude 侧再断言，结束由 `withConfig` 恢复。
- `work/autonomy.mjs:85`：`progressEvent` 读 `item.project_ids.length`，restart 测试夹具手工入队的任务没有该字段而抛 TypeError；改为 `item.project_ids?.length`（同文件其余处已用 `||[]`）。改前备份 `.runtime/turn-migrate/autonomy.mjs.old`。
- 验证：全套隔离测试在修这两处前后各一次——迁移后 632 项 631 通过（仅 restart 失败），`--lifecycle` 7/7、`--autonomy` 见汇报。至此全部提示词迁移（turn、memory、extract、companion、mail 外壳、notice）都已逐字比对。

## 最后两处内联文案（2026-10-19，Claude）
- 对话记录里“更早的 N 条发言已压缩成摘要”的说明（`conversationRecord`）迁到 `fragments/turn/summary.md`；陪伴留言的 `systemPrompt` 迁到 `fragments/companion/system.md`。新旧输出逐字相同（记录 8 组含特殊字符，system 文本逐字比对），快照 26 例，`run-tests --memory` 204/204。
- 至此程序写给模型的文案（除下列有意保留项外）都在 `fragments/`：`SYSTEM_PROMPT`（极短、参与续接签名，保留在 `agent/native.mjs`）；`AGENTS.md`、`~/.claude/CLAUDE.md`；邮件的判断说明与简报（`mail-flow/*.md`，本来就是单文件）；模块文档与 skill。

## 常驻提示词的可观察性与 Codex ask 实测（2026-10-19，Claude）
- 新增 `prompt standing`：按 purpose × provider 列出拿不拿 `SYSTEM_PROMPT`、`AGENTS.md`、`CLAUDE.md`。数据来自 `registry.json` 的 `surfaces[].loaded_by` 与新增的 `purposes`（mode、provider），`prompts.test.mjs` 用 `agent/claude.mjs` 的启动参数和 `agent/codex.mjs` 源码核对 Claude 一侧与 `SYSTEM_PROMPT` 的登记。`prompt lint` 会报告代码里出现但未登记的 `purpose:'…'`。
- Codex ask 实测：两次小调用（各约 16K 输入 token，用量记在 title 用途下），第一次她逐字复述了 `AGENTS.md` 的“- 称呼：”一条；第二次逐字复述了 `SYSTEM_PROMPT` 的“互不依赖…”和“汇报分开写…”两条。故 `codex-ask` 载入 `AGENTS.md` 与 `SYSTEM_PROMPT` 都已确认，登记表里的 `unverified` 已去掉。她对“系统指令第一句”的自述与实际不符，说明模型自述不可作证据，只看逐字复述。
- 发现一处两家不一致（未改）：陪伴留言在 Claude 一侧用自己的 `systemPrompt` 替换 `SYSTEM_PROMPT`，Codex 一侧 `baseInstructions` 固定、忽略该选项。

## 陪伴留言的系统提示词两家统一（2026-10-19，Claude，用户“要统一”）
- 原先 Claude 一侧用 `fragments/companion/system.md` 替换 `SYSTEM_PROMPT`，Codex 一侧 `agent/codex.mjs` 把 `baseInstructions` 写死、忽略 `systemPrompt` 选项。现在 `invokeCodex` 同样接受 `systemPrompt`（默认仍是 `SYSTEM_PROMPT`），续接签名随之包含实际使用的指令（默认值下签名不变）。
- 取舍：留言提示词明确要求“不是工作汇报”，而 `SYSTEM_PROMPT` 里有“汇报分开写：做了什么、验证了什么、没验证什么”，对留言有冲突，所以统一成“两家都替换”，而不是取消 Claude 的覆盖。
- 真机核对：Codex ask 调用带 `systemPrompt: companionText.system()` 时，她对“互不依赖…”一条答 NONE（`SYSTEM_PROMPT` 已被替换），并逐字复述出覆盖句“你在写一则给用户的私人小留言…”（脚本 `.runtime/turn-migrate/probe-codex-override.mjs`，约 16K 输入 token，用量记在 title 用途下）。默认调用不传该选项，行为与签名都不变。后台需重启后，Codex 一侧的陪伴留言才会用覆盖。

## 去掉上下文压缩（2026-10-19，Claude，用户决定）
- 删除 `compact.md`、`compact-old-summary.md`、`turn/summary.md`、`compactPrompt`、`turn.summary`、registry 的 compact 用途，快照里对应案例同步移除（`turn-summary-and-companion-system` 改为只剩 `companion-system`）。上文迁移记录里提到这些的地方是当时的历史。
