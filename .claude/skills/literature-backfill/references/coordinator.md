# 协调者与两条工作对话

2026-10-23 已为 DeepSeek 准备独立 owner 入口。用户安排她试读时，可从未分配候选准备 `owner=deepseek`、`pkg-deepseek-NNN` 的小包，manifest／work item 契约与原流程一致；她用 `resume.mjs deepseek`、`launch.mjs deepseek <包>` 看包，`first-pass.mjs` 做首轮，她读精简复核后入库。现有 Codex／Claude 包归属不变，准备入口没有自动分配真实包。首轮选文质量仍需实际结果核对，不由流程测试替代。

依据：2026-10-21用户批准协调者统一准备大包，随后明确“主agent再切块给子agent”。此处千篇包属于主助手，子任务由主助手拆分；不新建长期模型流程。

## 定位

读取CONTINUE.json的coordinator、workers、catalog_write_interface、source_units及packages。只读入口为`resume.mjs coordinator`。协调对话准备来源和主包；子块分派已独立为literature-dispatch任务。两条工作对话各自处理和验收本人包，通过同一持锁程序串行写库，不把Claude转给Codex。

## 一包的实际契约

- 包manifest：owner、worker会话、真实记录数、聚合input路径、work item清单、原始输入/固定范围/唯一输出、规则及输入哈希。
- 每主包约500–1000篇；主助手再按篇数和摘要体积切子任务。可从每子块约100篇组织，按实际情况调整，不把主包、344篇旧续段或656篇大文件直接等同于一个子任务。旧原始范围保持不变，子任务可以是这些范围内的派生小块。
- 工作者只能切本人包；每个子agent得到唯一task/input/output，不和其他子任务重复。独立子输出由主助手串行机械合并回原work item，再强复核；子agent不能共同写原始大输出，也不能改catalog/共享表。分段读取和落盘命令见reader-operations.md。
- 包input是便于领取的只读聚合文件，不是另一本独立数据；最终来源按manifest所指原始输入核对。结果仍落原work item输出，避免双重进度账。

## 开下一包

1. 协调者核对最新状态、已交付文件和目录覆盖，保留正在进行的范围；先登记未覆盖的期刊/连续年份来源段，再取数。按当前好期刊优先级，不能用主题/题名或随机门槛筛候选。
2. 只用获准的元数据和摘要来源及免费额度。失败按规则停，不自动重试/切镜像。缓存成功页面可离线整理为部分目录，记录失败、取得数量、未取游标与来源完整性。
3. 程序去catalog、已分配输入和池内重复，保留缺摘要候选供pending判断，生成稳定ID及来源网址。将真实未读输入组为两方不重叠的大包，清楚记录未分配池游标；候选不足就如实少发，不造假凑包。程序：`scripts/build-packages.mjs --owner <角色> --slug <短名> --dir <dir> --years <起-止> --prefix <前缀> --label <期刊名> --register N`（`--dry-run` 先看）。
3.5. **先过题名，再补摘要。** 包切好并分派后，先用`launch.mjs <角色> <包> --phase titles`派子模型只做题名阶段，再对各子块跑`reader-work.mjs survivors <TASK> --out <文件>`取得“题名放行但缺摘要”的ID，只为这些补摘要（免费额度有限，题名明显无关或属能源／催化／电池／膜分离／生物学／生物医学的不必补）。补摘要和更新各处输入哈希用 `scripts/fill-abstracts.mjs <包> --dry-run` 先看、去掉 `--dry-run` 执行（见 SKILL.md“包里缺摘要的条目多时”），再按完整流程派读摘要。
4. 发布前核对ID/DOI和输出路径跨包无重叠、包中每条能回原始输入、总数与manifest一致。读取当前共享表后合并新字段并做并发变更检查，不覆盖写库者刚完成的接受状态。保留写前快照，不启动模型、队列或轮询。

## 收结果与唯一写入者

两位主助手各自按风险策略验收本人包、维护本人侧小规则，并调用admit-reviewed.mjs；Claude不交Codex复审或代为入库。协调者不判论文或直接写库，也不把文件存在记成验收通过。目录采集与程序检查不代表科学判断正确，主包结束不等于全量重建完成。
