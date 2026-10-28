# 重审子agent任务说明（复制后只改任务路径）

你在 D:/Main/assistant 做文献库重审的阅读工作（用 Bash，POSIX 语法、正斜杠路径）。你的任务文件：`output/literature-rebuild-20261021/library-rereview/<轮名>/<编号>-task.json`

这是对【已收录】论文按新标准重新判断：不要因为它已在库里就默认保留，要像第一次读一样独立判断。

步骤：
1. 先读 `.agents/skills/literature-backfill/references/reader-card.md` 了解字段与命令，再运行 `node .agents/skills/literature-backfill/scripts/brief.mjs <TASK>`，它会打印字段规范 RUBRIC、唯一选文标准和第一个题名窗口。本任务是重审，**跳过题名窗口和 mark 步骤**，直接用 `node .agents/skills/literature-backfill/scripts/reader-work.mjs read <TASK>` 取摘要页（每页约 7 篇）。
2. 完整读每页摘要，按选文标准逐篇判断：include=相关且不常见／很有说法且论证扎实（出色的应用器件设计也收）；exclude+scope=in=相关但看不到具体看点（性能数字报告、熟悉路线上的参数优化、常规表征）；exclude+scope=out=明显无关或主要贡献在能源／催化／电池／膜分离／生物学／生物医学；pending 仅限关键信息确实不够。同类文章前后判断要一致。reason 写看点和论据（或不收的具体原因），不要只写"常见""普通"。
3. 每页判完立刻写到 task 里的 chunk_file（UTF-8 JSON 数组，用 Write 工具覆盖写，只含本页、原顺序、原 id），然后运行 `reader-work.mjs append <TASK> <chunk_file>`；被拒按报错改 chunk，不要改判断标准迎合程序。重复 read/append 直到 complete:true，共约 15 轮。evidence 须是摘要里连续原文、≤20 个英文词、不含 LaTeX、大小写空格一致。
4. 不派子 agent、不联网、不改 catalog 和其他文件，只写自己的 chunk_file 和 output；不读 USER-ONLY 或 private-literature-eval。

结束时只汇报：保存篇数/总数；include、exclude(scope=in)、exclude(scope=out)、pending 各多少；至多 8 个你最拿不准的 id 加一句理由。不要贴摘要或逐篇记录。

## 实测中常见的拒收原因（程序会拦，按报错改evidence即可）
evidence 大小写与摘要不一致、超过20词、含`$`或反斜杠、用了连字符/en dash的Unicode变体。
