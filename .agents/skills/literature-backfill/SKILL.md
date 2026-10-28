---
name: literature-backfill
description: 按期刊和连续年份回填或重建实际文献题录摘要库，逐篇筛选、分批委派、核验来源并复核入库；收到 pkg-claude、pkg-codex 或 pkg-deepseek 包任务时先用；不用于普通科研问答或全文下载。
---

# 文献题录摘要回填

**依据**：2026-10-21二维文献重建中用户逐次纠正随机抽样、标题关键词闸门、期刊选择与摘要阅读，并指出密封参考集收录在库从1195篇增到9009篇时只从2/21到3/21，原因之一是旧规则把相关性当成主要排除关卡（程序曾强制exclude⇒scope=out），已改为“相关性宽放、重心是相关之后收不收”；实际批次见办公室根目录`output/literature-rebuild-20261021/batch-004/STATE.md`、`batch-005/STATE.md`及`batch-006/`。**适用条件**：用户要求实际填库、续接或重建题录摘要，而非只拟方案。**验证范围**：已有批次证明能取得目录、逐篇判断并核验入库，也暴露过简介冒充摘要、理由串篇、误排、编码和类型错误；不能据此宣称模型普遍准确或所有领域已覆盖。

## DeepSeek 包：首轮 API 直读＋精简复核

适用：用户给她 pkg-deepseek-NNN 包。首轮不用 agent 循环（每页多次请求、对话越滚越长，是最贵的做法），改为 API 直读；沿用精简复核，判断口径的校准由已有初筛与复核 API 读取唯一标准，不增加阅读轮次。

```powershell
node .agents/skills/literature-backfill/scripts/first-pass.mjs pkg-deepseek-NNN
# 读 coordinator/reviews/pkg-deepseek-NNN/lite.txt，写 patches.json
node .agents/skills/literature-backfill/scripts/review-finish.mjs pkg-deepseek-NNN <patches.json> --admit
```

1. **first-pass**：依次对各块跑 `api-screen.mjs`（thinking 关闭，每次请求一页 25 篇摘要，系统提示是 RUBRIC＋选文标准＋输出格式，回复经 `reader-work.mjs append` 校验落盘，输出与手写页同形）→ 合并 → `review-flags.mjs`（对首轮的不收／待核做一次 API 复核，thinking 高，每条给一个结论：建议改收或维持不收，生成 `lite.txt`）。中断后重跑续读。各块串行跑，并行会抢资源。办公室同时跑好几个 DeepSeek 包对话时，`first-pass.mjs` 收尾会报 `Unexpected token … is not valid JSON`：它把子进程输出写进共用的 `.runtime/first-pass-child.out`，另一个对话的同名文件会把它覆盖。两块 `-out.json` 已各 100/100 时不用重跑，直接 `reader-work.mjs merge <plan.json>` 再 `review-flags.mjs <包>`，结果与 first-pass 尾部同形；多个包并行时也可以一开始就按块跑 `api-screen.mjs <task>` 自己收尾。某页被拒（tags 数量、条数或 id 对不上、evidence 不是摘要原文）重跑即可；反复被拒先看该块的 `*.append.log`，缺 `e` 时程序会补一句摘要原文。同一页连续两次都只差一条记录时（被拒回复在 `.runtime/api-screen-last-reject.txt`，可比对缺哪个 id），缩小页更省事：2026-10-26 pkg-deepseek-065 有一页模型两次都漏同一个 id，改 `--page 8`／`--page 12` 逐页续读后两块 100/100 走通，块内页大小可随时换，已落盘前缀照常续读。2026-10-26 pkg-deepseek-076 见过两种整页失败：模型整页不写 `id`（报“id 与输入不符”、evidence 也全部对不上），以及整页按 id 升序重排（报“id 顺序与输入不符”）。前者已在 `api-screen.mjs` 加“整页都缺 id 且条数一致时按位置补输入 id，仍逐条与输入对齐”；后者照旧缩小页续读。同包还遇到整页 `finish_reason=content_filter`（页面是超流二极管、孤子成像、近邻效应、COF 孔分割，无敏感词），连续两次不通过，页从 12 降到 4 仍失败、降到 2 才跑通。2026-10-26 pkg-deepseek-115 的整块 100 篇任务里页反复被判 id 对不上（`--page 25`、`--page 10` 都在同一位置起错位），改成把全包按 25 篇切成独立 task 文件（自造 `input/output/chunk_file/task_file` 与 `input_sha256`，放在 `.runtime/` 下）逐块跑，8 块全通，块结果按输入顺序拼接回各块 `-out.json` 后与输入逐条对 id 通过，再 merge；同一包剩余 2 篇另有第三块，别按“两块各 100”推定总数。2026-10-26 pkg-deepseek-054 还见过整页被判“decision 须为 include|exclude|pending（undefined）”：模型把完整字段 `basis`/`scope`/`source_status` 一起写进记录，`reader-work` 的短字段展开就整条跳过；`api-screen.mjs` 现已逐条删掉这三个键，按块手跑时看到同类报错也是这个原因。
2. **读 `lite.txt`**：A 段是复核者建议改收的不收／待核条目（完整摘要，要判是否改收）；A2 段是复核者看过摘要后维持不收的条目（标题＋复核者理由，要判是否仍不收）；B 段是首轮收录条目的标题、理由、证据句；C 段是未被标出的排除条目的标题和首轮理由。复核者只给建议、没有最终决定权。主助手先按这些精简内容判断，发现具体矛盾再取对应原摘要，不按领域名批量补读。理由注意物理量、方向和证据强度，例如 FOM 与 Q、光锥到达后与光锥之外、crossover 与一阶相变。
3. **写 `patches.json`**：用脚本或 write 工具直接生成 UTF-8 文件，**不要用 PowerShell `ConvertFrom-Json`／`Set-Content` 重写**：`Get-Content` 默认按 ANSI 读，中文理由会变成乱码，`review-finish` 照样通过（乱码不是 U+FFFD），入库后才发现；2026-10-26 pkg-deepseek-066 这样错过一次，用原脚本重新生成即可修复。`patches` 只写改判的条目和字段；复核者判“建议改收”而最终仍不收的条目，要写出这篇实际做了什么、为什么看不到具体看点，不能把首轮理由原样留着——这类条目理由与首轮逐字相同时 `review-finish` 打回（退出码 1，不写文件），判“维持不收”的不受约束；`read` 要覆盖全部收录条目（`admit-reviewed.mjs` 要求每条收录都有本主人的复核记录，写漏会报 `Every include requires this owner actual abstract review`），读得多深在 `notes` 里如实写明（例如收录条目只读标题、理由与证据句，标出条目读了完整摘要，见 066/076）；`read` 还要覆盖看过的排除条目，只列收录 id 会让 `audit.checked_exclude_ids` 为空、入库报 `Record actual stratified exclusion audit; no fixed percentage imposed`（082 把 200 条全列，深度分层写进 notes）。`review-finish` 默认视为全部读过，所以 `read` 要写。
4. **口径**：选文标准只有一份，不往提示词里加口径。同一类论文在两块之间或与库内已有条目判法不同（量子比特、单光子源、近场辐射、综述最常见），用库里已有的收排先例定，不另立新条件。
5. **入库**：`review-finish ... --admit` 调 `admit-reviewed.mjs`（持锁、读回）。已 accepted 的包不能用不同判读重提；复核后要改判，另立补收小包（样例：`output/literature-rebuild-20261021/deepseek-batch-20261024/build-addendum-package.mjs`）。
6. **交回时写**：收／排／边界各几条；首轮与最终不一致几条；`review-flags` 标出几条、改收几条；实际读了哪些 id；请求数和耗费。

**做过的校准**：2026-10-25 对 pkg-deepseek-011 分层抽查 52 条完整摘要后，补收了 14 条并更正 4 条理由；结果在 `output/literature-rebuild-20261021/quality-check-011-20261025/`。领域标签代替贡献判断的偏差已澄清到唯一标准，供原有两步 API 直接使用；主助手保持精简复核。离线评测里复核者标出了人工改收条目的约四分之三，未取原摘要的 C 段只记看过标题与理由。同日晚 pkg-deepseek-012 定向抽 12 条，仍见量子点光子—自旋态转移、一维库仑气体极值统计两条漏收——前者复核者已标出，但结论是“若按量子信息不计则维持不收”，我选了与首轮相同的那一支；据此复核者改为每条只给一个结论，`review-finish` 增加理由打回，标准里题名阶段的“量子信息”写明不含量子点／自旋／受限体系器件。抽查见 `quality-check-012-20261025/review.json`。2026-10-26 pkg-deepseek-066（Nature Communications 2021，200 篇）：首轮 126 收，复核者 effort=high 把 74 条不收里的 72 条全标出、建议改收 27 条，最终改收 22 条、维持不收 5 条，另把首轮自相矛盾的一条（理由写着属能源主贡献、决定却是 include）改排，147 收／53 排入库；改收集中在“约束之间的巧妙解决”的器件与工艺（超表面架构、单触发自焊接封装、相分离＋交联光刻、光电子镊多部件微机械）和按贡献而非领域标签该收的条目（1D Fermi-Hubbard 非遍历性、蛛丝蛋白三维电子束抗蚀剂、活性粒子非厄米拓扑导向）。说明复核者的“建议改收”在高标出率下仍要逐条落到本篇做了什么，才不至于整包放水；笔记见 `deepseek-review-066/REVIEW-NOTES-pkg-deepseek-066.md`。2026-10-26 pkg-deepseek-082（Nature Communications 2024，200 篇）：首轮 107 收／93 排，复核者把 93 条排除全标出、建议改收 23 条，最终改收 20 条（A 段 18 条，加 A2 段按 catalog 先例改收 MOF 玻璃 01117 与单像素光谱仪 01680），维持不收 5 条，127 收／73 排入库；定判主要靠库内同类先例（量子纠错 transmon、晶圆级 MoS2 外延、二维压热、单像素成像、TiO2 表面重构、索烃），笔记见 `deepseek-review-082/REVIEW-NOTES-pkg-deepseek-082.md`。

**API 402（余额不足）时先换计费通道**：`api-screen.mjs`、`review-flags.mjs` 经 `scripts/ds-api.mjs` 跟随办公室的 DeepSeek 通道（`.runtime/deepseek-harness/provider.json`）。官方余额耗尽（`/user/balance` 的 `is_available:false`）时 `node automation/run.mjs deepseek provider commandcode` 切到套餐后直接重跑 `first-pass.mjs` 即可继续，不用改脚本、不用停包等充值；2026-10-26 pkg-deepseek-039 这样跑完（200 条 8 页请求＋补引文/重发各 1 次，164 收／36 排，套餐计价约 0.1–0.2 元人民币量级）。切回官方通道时同一命令用 `provider official`。

**换通道也不合适，或需要逐页人工读摘要时走子 agent 路线**：`first-pass` 第一页就报 `DeepSeek API 402`，`/user/balance` 显示 `is_available:false`（2026-10-25 pkg-deepseek-040 时是 -0.25 元）。此时 `review-flags` 同源也不可用。做法：每块派一只 effort=off 的子 agent，按 `references/reader-card.md` 逐页读完整摘要并 append（两块并行即可），主助手直接核对合并结果——200 条都读题名、理由、证据句，另取边界条目完整摘要逐字核对，再写 `patches.json`（`read` 写全部 id，`notes` 如实写没跑复核者层）后 `review-finish ... --admit`。040 如此完成：177 收／23 排，改判 2 条，见 `deepseek-review-040/REVIEW-NOTES-pkg-deepseek-040.md`。同一天 041/050 也走这条通道，把每页 25 篇切成自包含文件派给子 agent、再用 `scripts/apply-pages.mjs <TASK> <页文件…>` 逐页校验落盘（省掉子 agent 自己 append 的并发问题），并另派两只 effort=high 的复核者只重读 exclude/pending 生成 `coordinator/reviews/<pkg>/flags.json`；两步的做法和两包结果写在 `output/literature-rebuild-20261021/deepseek-fallback-041/README.md`。子 agent 侧 bash 可能报 `EXECUTOR_UNAVAILABLE`、`brief.mjs` 内部 `spawnSync EPERM`，改用 pwsh 执行同一批 node 命令即可，不影响结果。

分步命令（单独排错时用）：

```powershell
node .agents/skills/literature-backfill/scripts/api-screen.mjs <各块 task>
node .agents/skills/literature-backfill/scripts/reader-work.mjs merge <plan>
node .agents/skills/literature-backfill/scripts/review-flags.mjs pkg-deepseek-NNN [--effort off]
```

`--effort off` 关闭复核者的思考，几乎不花钱，抓到的改判较少。需要整包读完整摘要（例如系统性怀疑口径）时用 `review-pack.mjs pkg-deepseek-NNN` 生成完整复核包。

**先查摘要是不是截断的**：2026-10-25 pkg-deepseek-017 的分包标着“完整摘要齐备”，实际 200 条里 55 条 OpenAlex 摘要被截断，20 条只剩摘要末尾一句（14–37 词），首轮按残篇判断后 pending 从 1 涨到 8、复核层冒出多条“来源残缺”。`fill-abstracts.mjs` 只补空摘要，不识别截断。做法：先按“首字母不是大写／从句子中间开始／显著短于同刊中位数”筛出来，再用 Europe PMC 按 DOI 取出版社摘要（`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:"<doi>"&resultType=core&format=json`，Science Advances 200/200 命中，题名逐条比对一致），把更长的那版写回父输入、子块输入、task、plan 与 CONTINUE 的全部哈希（照 `fill-abstracts.mjs` 第 3 步，先备份），删掉残篇基础上的首轮结果后重跑。样本与脚本见 `output/literature-rebuild-20261021/deepseek-review-017/REVIEW-NOTES-pkg-deepseek-017.md`、`.runtime/lit017/`。Nature Communications 少数条目只存一句简介（200–260 字符，如 pkg-deepseek-101 的 nc26-02159、nc26-02500），Europe PMC 按 DOI 能补到完整摘要（02159 命中 840 字符，02500 三家都取不到）。补摘要要重算父输入与各子块哈希，只是判不收时不必动输入：按简介判不了就留 pending，理由写清只有简介、补到的全文摘要有没有改变判断，笔记里记 id。

## Codex／Claude 收到具体包：一条命令启动

**依据**：2026-10-21 pkg-claude-005/006 的运行日志里，派出第一个子agent前花了 1.5–2.8 分钟，主要在全目录搜索包ID、读`help literature`、重复读本skill与三份references、核对前置包状态；而协调者早已把各子任务切好（`coordinator/reader-jobs/<包>/screen-r01/`）。**适用**：包的 reader-jobs/plan.json 已存在（launch.mjs 会告诉你有没有）。

```powershell
node .agents/skills/literature-backfill/scripts/launch.mjs claude pkg-claude-005   # Codex 把角色与包ID换成 codex pkg-codex-NNN
```

只读、不到 1 秒：输出这个包每个子块的 todo/partial/done、要派的 task 路径、子agent模型、**一句话**的派工 prompt 模板（子agent自己读`references/reader-card.md`，并用`brief.mjs <TASK>`一次取齐 RUBRIC＋选文标准＋首页），以及合并命令。拿到后**立即一次回复并行发出所有 Agent 调用**。

**包里缺摘要的条目多时（老包、Nature 系、APS 等），先粗筛再补摘要，再派读**：① `launch.mjs claude <包> --phase titles` 派子agent只做题名阶段（派工 prompt 同样是先跑 brief.mjs）；② `node .agents/skills/literature-backfill/scripts/fill-abstracts.mjs <包> [--round screen-r02] --dry-run` 看“题名放行但缺摘要”的条数和 DOI 前缀分布；③ 去掉 `--dry-run` 真补（OpenAlex → Semantic Scholar → Springer Meta（10.1038/），`--selected` 再加 APS 和题名匹配的 arXiv；不重试，429 即停该来源），程序会备份到 `.runtime/fill-abstracts-backup/` 并重算父输入、manifest、子块输入、task、plan 和 CONTINUE 里的哈希，读回核对；④ 再按上面流程派读摘要。必须在派读前做（会改子块输入），读到一半的块不要补。仍缺摘要的条目照常记 pending 或按体裁排除。


**新期刊**：目录取齐后 `scripts/build-packages.mjs`（先 `--dry-run`），其输出给出后续的 dispatch 与 `launch.mjs --phase titles`。

## 新对话从这里开始：先定位，再按身份续接

当前这次重建的固定入口是办公室根目录`output/literature-rebuild-20261021/CONTINUE.json`。**不要靠聊天记忆、最高batch编号或旧STATE猜从哪接。** 用户要求续做这次工作时先运行：

```powershell
node .agents/skills/literature-backfill/scripts/resume.mjs codex
# Claude 使用同一入口，只将最后一个参数换成 claude
# 当前分配协调对话使用 coordinator；不兼任阅读或catalog写入
```

这是只读查询：从真实catalog读总数，从唯一续接表列出本人所有未交付块、已交付待验收结果和首个阅读游标，并检查结果文件实际是否存在、ID/条数是否完整；不调用模型、不领后台任务、不改状态。`pending_work`是本人的批量工作范围，`selected`仅是其中第一个读取游标，不是整轮任务。需要单块原文时加`--input`，不把整个目录灌进主线程上下文。

接着读[references/continuation.md](references/continuation.md)和判读规则。**500–1000篇是主助手的包；切块分派已独立到literature-dispatch skill，主助手在派读前单独调用，不额外起一个模型负责切块。** 分派任务返回不重叠子块的plan/task/input/output；通常按十个名额组织（launch.mjs 每波最多列十个块，返回后再取下一波），扣除本轮已用名额并遵守原生槽位。这里接收子任务、完成阅读及复核，不再提供第二套切块命令。子agent按有界读取→逐篇判断→立即追加落盘完成自己的块，主助手按风险复核，不默认重读整包。命令见[references/reader-operations.md](references/reader-operations.md)。新对话“继续”指推进主包，不是每个小文件完成就停。

Codex与Claude只处理本人owner范围，不能因对方尚未落盘就抢领。原work item范围保持稳定，派生子任务独立输出，由本人主助手串行合并。**两位各自验收自己的包，Claude不转Codex复审或代为入库。** 验收后各自调用同一串行入库命令；程序持锁写catalog，不设第二个模型验收关口。协调者只准备来源和主包，不判论文或写库。当前对话@交接只是轮流，不冒充并行，也不启动后台扩库。

若当前用户说的是别的文献任务，不把这个固定任务的年份/期刊/进度强套过去；先按新请求建立相应输入与续接资料。更新进度只改续接表及本批ledger/delivery，不把篇数与所有者反复复制到skill正文。用户暂停后仅记录停止点；只有新的恢复/验收/续做授权才推进。


## 先恢复当前任务，不恢复旧筛子

- 先读当前catalog统计、最近STATE、manifest及实际审阅/入库清单，跳过已收DOI，保留未读、缺源及待核位置。不要整批恢复旧库或重跑已完成的来源请求。
- 业务口径以用户最新明确决定为准。`literature/sources.json`、README和`help literature`负责现存模块与参数；旧backfill入口的主题分类、被引排序、年度数量上限不等于本次完整目录覆盖。先确认入口实际筛过什么，再决定能否复用，不能把程序筛后的池冒称全集。
- 业务口径以用户最新明确决定为准；用户指定范围、期刊与全文权限是任务参数，不擅自推广成其他任务的全局设置。

## 本次委派模型

按2026-10-21用户分别给两条文献工作对话的明确指定执行；不改变其他任务或办公室全局模型配置。

- **Codex侧子agent：GPT-6 Luna**，原生工具参数`model="gpt-6-luna"`；指定模型时用`fork_turns="none"`。本次不要自行换成其他子agent模型。
- **Claude侧子agent：用户指定Haiku 5.5**，使用原生Agent工具的`model="haiku"`入口。记录用户指定型号与工具实际返回的型号；别名`haiku`本身不证明完整版本号。若实际版本不可确认或与指定不符，如实报告，不虚构已验证5.5、不擅自换模型。
- **两位主助手分别承担本人包的内容验收和入库提交**，不转交对方复审；共享库只由程序持锁串行写入。主模型不变，协调者不额外启动模型；不授权新任务、额外API或后台调用。

## 选文标准：只有一份

**标准在[FUTURE-SCREENING-STRATEGY.md](../../../output/literature-rebuild-20261021/FUTURE-SCREENING-STRATEGY.md)，其他文件不另立口径。** 摘要一句：相关性凭感觉宽放（一个方向小含1D／二维性质／非一坨的层状，占一点就算，不写论证）；重心是相关之后收不收——不常见或很有说法，加论证扎实，出色的应用器件设计也收；能源、催化、电池、膜分离、生物学／生物医学为主要贡献的不收（2026-10-22用户明确生物学也排除，不只限于医学应用）。目标指标是密封参考集收录覆盖，不是篇数。`references/local-rules/`下两份是历史病例，不是标准，不随brief发给阅读者。

期刊、年份与来源权限按当前任务授权和CONTINUE.json导航；期刊排序只决定阅读优先级。不以篇数或收录率为配额。


## 一条连贯的工作路径

1. **发现候选**：以获准的好期刊连续年份目录为主，辅以可靠专题综述引用、其他期刊目录发现长尾。记录目录边界、分页与实际返回量；不随机抽一半，不以题名必须含“二维”/材料词、热门标签或被引数作准入闸门。综述与主题图谱是导航，不是排除围墙；规模估算不是凑数配额。
2. **拿到可判断的来源**：保存DOI、题名、期刊、作者、发表日期、完整来源摘要和出处。区分真正摘要、编辑简介、缺失及残缺；OpenAlex索引文本不自动等于出版社摘要。短摘要或第三人称不自动判作简介。缺源先补可靠摘要，仍缺则pending；除题名已明显无关外，排除前也完整读摘要。
2b. **派读前先按体裁排掉非论文栏目**：出版社元数据（Springer Meta 的 genre）为 News & Views、Research Highlight、Editorial、Books & Arts、Measure for Measure、Thesis、Comment、Interview、Correspondence 等的条目，不是研究论文，不留 pending，用 reader-work.mjs 的 mark 在读之前预排除（题名阶段排除，note 写体裁）；2026-10-22 Nature Physics 028/029 包约 45% 属此类，脚本样例见 output/literature-rebuild-20261021/batch-020/premark-genre.mjs。已读块里同类 pending 也改为排除。
3. **逐篇内容判断**：输出include/exclude/pending，reason写看点和论据（相关但不收写exclude＋scope=in），区别实验、理论、计算、综述和方法。证据片段须来自对应原文，不能用匹配片段代替完整阅读，不能把预测或候选解释写成实测。具体格式和边界见[references/review-and-admit.md](references/review-and-admit.md)，实际切批、复核与入库时再读。
4. **接收独立分派结果**：主助手先调用literature-dispatch，再把每个task分给指定模型；子agent用brief.mjs取RUBRIC和选文标准，并自己先做题名粗判断再读摘要（reader-card.md），粗判断不由主助手代做。每次有界读完整摘要后立即保存有效前缀，不全量打印主包，也不等整块结束才写。工具截断不证明模型读不了整块，不能声称已读未见部分。主助手收拢子输出、串行机械合并，不绕子 agent 同时存在数上限。`fork_turns=none`不保证没有底座，不虚报无底座。
5. **全量机器核对＋风险内容复核**：程序检查全部记录的ID/数量、字段、编码、证据对应、来源哈希和DOI去重。主助手核对拟收全部摘要，并处理待核、边界及可疑排除；其余排除项按期刊/年份、方向、子agent和理由分层抽核，不能只抽简单无关项。不默认对1000篇再派一轮或亲自全读；发现系统性错误才记录原因、扩大对应范围。按[references/review-and-admit.md](references/review-and-admit.md)留真实复核ID。程序合法或模型一致不代替科学判断；未验收不能入库。
6. **各自验收、程序串行入库**：按review-and-admit.md准备本人最终判断与复核记录，调用admit-reviewed.mjs；不直接运行旧的“仅Codex写库”脚本或同时覆盖catalog。命令持锁读取最新库、备份、去重、写入并读回全部新增字段/摘要哈希，保留来源及改判依据。锁被占用就待当前写入结束，不自动轮询或删锁。只建摘要库，不调用全文入口。
7. **阶段交付**：报告目录考虑多少、真正完整摘要多少、简介/缺源多少、实际新增多少、仍待核多少，并留下续接文件与下一段目录位置。局部年份或“可得摘要池处理完”不等于全期刊/全领域完成。用户给出独立密封检查时只运行获准的汇总程序，不读取参考题名/DOI，不按分数反复刷库，分数只支持其参考集的收录覆盖。

## 范围与执行约束的入口

来源与输出格式见[阅读执行规范](../../../output/literature-rebuild-20261021/batch-007/RUBRIC.md)。本阶段不抓PDF、不做全文测试、不用预付费余额或鼠标宏，不创建长期模型／采集轮询；撤换策略不增加任何执行权限。

## 批量运行中真正要防的事

一次输出为空、没落盘、数量不全或工具截断就是未完成；保留实际已交付前缀，按失败原因调整本次切块，不用模板/占位冒充已读，不靠重开绕预算。块大小按摘要长度和实际模型输出能力校准。2026-10-21曾有约99篇子agent及116篇Luna完整交付，也有116篇任务未交付；30篇曾帮助恢复可靠落盘，但只能作为可调整的文件/检查点粒度，不能成为主助手每轮的工作量上限。用户暂停、实质阶段完成或真实预算/上下文/工具限制才是停止理由，读完一个小块不是。

来源401/403/429按模块规则停，不换镜像或绕过；若官方说明是缺认证，只有在已有合法凭据及当前授权确实允许时按正常审批补认证，保留失败事实。只使用获准的免费额度，不因元数据便宜就动预付费。真实程序有改动时遵守办公室隔离测试规则；只改任务材料或skill，不为凑形式跑会改真实库的测试。

**多对话并行时的撞包**：同一个包可能已被别的对话认领并入库，开工前看两处能省掉整轮复核——`deepseek-review-<NNN>/CLAIM.md`（谁接手、几点）和 `coordinator/admissions/<包>/receipt.json`（是否已入库、收多少）。2026-10-26 pkg-deepseek-105 是本对话照交接做独立复核、跑到 `review-finish --admit` 才被 `Package previously admitted with different final decisions` 拦下：另一对话早 20 秒把 138 收入库。此时不改已入库结果，按下面收尾：从 `admissions/<包>/ledger.json` 还原同目录的 `decisions-`/`audit-`/`patches.json`（独立复核会覆盖同名文件），把自己的判读挪到 `independent-review-<NNN>/`，再写 `REVIEW-NOTES-<包>.md` 列出与入库版本的分歧条目和两侧理由，供以后统一口径。
