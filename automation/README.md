# 个人工作自动化框架

可逐步扩展的本地工作框架。统一入口 `node automation/run.mjs <模块> <动作>`；已注册模块见 `config.json`，`help` 列出全部，`help <模块>` 看用法。

```powershell
& 'D:\Program Files\nodejs\node.exe' automation/run.mjs help
& 'D:\Program Files\nodejs\node.exe' automation/run.mjs mail collect
```

每个功能只有一条工作路径：程序准备证据和保存状态 → AI 判断真正需要理解的部分 → 程序应用结果并交付。程序能算、找、排序或提醒的由程序完成，不为空闲队列调用模型，不把读文件、加标签、写清单分别交给代理，也不先为尚未接入的功能写通用代理调度器。

| 部分 | 当前实现 | 加新功能的方法 |
|---|---|---|
| 入口与调度 | 普通 Node CLI；模块注册表 | 注册本地入口和动作；导出 `run(action, argument)` |
| 资料与状态 | 各模块维护自身事实；PROFILE 只有原文件一份 | 保留来源、内容指纹和处理进度；不复制完整聊天作记忆 |
| 执行与判断 | agent 模块按需启动原生 Codex／Claude | 注册真正需要的资料与工具；保留结果、来源和实际调用记录 |
| 交付 | 本地文件；邮箱模块输出 today.md | 产出用户实际需要的文档、表格、数据或下一步清单 |
| 成本观察 | usage 模块记录实际调用，原生接口读取 Codex 额度 | Claude 剩余额度暂手动记录；不换算虚构美元成本 |

配置：`config.json` 的 ai 开关和资料包限额用于邮箱判断；`agent/config.json` 的 `enabled` 控制工作台执行器，只处理明确提交的任务。判断预算是资源约束，准确率是交付要求：优先消除重复历史、无效轮次和工具操作，复杂判断保留证据并用足够强的模型；截断内容不能支撑结论时保留待确认。不把订阅金额换算成固定 token 数。

邮箱：Windows 程序任务 `PhD-Workflows-Mail-ReadOnly` 每十分钟收集和汇总，不调用模型（开机并登录才运行，错过会在可用时补）。细节见 [mail-flow/README.md](../mail-flow/README.md)。OpenClaw 的邮箱和文件投递代理已关闭、依赖已清理，旧启动脚本仅为历史，现行链路不调用；文件自动投递模块未接入，材料由 Codex／Claude 按需处理。子 agent 只在值得委派的任务中使用，不为分类、登记、提醒默认开一个。

相关文档：[BOOTSTRAP.md](BOOTSTRAP.md)（目录与文件安排）、[AI-COLLABORATION.md](AI-COLLABORATION.md)（短会话协作）、[CLAUDE-REVIEW.md](CLAUDE-REVIEW.md)、[Discord 接入](../remote/README.md)。dashboard 与 Discord 使用同一个任务执行器，weekly 生成周材料。

## 文件变化提示与运行版本

底层 `file-state.mjs` 统一采集和比较快照；不是语义版本号，不用手动 bump，不启动 watcher、模型、重试或计时器。

- **后端基准**：执行进程启动时固定后端入口、办公室内字面 ESM 依赖、CLI 注册表和 package／lockfile 的内容指纹。`/health.code` 与 `/api/state.code` 给出 `loaded`、`disk`、`state:current|stale|unknown` 和变化路径；后端代码增／改／删会提示重启，只 touch 不提示。前端 JS／HTML／CSS 和运行时重读的业务数据／配置不触发后端重启。
- **查看**：网页侧栏底部显示 `v<运行指纹前10位>`，落后附 `↻` 重启提醒，未知附 `?`；点开看运行／磁盘指纹、路径和活动任务保护。`node automation/run.mjs dashboard status` 只读查询运行中的服务。`version:2` 是启动器兼容标识，不能据此判断源码新旧。
- **重启**：侧栏刷新按钮是“重启后端并刷新页面”，仅无活动任务／后台工作时可用；存在草稿、附件或编辑窗口则拒绝。一次点击只发一次重启 POST，等健康检查确认新启动时间再加载页面，失败不自动重试。首次加载新版重启 helper 前，等全部活动任务结束，从托盘退出办公室，再重新打开 Workbench；只改前端时普通刷新即可。磁盘脚本更新不等于托盘后端已重载。
- **工作轮接口**：`prepareFileNotice(previous, reportPath)` 返回提交前的 `snapshot`、短提示 `text` 和完整路径 `report`。`agent/run.mjs` 中所有 Claude／Codex work（含关闭续接的 Codex）共用，full 与 resume prompt 使用同一份结果，并写该轮 `file-changes.json`。基准按**会话＋助手**独立保存在内部 `file_snapshots`，不绑定原生 thread；首次不能追溯此前变化，无变化不加清单。
- **提交边界**：公共回调 `onSubmitted()` 确认初始 prompt 被接收后才保存提交前快照（Codex 是 `turn/start` 响应，Claude 是初始 user UUID 的 replay 确认）；提交前失败不推进；ask／卡片不采集、不注入、不更新。提示不保证捕获本轮执行中发生的变化，不判断修改者；修改前仍应重读现状。
- **范围与隐私**：办公室共享代码与普通资料，排除运行目录、缓存、依赖、隐藏私人目录、个人记忆／投递箱、凭据、日志、队列和自动 STATUS 页面；不跟随链接。≤1 MiB 的常见文本按内容比较，其余按大小与 mtime，快照不存正文。一次提示至多 12 个路径，完整清单在该轮运行目录的 `file-changes.json`。
- 测试：`node scripts/run-tests.mjs --changes --keep`（脱敏副本，不启动模型）。真实后端须先安全重载，自然轮才会用新接口。
