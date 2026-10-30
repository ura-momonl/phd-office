---
name: literature-dispatch
description: 将文献重建主包独立切成不重叠的阅读子任务，生成输入、task和唯一结果路径；不用于摘要判读、内容复核或入库。
---

# 文献子任务分派

依据2026-10-21用户要求“主agent再切块给子agent”“把拆文章的任务独立出去”。适用于已由协调者分配给主助手的文献主包；这里只准备数据，不调用模型或写catalog。

## 执行

DeepSeek 的独立包也使用本入口：`dispatch.mjs deepseek --package pkg-deepseek-NNN --children 1 --round r01`（可先加 `--dry-run`）。依据 2026-10-23 用户要求接入文献筛选。默认每块最多 100 篇；`--size` 可调，主包不足则按实际数量。生成后运行 `launch.mjs deepseek <包ID>` 看各块状态；她的首轮读法见 literature-backfill 的 DeepSeek 一节（`first-pass.mjs`），不执行下文 Codex／Claude 的模型指定。只有包已归她所有时才切；本入口不改 owner、不调用模型。

1. 从`output/literature-rebuild-20261021/CONTINUE.json`或literature-backfill的只读定位入口取得本人包ID与manifest。先收拢已经在跑的子任务，不能对正在读但没落盘的范围重复分配。保留原owner、work item范围和输出文件。
2. 在办公室根目录执行，`--package`明确选本人包；一般按十个子任务组织（千篇包即每块约100篇；每块10篇的十乘十方案实测吞吐只有约三分之一、token也没省，不要往小切），扣除本轮已用名额，原生槽位更少时取实际值。

```powershell
node .agents/skills/literature-dispatch/scripts/dispatch.mjs codex --package pkg-codex-001 --children 10 --dry-run
node .agents/skills/literature-dispatch/scripts/dispatch.mjs codex --package pkg-codex-001 --children 10 --round r01
# Claude改成claude及其本人包ID。--size和--max-chars可调整子块体积。
```

3. 交付plan路径及每个task/input/output/count清单；每块有独立结果路径，禁止多个子agent同写原大输出。程序跳过现有ID前缀，字段问题列为待主助手修正，不自动当验收通过。损坏JSON、乱序ID、重复round会停并保留现场。
4. 主助手回literature-backfill领取这些task，按本次任务指定的子 agent 模型派读、逐页保存，随后机械合并及内容验收。题名粗判断（先看题名、挑出明显无关或能源／催化／电池／膜分离／生物学／生物医学为主的，按唯一选文标准及2026-10-22用户补充）也由这些被派出的子模型在各自task里完成，主助手不另做这一步。生成清单本身不占模型名额，也不代表已经派出或读过。

## 切 DeepSeek 包并派给她

从 Codex／Claude 的空闲 ready 包拆前 N 篇（默认 200）成新的 pkg-deepseek-NNN，源包保留剩余。程序检查：源包只有一个 work item、没有子任务产出、摘要齐全、与现库和其他包不重复；留备份和 DELIVERY.json，读回核对分割和哈希，不改 catalog。Nature Communications 这类多 work item 的源包不适用。

```powershell
node .agents/skills/literature-dispatch/scripts/split-package.mjs <源包ID> pkg-deepseek-NNN 200 --dry-run   # 先看能不能切
node .agents/skills/literature-dispatch/scripts/split-package.mjs <源包ID> pkg-deepseek-NNN 200
node .agents/skills/literature-dispatch/scripts/dispatch.mjs deepseek --package pkg-deepseek-NNN --children 1 --size 100 --round r01
```

派给她用 `agent handoff <JSON路径>`（格式见 `node automation/run.mjs help agent`），不要在当前对话里直接 @ 她：那样是轮流发言，不是另开对话。JSON 是 `{"title":…,"notify_back":true,"text":"…"}`，`notify_back` 让她第一轮做完后的回复作为回执排回你这条对话。text 开头用 @DeepSeek 写明接收者（不写会接给别人，也不要带 model 字段）。text 里写：用户要什么、包的范围和位置（DELIVERY.json）、这次要对比什么、交回时写什么；她的做法在 literature-backfill 的“DeepSeek 包”一节，不必重抄，也不要叠加新的检查或口径。用户要测试时，每次用新拆的包，有明显改动后才测。

收回执后核对：receipt.json 的新增数和读回标志、`literature/catalog.json` 里这些 DOI 是否都在、decisions／audit 里的计数。她那一轮的用量按该次运行目录里 `events.jsonl` 的逐步用量加总（`usage status` 只记主会话，不含子会话）；单价按余额变化校准，缓存命中约 0.05、未命中约 1.2、输出约 2.4 元／百万 token，是估价不是账单。费用主要在她本人读 `lite.txt` 那一轮，`api-screen` 和 `review-flags` 是直接调 API，便宜得多。

## 复核子集另行明确

默认只切尚未落盘的初筛部分。不要再自动对全主包切第二轮全文摘要复核。确需委派复核时，主助手先按literature-backfill的风险策略选出明确ID，保存UTF-8 JSON数组，再执行：

```powershell
node .agents/skills/literature-dispatch/scripts/dispatch.mjs codex --package pkg-codex-001 --review --ids-file output/本轮复核ID.json --children 3 --round audit01
```

ID必须属于本人包且无重复；不附旧答案，复核输出独立保留，不自动覆盖初筛。系统性错判需要扩大复核时，由主助手记录具体问题和扩展范围；不是默认全1000篇再读一次。字段与证据校验共用literature-backfill的records.mjs，不另养一套判断标准。
