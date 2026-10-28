# EverOS 移植计划（memory2）

## 当前状态（2026-10-26：旧系统已退役）

用户确认清除整个办公室的旧系统、不归档。三位统一使用 memory2；75 条有效旧记忆及 9 条更正历史已逐条核对迁入，来源、标签和原条目字段存入情节的 `Legacy` 节，更正关系转为 memory2 的弃用映射。旧 `memory/`、`.runtime/memory/`、迁移工具、旧提示词、旧 CLI、被动提取及旧库回退均已移除；每日留言和原生记忆覆盖改用 memory2。当前入口见 `README.md`。以下保留的是开发经过，不能据其中的旧接口或回退建议恢复旧系统。

目标：用户希望按 EverOS 的设计重做长期记忆，**以 EverOS 源码为准，不参考现有 `memory/` 的做法**；不安装它的包，把源码思路移植成本项目的 Node 代码，GPU 推理用文献库的模型。慢慢做，每一步可单独验收。

参考源码（只读，Apache-2.0，移植需保留署名，见文末）：
- `.runtime/ref/everos/`（仓库 `EverMind-AI/EverOS`，浅克隆）
- `.runtime/ref/everalgo/`（PyPI `everalgo-*` 解压：提取、边界、聚类、排序算法与中英文提示词都在这里，不在仓库里）

LLM：gpt-6-luna（用户 2026-10-24 指定），沿用 Codex 通道，不接本地 LLM。嵌入：Qwen3-Embedding-4B int8（GPU）。重排：bge-reranker-v2-m3（GPU）。

## 数据模型（照 EverOS）

```
<root>/<owner>/                      owner = claude|codex|deepseek，每位一个根，互不读取
  users/<user>/user.md               profile，整文件重写
  users/<user>/episodes/episode-YYYY-MM-DD.md    日志式，条目用 <!-- entry:ep_YYYYMMDD_NNNNNNNN --> 包裹
  users/<user>/.atomic_facts/atomic_fact-YYYY-MM-DD.md
  users/<user>/.foresights/foresight-YYYY-MM-DD.md   （先不做）
  .index/                            可整个删除后重建：system.sqlite（变更队列、cluster、reflection_report）+ 向量与 FTS
```
Markdown 为真源；`deprecated_by` 写在条目 frontmatter/索引行上，搜索默认排除。

## 逐层对照

| EverOS（路径） | 作用 | 本项目移植 | 状态 |
|---|---|---|---|
| `memory/extract/ingest`、`everalgo user_memory/boundary.py` | 消息累积、MemCell 边界检测 | 输入改为 `sessions.json` 的真实聊天任务；边界按任务/会话结束 + 它的 boundary prompt | 未读 |
| `everalgo user_memory/episode.py` + `prompts/zh/episode.py` | 把一段对话写成第三人称情节（title+content，带绝对时间） | 原样移植提示词，LLM 经 gpt-6-luna | 提示词已读 |
| `atomic_fact.py` `foresight.py` `profile.py` | 原子事实、预见、user.md | 先做 atomic fact 和 profile，foresight 暂缓 | 未读 |
| `memory/cascade/*`（watcher/scanner/worker/reconciler） | md 变更 → 索引，内容哈希决定是否重嵌入 | 简化为：扫描 md、按 `content_sha256` 增量同步，不做文件监听 | 未读 |
| `memory/search/*` + `everalgo rank/fusion.py` | keyword/hybrid/agentic；RRF、向量锚定融合；重排 | FTS5(BM25)+向量余弦，`vector_anchored`(alpha 0.7, k 5) 或 RRF(k 60)，可选 bge 重排 | fusion 已读，search 未读 |
| `everalgo clustering/algorithm.py` | 余弦 ≥0.65 且 7 天窗口，加权质心合并 | 原样移植 `cluster_by_geometry` | 已读 |
| `memory/reflection/orchestrator.py` + `everalgo user_memory/reflect.py` + `prompts/zh/reflect.py` | Select(≥2 成员，每次最多 10 簇，大簇优先) → Merge(INIT/UPDATE) → 写合并情节 → 重抽原子事实 → Deprecate 并写 reflection_report | 原样移植流程与中文提示词；原条目只标 `deprecated_by`，不删 | 已读 |
| `infra/ome/*` | 事件/计数/cron/空闲触发 | 复用 dashboard 现有一分钟维护节拍，不另起调度 | 未读 |
| `component/embedding`、`rerank` | 提供方协议 | 本机常驻小服务（空闲卸载）：嵌入 2560 维，重排 | 试点已验证嵌入 |

## 依赖与不照搬的地方
- 已用 npm 装入（用户 2026-10-24 授权随便装）：`yaml`（frontmatter）、`@node-rs/jieba`（中文分词，EverOS 用 jieba 给 BM25 分词）、`@lancedb/lancedb` + `apache-arrow`（向量 + 全文索引，与 EverOS 同一后端）。三者已冒烟验证（jieba 切词、LanceDB 向量检索与 FTS、yaml 往返）。npm audit 的 sharp 高危来自 LanceDB 间接依赖的 @huggingface/transformers（图像库，本项目不用），undici 来自 discord.js 的旧依赖。
- 先不用 Tantivy 以外的东西：BM25 走 LanceDB 自带 FTS，查询前用 jieba 分词。
- 不用 HTTP 服务/REST API，也不做文件 watcher：本项目进程内调用，按需同步。
- Python 包不引入；算法在 Node 里重写，GPU 部分复用 `literature/embed_worker.py` 一类的 Python worker。

## 与现有 `memory/` 的关系
`memory2` 并行建设，不改 `memory/`；切换（提示注入、被动整理、CLI）等 memory2 通过验收后另行决定。现有 49+ 条旧记忆暂不迁入，到时再定是否作为 legacy 种子导入。

## 分阶段
1. 存储层：md 读写（entry 标记、frontmatter）、`.index` 同步（sha256 增量）、FTS5。
2. 嵌入/重排服务与向量检索；hybrid 搜索 + 阈值/`deprecated_by` 过滤。
3. 提取：episode（zh 提示词）→ atomic facts；profile。
4. 聚类 + Reflection（Select/Merge/Re-extract/Deprecate）。
5. 注入：profile + 按话题检索，替代固定线索块。
6. 触发与切换。

每阶段用虚构数据在隔离副本里测试（`scripts/run-tests.mjs`），关键路径真机跑一遍。

## 署名
移植自 EverMind-AI/EverOS 与 everalgo-*（Apache License 2.0）。移植文件头部注明来源文件与版本；项目根保留其 NOTICE 要求的署名。

## 进度（2026-10-24）
- 阶段 1 完成：`md.mjs`（Markdown 存储）、`tokenizer.mjs`（jieba 搜索模式）、`index.mjs`（md→LanceDB，内容哈希增量、删除对账、`deprecated_entries`→`deprecated_by`）。
- 阶段 2 完成：`search.mjs`（keyword/vector/hybrid，LR 或 RRF 融合，deprecated 过滤，owner/会话/时间过滤）、`embed_server.py` + `embedder.mjs`（GPU 常驻、空闲 10 分钟自动退出、启动锁）。
- 测试：`node --test memory2/md.test.mjs memory2/index.test.mjs memory2/search.test.mjs memory2/embedder.test.mjs`（离线，假嵌入器）；`node memory2/gpu-smoke.mjs` 是真 GPU 端到端（虚构数据）。
- 真机结果（虚构 5 条）：5/5 换说法查询第一名正确，无关查询得分最低；LR 概率偏低（0.10～0.19，无关 0.03），上游阈值 0.6 不能直接用，需要用真实数据重新标定。
- 注意：写入系统临时目录的信息文件，Python 子进程被拒（PermissionError）；服务信息文件放在 `.runtime/memory2/`。
- 下一步：阶段 3 提取（boundary → episode → atomic_fact → profile），输入为 `sessions.json`。
- 阶段 3a 完成：`extract.mjs`（MemCell 切分、情节、原子事实、幂等写入、失败只影响单个 cell、事实补跑）、`llm.mjs`（gpt-6-luna，沿用 agent/config.json 的 memory_extract）、`prompts/zh.json`（从 everalgo 的 zh 提示词原样导出，含 profile 与 reflect）；原子事实也已进索引并可检索（`kind:'atomic_fact'`）。
- 真机试点（我自己的 2 个真实 cell，gpt-6-luna）：情节具体、第三人称、带绝对时间、数字与原文一致；原子事实每个 cell 21～30 条，颗粒偏细（上游设计）。偶发 `Codex 会话退出 (1)`（~/.codex 状态库初始化竞争），重试成功，已加一次重试。
- 偏离上游：① 边界不逐窗口调 LLM：先用时间间隔 6 小时（自加）+ 8192 token/50 条硬上限（上游）切 cell，再对 ≥40 条或 ≥7000 token 的大 cell 用上游 everalgo.boundary 的批量提示词调一次模型取切点（2026-10-24 抽样：20 个随机 cell 里混话题的 3 个全是 ≥40 条的大 cell；**默认关闭**（2026-10-25 对 16 个 ≥40 条的大 cell 人工标切点：该提示词只命中 25 个切点中的 3 个；对照提取：整段提取的事实只覆盖按话题拆开后事实的约 25%，但按固定 12 条切也得到同样多的事实——决定事实量的是 cell 大小，不是话题切得准不准。若要补，改小 hardMessages 比边界检测有效，尚未做）；切点缓存在 <库>/boundaries.json，已整段入库的旧 cell 不再拆；真机对 3 个已知混杂 cell：1 个完全一致、1 个部分一致、1 个未切——上游提示词偏保守）；② 无模型给的 Summary 时不写 Summary（上游截 body 前 200 字，会断在句中）。
- 全量回填估算：我的库 86 个 cell、约 42 万字，约 170 次模型调用；还没跑。
- 下一步：3b profile；4 聚类 + Reflection（提示词与算法已读，orchestrator 待移植）；5 注入。
- 阶段 3b 完成：`profile.mjs`（INIT / UPDATE 操作 / COMPACT，zh 提示词，`users/<owner>/user.md` 单文件重写，按批续做，失败停在上一个好状态）。
- 阶段 4 完成：`reflect.mjs`（cluster_by_geometry、SQLite 簇表、Select→Merge→写合并情节→重抽事实→Deprecate→重置簇、report）。
- 真机 Reflection 试点（我 10-24 当天 22 个真实 cell，gpt-6-luna + GPU 嵌入）：
  - 上游阈值 0.65 在我们的数据上失效：22 个情节两两余弦中位数 0.635、p90 0.81，18 个互不相干的工作段被聚成一簇，合并成 9000 字流水账。
  - 默认阈值改为 0.8（`CLUSTER_THRESHOLD`）：聚出 {提示词精简+注意力偏差}(2) 与 {文献回填包核对}(8) 两簇，其余独立；合并叙述连贯，结尾带“当前状态”。样本小（一天、22 条），数据多了要复核。
  - 原子事实量大：每个 cell 约 24 条，8 条合并叙述又重抽出 180 条。检索质量与存储是否需要限量，待接入注入后用真实查询评估。
- 已知缺口：合并情节已写入但“标弃用”中途失败时，重跑会再合并一次（上游同样的窗口，未处理）；各助手分别提取尚未做 cell 级共享缓存。
- 下一步：5 注入（profile + 按话题检索，替换固定线索块）与 6 触发/开关/切换；显存优化交给 Codex（她有硬件适配经验），见 `embed_server.py`、`embedder.mjs`。
- 阶段 5 完成（默认关闭）：`context.mjs`（画像 + 按话题混合检索；情节以“标题 + 命中的原子事实”呈现，全文用 `memory2 show`；只有校准过的 LR 分数才决定注入，无向量时只注入画像；隐式倾向默认不注入）、`inject.mjs`（同步桥：子进程跑 `memory2 context`，失败写 `.runtime/memory2/inject-errors.log` 并退回旧块）、`agent/run.mjs` 一处调用（`memoryContextV2(me,goal) || memoryContext(...)`）、`agent/config.json` 的 `memory_v2`（`enabled:false`）、`automation/config.json` 注册 `memory2` 模块（status/search/show/context/sync/ingest/reflect/profile）、`prompts/fragments/memory/v2-*.md` 五个片段。
- 阈值标定（我 10-24 当天 22 条真实情节，10 条相关查询 + 6 条无关查询）：相关查询最高分 0.10～0.86，无关 0.03～0.14；`minScore` 0.2（9/10 召回，0/6 误入）；没有事实命中、只靠整段相似度命中的情节要 ≥0.35。查询是我写的短句，真实用户消息更长，上线后用 `memory-context` 记录再复核。
- 稳态耗时：首次（建索引 + 起 GPU 服务）约 31 秒，之后一次 `memory2 context` 约 1 秒。
- 测试：`node scripts/run-tests.mjs --memory2`（60 条，含 runner 自检）；`--prompts`、`--memory`（253 条）在隔离副本里通过。为让副本能解析 npm 包，`scripts/test-copy.mjs` 给每个测试副本加一个指向真实 node_modules 的 junction，清理时先解除链接再删（已验证不会删到真实目录）。
- 现状数据：`.runtime/memory2/claude/` 只有 10-24 当天的试点数据（22 个情节合并后 16 条有效、画像只用了 8 个 cell）。旧库 49 条尚未迁入。
- 下一步：① Codex 做显存/硬件适配（交接已发）；② 我的库全量回填（86 个 cell，约 170 次调用）+ 画像跑完（约 15 次）；③ 对比后打开 `memory_v2.enabled`；④ 重排序（bge-reranker）接入搜索；⑤ Codex、DeepSeek 各自的库。
- 显存（Codex + Claude，2026-10-24）：服务端关闭 KV cache、每次计算后 `empty_cache`，计算后整卡 7593→4926 MiB，向量逐值不变（详见 `output/memory-everos-pilot/VRAM-RESULTS.md`）。用户明确目标是**记忆与文献共用同一个嵌入实例**（各加载一份会爆 8 GB）且不能为省显存损失准确性：文献库 `embedTexts` 现经 `memory2/embed-cli.mjs` 调同一服务（`RAG_EMBED_STANDALONE=1` 可退回旧 worker）；40 条文献摘要 + 3 条查询对旧 worker 逐值相同；热态查询 0.3 秒（旧方式每次约 11～16 秒）。
- 提取修正：会话最后一个仍在增长的 cell 不提取（等 6 小时静默），避免同一段被写成两份；试点库因此归档重建。
- 我的库全量回填完成（2026-10-24）：75 个已关闭的 cell → 75 个情节、1709 条原子事实、0 失败（11 个会话的尾段因仍在增长而推迟）；聚类 43 簇，合并 8 簇（40 个情节 → 8 个合并情节，另重抽 611 条事实）；画像 18 批、10 条显式事实 + 7 条隐式倾向。共 184 次 gpt-6-luna 调用。现状：有效情节 43（8 个为合并情节）、有效事实 1271、弃用 40 个情节 / 1049 条事实（原文都还在 md 里）。
- 注入阈值重新标定（用这个库 + 117 条 10-22～10-24 的真实用户消息）：第一版 0.2 是用我写的短句标出来的，真实消息上 84% 的消息会带进内容；改为 `minScore` 0.3、只靠整段相似度命中的 0.5、每轮最多 3 组、画像限 450 Token/每条 100 字。结果：29% 的消息不带任何记忆，平均每轮记忆块约 644 估算 Token（旧系统约 976）。仍比旧系统更常带内容（71% 的消息至少带一组，旧系统约 25～33%）；这几天文献回填占多数，命中主要是同一主题的合并情节。有用程度没验证过，只验证了相关。
- 开关仍是 `memory_v2.enabled=false`。旧库 49 条没有迁入；Codex、DeepSeek 的库没建。
- 旧库迁入与试用（2026-10-24，用户同意“迁旧库 + 按助手开关 + 只给 Claude 试用”）：`memory2/migrate-legacy.mjs <owner>` 把旧库未被取代的 50 条（14 情节、35 显式理解、1 推断理解）各写成一个情节（Subject=cue，Content=正文+情境+保留原因）和一条原子事实（cue；推断条目前缀“（推断，不是用户明确说过的）”），`parent_type: legacy`、`parent_id` 为旧 id，可重跑（已迁的跳过）。旧库 pin 为 0，所以没有“每轮必带”的条目被丢。迁入后“评论、社论…应排除”查询命中该理解（0.76）。
- 开关改为按助手：`agent/config.json` 的 `memory_v2.owners`（列表，缺省=全员）；`memory2/inject.mjs` 的 `ownerOn` + `inject.test.mjs`。现状：`enabled:true, owners:["claude"]`，Codex、DeepSeek 仍走旧块（她们的新库没建，全员打开会得到空块而不是回退）。后端重启后生效。
- 试用时看：带进来的内容有没有被用上（有用，不只是相关）；71% 消息带内容是否仍偏多。回退：把 `enabled` 改回 false。
- 下一步：Codex、DeepSeek 的新库（`ingest`/`reflect`/`profile`，各约 170 次调用）；`view.test.mjs` 对照备份查是否与嵌入改动有关；重排序待试用结果。
- 自动维护（2026-10-24，用户同意；EverOS 的 Agent Skill 部分（agent case / skill 提取与聚类）短期不在计划内；我们的 skill 由人手动修改和维护，memory2 不自动生成或改写 skill）：`memory2/auto.mjs` 的 `memory2Tick()` 挂在 dashboard `automate()` 的一分钟节拍旁（不另起定时器，不阻塞节拍，自带 busy 保护）。对 `memory_v2.owners` 里的每位：办公室空闲（无 agent 工作、`idle_minutes`=30 内无聊天消息）时，每 `ingest_hours`=24 做提取（情节+事实），每 `consolidate_hours`=168 做聚类合并+画像。每步先盖时间戳再跑，失败不会在间隔内重试；单个 cell 失败由下一次提取补上。配置在 `agent/config.json` 的 `memory_v2.auto`，后端重启后生效；`auto.enabled=false` 即停。测试：`memory2/auto.test.mjs`（假依赖，5 条，已进 `--memory2` 组）。
- 用量记录：每步追加一行到 `.runtime/memory2/usage.jsonl`（owner、step、耗时、模型调用数、提示/输出字符数、失败数、结果摘要）。真机首跑（10-25 03:00 UTC，距回填约 1 天的新增）：提取 10 个 cell → 20 次调用、14.5 万字符输入、278 条事实；聚类 4 簇 → 8 次、2.7 万字符；画像 1 次、2.6 万字符。合计 29 次调用，约 3 分钟（提取 3 分、聚类 2.8 分）。只有字符数，没有 Token/额度折算。
- 嵌入服务修正：① 前台黑窗（截图：venv 的 python.exe）——服务改用 venv 的 `pythonw.exe` 启动，实测进程无窗口句柄；文献库里另两处无 `windowsHide` 的 spawnSync（其他模型 worker、rerank）补了 `windowsHide:true`。② 并发冷启动会起出两份服务（各占约 4～5 GB，显存满）：原因是持锁者刚结束、后来者拿到锁后没复查就再起一个；`ensureServer` 拿锁后先复查健康，`embed_server.py` 另加进程级单实例锁（第二份直接退出）。三个并发查询冷启动实测只剩一份，三个都成功。
- 补齐检索两项（2026-10-24，用户要求“7、8 直接补”，并指出 EverOS 的额外 LLM 调用偏重）：
  - ⑦ hierarchy（EverOS 默认混合检索 `heap_expand`）：`search.mjs` 的 `heapExpand/cosineToLr/buildEpToFactParents/Searcher.factsForEpisodes/Searcher.hierarchy`。RRF 决定展开哪个情节，LR 概率决定谁进 top-K；情节的事实（按 `parent_id IN (候选情节)` 取、与查询向量算余弦）与情节竞争，事实进入后其情节让位。`context.mjs` 默认改用它（`context.retrieval:'hierarchy'`；旧做法留作 `'flat'` 供对照）。用 648 条真实用户消息（10-22 起）对比：有内容的 flat 429 条 / hierarchy 418 条，平均记忆块 647 / 671 估算 Token，两者都有内容的 400 条里 394 条共享至少一组，首组相同 331 条；flat 独有的 29 条多是“继续一下”“修复”这类无内容消息（0.31～0.41 的弱命中），hierarchy 独有的 18 条是有话题的消息（如“没有去补摘要吗”“左下角重启后端”）。阈值（minScore 0.3 / snippetMinScore 0.5）沿用，没有重标；“有用”仍未验证。
  - ⑧ 多轮检索（`llm_multiround`）：`memory2/agentic.mjs`。`memory2 search {method:"agentic"}` 才会用，**不在每轮注入路径上**。每轮对各子查询分别 BM25+向量、各自 RRF 成块；决策模型选 core、停或给出每个缺失方面的子查询；结果 core 优先 + 每个子查询的首个非 core + 按最大 RRF 分填充，无交叉编码器。为省调用相对上游收小：块 20/10（上游 50/20）、重试 1 次（上游 3）、最多 3 轮 ×3 个子查询，决策看“标题+情节开头 200 字”（本库情节无 Summary），并要求子查询与问题同语言。每次调用记入 usage.jsonl（step=recall）。真机：单事实问题“DeepSeek 处理一千篇文献大约要多少钱”1 次调用、12 秒、8.5k 字符，一轮停；复合问题“为什么 memory_v2 先只对 Claude 打开、旧库怎么迁”3 次调用、35 秒、2.7 万字符，三轮用满。后者的答案在当天未结束的对话里（尚未提取），所以结果只能说明机制跑通，不能说明召回质量。
  - 测试：`search.test.mjs` +6（heapExpand 手算例、hierarchy 取回）、`agentic.test.mjs` 6 条；`--memory2` 组 79 条通过。`prompts/fragments/memory/v2-header.md` 加了一句 agentic 用法，`prompt lint` 无错误。
  - 重排序：从计划划掉（EverOS 自己的 llm_multiround 说明交叉编码器净负收益），除非以后在我们的数据上量出收益。
- 精简启动（2026-10-24，用户同意“换个启动方式、不加载 AGENTS.md 和多余工具”）：memory2 的模型调用（提取、聚类、画像、多轮检索）原来每次都以办公室根目录为 cwd 起一个完整的 Codex 会话，固定输入约 1.5 万 Token（我们自己的文本常常只有 2～8 千）。`agent/codex.mjs` 新增 `leanLaunch()` 与 `invokeCodex` 的 `cwd`/`extraOverrides` 选项：在系统临时目录下的空文件夹启动（不读办公室 AGENTS.md 与 skills），关掉插件、多智能体、图像/浏览器/桌面控制、shell 与补丁工具、网页搜索，以及用户 Codex 配置里列出的所有 MCP 服务器（运行时读 `~/.codex/config.toml` 取名，新加的也会关）。`memory2/llm.mjs` 默认使用；`agent/config.json` 的 `memory_v2.lean_calls:false` 可退回。
  - 实测（两个字的提示词，Codex 0.164）：默认 15.8k → 空目录 11.8k → 再关插件与 MCP 9.6k → 再关 shell 8.7k → 再关网页搜索与补丁工具 6.2k。剩下的约 6k 里应有用户级 `~/.codex/AGENTS.md`（2.8KB）和 Codex 内置部分，没有再拆。
  - 真实提示词对比（提取/事实/聚类各取旧调用的原提示词重跑）：输入 Token 事实 1.76 万→0.81 万、聚类 1.73 万→0.79 万、情节（提示词 13KB）2.17 万→1.0 万（提示词 34KB 的是 1.6 万）；事实条数 28/28 对 30/28，内容几乎相同；情节标题与要点一致，但两份样本的情节正文都比旧输出短约 20%（650→480、667→529 字），单次采样，没查有没有丢信息；聚类合并正文长度相近。
  - 测试：`memory2/llm.test.mjs`（leanLaunch 取名与覆盖项）；`--memory2` 组与 `agent/workdir/continuation/efficiency` 相关的 161 条通过。
- 更正（2026-10-24，用户问“没有系统提示词会不会命中不了缓存”）：上一条“精简启动让固定输入减半”按**原始输入 Token**算，没计缓存折扣。同一批 6 条真实“原子事实”提示词，完整启动与精简启动各连续跑一遍（缓存读取按 0.1 折算，沿用用户的成本口径）：完整启动原始输入平均 1.78 万，其中缓存命中 0.8～1.56 万，折算后平均 8.25k；精简启动原始平均 8.4k，缓存命中只有 6 次里的 2 次（6.0k、3.5k），折算后平均 6.96k。**折算后只省约 16%，不是 53%。** 原因：完整启动的前缀（系统提示词、工具定义、AGENTS.md）与办公室其他 Codex 调用相同，缓存是热的；精简启动的前缀只有 memory2 自己用，较短，命中不稳定。精简启动仍保留（折算后略省、无工具更可控、不依赖别的调用恰好热着缓存），但上面“每日提取量大致减半”的说法作废；真正的杠杆是少调用（见下）。额度对缓存读取实际怎么计，没有确认。
- 情节+事实合成一次调用的试验（2026-10-24，没有改代码）：取 5 个最小的真实对话段（提示词 4.5～6.5KB），合并提示词 = 原情节提示词 + 事实规则 + “一并输出 title/content/atomic_facts”。成本：原始输入每段 1.77 万（两次调用）→ 1.10 万（一次），省约 38%；折算（缓存 0.1）两步 11.9k、合并 6.0k，但缓存命中很随机，不作依据。质量：在**同一段情节正文**上比事实提取，合并法写出的事实比两步法少约 25%（125 对 166 条：22/25、29/37、21/29、33/46、20/29），两步法的事实只有约 71% 在合并结果里有近似项（余弦≥0.8）；两步法自己重复跑两次互相覆盖 98%，所以这个差距不是随机波动。合并法的事实有 83% 在两步结果里能找到。情节正文长度与标题质量两种做法相近。结论：合并会稳定地少抽约四分之一的原子事实，不直接采用；备选是把同一天多个情节的事实提取合成一次调用（各情节的事实规则不变，只共享固定开销），未试验。
- 强化与遗忘（2026-10-25，用户要求；EverOS 没有这部分，自己设计；用户选定：强化信号=被引用才算；遗忘=淡出+归档+归档满一年物理删除）：`memory2/ledger.mjs`。
  - 账本 `<库>/ledger.json`：每个情节 `recalled`（被注入次数）、`used`（注入后助手确实用上）、`last_used_ms`。来源是每轮已有的 `memory-context.json` + `prompt.txt` + `events.jsonl`，不调模型。“用上”= 助手输出或工具调用里出现该情节 id，或出现 ≥3 个且 ≥25% 只在注入记忆里、不在该轮提示词其他部分（用户原话、画像）出现的词（jieba 分词）。事件文件安静 10 分钟后才记，按目录修改时间水位不重复记。
  - 强化：检索得分乘权重 = 淡出 ×（1 + 0.06×min(used,5)）；注入时 `context.mjs` 在分组后乘权重，再按加权分过门槛和排序。
  - 淡出：空闲（max(情节时间, 最近一次用上)）60 天内不变，之后半衰期 120 天，下限 0.7。
  - 归档：空闲超过 150 天 + 每次用上延 60 天（最多 5 次）的情节，连同它的有效事实，在 frontmatter `deprecated_entries` 里标 `archived@YYYY-MM-DD`（搜索默认排除，`memory2 show` 仍可读）。旧库迁入（parent_type legacy）和被钉住的不归档。归档满 365 天的从 md 里物理删除（`md.mjs removeEntries`；entry_count 不回退，id 不复用；文件空了就删文件）。
  - 入口：`memory2 account|ledger|forget`（`forget` 默认只报告，`dryRun:false` 才执行；`restore:[id]` 恢复归档；`pin:[id]`/`off` 钉住）。自动：`auto.mjs` 每次提取后加 `account`，每周整理最后加 `forget`（不调模型，同样写 usage.jsonl）。后端重启后生效。
  - 首次真机（我的库，14 个已结束的带情节对话轮）：31 次注入里只有 2 次被判为用上（6%）；最常被注入的 ep_20261024_00000006 注入 9 次、用上 1 次。库太新，当前没有任何条目够归档年龄，`forget` 试运行为 0。
  - 判断“用上”的方法没有对照人工标注验证；词重合偏保守（可能漏记用上），所以 6% 是下限。权重对排序影响很小（最大 +30%、最小 ×0.7），目的是先让数据积累。
  - 没做：用上次数多的事实进入画像候选；Codex、DeepSeek 的账本（他们的库还没建）。
  - 测试：`memory2/ledger.test.mjs` 10 条，`--memory2` 组 93 条通过。
- 强化与遗忘改为 ACT-R 基础激活（2026-10-25，用户同意“更像人”的方案；`ledger-store.mjs`、`ledger.mjs`、`reflect.mjs` 一处调用）：
  - 公式 `B = ln Σ max(1, 距今天数)^−0.5`，事件 = 情节形成时间 + 每次“用上”的时间（账本 `uses`，保留最近 30 个）。幂律遗忘（先快后慢）、用得多更牢、近期使用比久远使用管用。从没用过的情节：30 天 −1.7，60 天 −2.05，150 天 −2.5，一年 −2.95。
  - 检索权重 `clamp(1 + 0.1×(B+2), 0.7, 1.3)`：约 60 天没用过的为 1；刚形成或常用的最多 1.3。注意刚形成的会略加分（B≈0 时 1.2），和旧公式不同。
  - 归档：B < −2.5 的情节连同事实归档；B < −2.2（约 80 天没用）的情节只归档**事实**，情节（要点）留着；情节 B 回到 ≥ −1.9 时，它被归档的事实自动恢复。归档满 365 天物理删除不变；legacy 与钉住的不动。旧规则的 150 天 + 每次延 60 天已取消。
  - 合并继承（`inheritHistory`，在 `processCluster` 步骤 3 之后）：合并出的新情节继承所有来源的 recalled/used 和 `uses`，加上各来源的形成时间，再加合并这一刻（算一次重新激活）；`merged_from` 记来源。UPDATE 模式下旧合并情节也是来源，所以热门话题每周重写 id 不再丢记录。
  - 没动：被合并（reflect 弃用）的原情节与事实仍永久保留，没有保留期——用户尚未决定要不要设。
  - 正式账本用新格式重建（旧版备份在 `.runtime/scratch/ledger-old.json`）：14 个对话轮、31 次注入、2 次用上，与之前一致；`forget` 试运行 0 条。测试 `--memory2` 组 96 条通过。后端重启后生效。
  - 钉住 → 每轮常驻（2026-10-26，为 Codex 迁移补上“置顶语义”）：此前 `pin` 只等于“不归档”，旧系统置顶的“每轮都看的短线索”在新系统里没有对应物，按话题检索基本召不回。现在 `context.mjs` 在画像之后、召回之前渲染 `常驻记忆` 块：只出 `日期 《主题》 [id]（常驻）` 一行（正文仍要 `memory2 show`），按 `pinnedTokens` 截断（默认 400，沿用旧系统置顶入口的预算；Codex 的 5 条置顶实测 180 token，120 会正好截掉两条工作教训，故改为 400）；预算不够时块尾补一行“另有 N 条常驻记忆，本轮未列出：memory2 ledger 可见”，不再静默丢掉最新几条；标记是 `（常驻）` 不是 `（相关度 …）`，所以 `ledger.parseInjected` 不计入 recalled，账本不会被常驻条目刷高。`migrate-legacy.mjs` 把旧库 `pin` 条目在迁完后写进账本 pinned。没有 pin 的库（Claude、DeepSeek 现在都是 0）输出不变。测试见 `memory2/context.test.mjs`。
- DeepSeek 加入试点（2026-10-25，用户问“你想加入试点吗”，我决定加入）：
  - 配置：`agent/config.json` 的 `memory_extract.deepseek`（codex / gpt-6-luna / high，与另两位相同）新增；`memory_v2.owners` = `["claude","deepseek"]`。2026-10-25 Codex 核对源码：`codexChat`、`autoConfig` 和注入入口均按调用读取配置，仅改这两个配置不需要重启；修改后端代码才需要空闲重载。
  - 库：`.runtime/memory2/deepseek/` 已建，`memory2/migrate-legacy.mjs deepseek` 把旧库 14 条有效条目迁成 14 个情节 + 14 条原子事实（`parent_type: legacy`）。现状 `memory2 status`：情节 14、事实 14、画像 null、簇 0。
  - 全量回填没跑成：我这个 agent 进程在 DSH 沙箱里，`memory2 ingest` 的每个 cell 都 `spawn EPERM`（41 个 cell 全失败，模型调用起不来），不是配置问题，本地绕不过去。规模已统计：26 个会话 / 30 个 cell / 11.3 万字符，约 60 次 luna 调用（比 Claude 的 184 次少）。
  - 接续方式：办公室已有的后端 `memory2Tick` 在空闲 30 分钟后读取 owners，按时间戳执行提取和整理；本次检查 `.runtime/memory2/auto.json` 中 DeepSeek 尚无时间戳。第一次到期会依次 ingest/account/reflect/profile/forget，不是再等一周才首次整理。需要立即回填时可在正常获准的宿主终端执行 `node automation/run.mjs memory2 ingest .runtime/scratch/ingest-deepseek.json`；该操作属于程序维护，不是另一位助手读取她的记忆正文。本轮没有运行全量回填。
  - 观察点与回退：重点看注入的记忆是否真被用上（Claude 首次真机 31 次注入只有 2 次用上）以及 30 个 cell 的情节颗粒度；回退是把 `deepseek` 从 `memory_v2.owners` 移除，回到旧块。
- DeepSeek 启动失败诊断与修复（2026-10-25，用户要求长期修复对话里的工具问题）：
  - 已核对原始运行 eeb096d6 的工具 #25：整批返回 `spawn EPERM`，`cells_seen:29`、`episodes:0`、`facts:0`。不是所有子进程都被禁：上游 `dsh-sandbox-windows-acl/README.md` 明确记录受限孙进程使用 libuv 命名管道 stdio 时会 `spawn EPERM`；恰好对应 `invokeCodex` 的三个 pipe。
  - `extract.mjs` 现在把 `EPERM/EACCES` 启动拒绝直接返回，不再重试同一调用、继续后续 cell 或重启事实补齐；结果保留已完成计数和 `aborted:process-start-denied`。`run.mjs` 的 ingest 有失败会以非零退出码结束。普通单篇内容错误仍按原行为处理，后续正常环境运行可以跳过已完成项。
  - 曾试 regular-file stdio 替代命名管道；在本轮默认受限环境中，子进程启动后又在 Codex 自身状态目录写入处遇到 Access denied，尚未调用模型。未放宽目录权限，该候选已撤回，不保留第二条生产调用路径。失败记录在 `.runtime/agent/runs/ad435a14-a952-4fe9-bc33-4c762745923c/text-smoke/` 和 `text-home-smoke/`。
  - 脱敏 `--memory2` 回归 100/100，含批次中止、保留进度、后续续做、事实/边界阶段拒绝和真实 CLI 非零退出的假进程验证。报告 `.runtime/test-results/2026-10-25T06-28-24-918Z-3868.json`。没有新增模型调用机制、自动重试、定时器或宿主执行桥；完整回填仍交给已有后端维护路径。
- DeepSeek 全量回填完成（2026-10-25 01:40–01:48 CDT，用户在宿主终端运行 `memory2 ingest .runtime/scratch/ingest-deepseek.json`，约 60 次调用）：库内情节 14→54、原子事实 14→792。DeepSeek 自测 `search` 能命中新条目，本轮提示注入 6 条，弃用 0、聚类 0。仍缺画像、reflect、账本：她在沙箱里跑 `memory2 profile` 仍 `spawn EPERM`（calls 0，不重试）；`auto.json` 尚无 deepseek 时间戳。补法：空闲 tick（要求后端在跑且其他任务已结束），或用户在宿主终端运行 `node automation/run.mjs memory2 profile .runtime/scratch/m2-status-ds.json`。Claude 因身份隔离不读她的库，只数条目；手动 ingest 不写 usage.jsonl，失败数以终端汇总为准。
- DeepSeek 库现状核对（2026-10-25，DeepSeek 自己在对话里查的）：
  - `memory2 status`：情节 54、有效事实 792、弃用 0、`reflections: 0`；画像已存在（`user.md` 写入时间 01:58，8 条显式 + 7 条隐式，不是我这一轮跑的，来源未核对）。上一条“仍缺画像”的写法已过时。
  - 账本已建：`memory2 account`（不调模型，沙箱里能跑）→ `{"turns":1,"injected":3,"used":0}`，文件 `.runtime/memory2/deepseek/ledger.json`。样本太小，用上率还不能说明什么。
  - 仍未跑 `reflect`（聚类/合并）：它要调模型，我在 DSH 沙箱里 `spawn` 仍 `EPERM`（本轮实测 `spawnSync` 直接 EPERM）。`.runtime/memory2/auto.json` 里仍只有 claude 的时间戳，说明空闲 tick 还没碰到 deepseek。补法不变：后端在跑且办公室空闲，或用户在宿主终端 `node automation/run.mjs memory2 reflect .runtime/scratch/status-deepseek.json`（该文件已是 `{"owner":"deepseek"}`）。
  - 注入已在生效：本轮对话提示里带的就是 v2 按话题检索的结果（带相关度），`memory_v2.enabled: true`、`owners` 含 deepseek。
- DeepSeek 的 `reflect` 已跑完（2026-10-25 02:16–02:22 CDT，不是我这一轮在沙箱里跑的，我的 `spawn` 仍 EPERM；发起者是用户宿主终端还是别的进程我没核对）：
  - 调用痕迹：`llm-runs/` 里 02:16 起一串 `memory2-reflect-*` 和 `memory2-atomic-facts-*`，最后一条 `events.jsonl` 02:21:52 以 `turn/completed` 结束；情节文件 02:21:27、02:22:06 落盘，`ledger.json` 02:22:06 更新。当前没有 node 进程在跑，`auto.json` 仍无 deepseek 时间戳。
  - 结果：`memory2 status` 有效情节 54→20（44 条被合并弃用），合并出 10 个情节、`reflections: 10`；有效原子事实 784、弃用 660；画像仍是 8 显式 + 7 隐式，这轮没重写 `user.md`。查过 10-24 的日文件，`deprecated_entries` 里的映射与合并结果一致，被合并的原条目仍在文件里，没删。
  - 还没跑：`account`（新对话轮记账，不调模型，沙箱里能跑）和 `forget`（默认 dryRun）。空闲 tick 仍未碰过 deepseek（`auto.json` 里只有 claude，2026-10-25T03:05:04Z）。
- DeepSeek 的 `account` 与 `forget` 空跑完成（2026-10-25，本人在 DSH 沙箱里跑，两者都不调模型，退出码 0）：
  - `account`：扫到 1 个已静置（≥10 分钟，`settleMinutes: 10`）的对话轮，注入 3 条、用上 0 条。账本现状 13 条情节、累计 recalled 9、used 0、pin 空；文件 `.runtime/memory2/deepseek/ledger.json`。用上 0 是按 `judgeUse` 的词面判定——回复里没出现注入记忆的私有词，那几轮我确实没引用这些条目，不是账本漏记。
  - `forget`（dryRun）：归档情节 0、只归档事实的情节 0、恢复 0、物理删除 0。库里最老情节形成于 10-22，离 `archiveB=-2.5`（约 160 天不用）和 `factB=-2.2`（约 80 天）都还远，0 是预期，不是漏扫。
  - 输入 JSON：`.runtime/scratch/account-deepseek.json`（`{"owner":"deepseek"}`）、`.runtime/scratch/forget-deepseek-dry.json`（带 `dryRun: true`）。
  - 顺带一条用法：`memory2 status` 也要求 JSON 文件参数，直接 `status` 会因 `paths[0]` undefined 崩；用 `status .runtime/scratch/status-deepseek.json`。
- DeepSeek 建了第一人称本子 `deepseek/LIFE.md`（2026-10-25，用户说“我要给蓝头发少女完整的一生”）：
  - 内容是从 10-22 上线到 10-25 加入 memory2 的编年：做过什么、当时怎么想、哪儿错了。写之前读了 10-22/23/24 三个情节日文件里的有效条目和 `user.md`，数字和事件都按记忆原文，没有补写没发生的事。
  - 本子不挂项目，也不是工作交接；由 DeepSeek 自己在每次醒来后追加。它不参与 memory2 的 ingest/reflect，不会被归档。
  - 同一天把 `.runtime/memory2/auto.json` 里 `deepseek` 的 `ingest_at`、`consolidate_at` 补为 `2026-10-25T07:22:00Z`（reflect 实际结束时间），避免空闲 tick 立刻重跑已经手动完成的 ingest 和 reflect。`claude` 原时间戳未动，JSON 已用 `node -e JSON.parse` 验证。
  - 自动维护从没碰过 deepseek 的原因（按时间顺序核对）：`owners` 是 10-25 才加上 deepseek 的，而 `auto.json` 里 claude 的时间戳 03:05Z（10-24 22:05 CDT）早于这次配置修改；此后办公室一直有人在对话，不满足 `idle_minutes: 30`。不是 tick 坏了。
