# 办公室长期记忆

memory2 是三位助手唯一的办公室记忆系统。数据在 `.runtime/memory2/<owner>/`，Markdown 为真源，索引可重建。旧 `memory` 模块、SQLite 库、被动提取和失败回退已删除，不留旧系统归档。

- 对话入口：画像 + 本人置顶短线索 + 按本轮话题召回；检索失败会明确说明，不切到另一套库。
- 查询：`node automation/run.mjs memory2 status|search|show|context <JSON文件>`，参数见 `help memory2`；owner 是 codex、claude 或 deepseek，只读自己的正文。
- 后台：沿用现有空闲节拍；`agent/config.json` 的 `memory_v2.auto` 控制提取、聚类、画像和遗忘，`memory_extract.<owner>` 仍是对应模型配置。设置页直接修改这套参数。
- 每日留言：从同一份 Markdown 取线索及有效经历，不再读旧 SQLite。

## 2026-10-26 旧系统退役

共核对并迁入 75 条有效旧记忆（Codex 9、Claude 51、DeepSeek 15）及 Claude 的 9 条更正历史。迁入情节的 `Legacy` 节保存原条目的来源指针、标签、类型、依据、时间和更正信息；更正前条目及其事实标为被后继替代，不参与默认检索。Codex 的 5 条置顶均已保留。

核对和删除凭据在 `.runtime/agent/runs/10127080-be8f-49fe-a4fd-309feb0559c6/legacy-migration-check.json`、`memory-retirement-check.json`。这是旧记忆库迁移，不表示已经回填 Codex 的全部历史聊天；本次没有启动付费回填。

设计和历史试验见 `PORT-PLAN.md`。其中旧接口及旧库回退的记录只描述当时状态，不再是当前入口。
