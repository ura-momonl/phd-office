# 主包→子任务→有界阅读→及时落盘

实测出现过主包被直接当成一个子任务、读取输出截断后空手返回，以及复核只看一小部分却不落盘。修复是主助手再切子块、限制每次工具输出、保存已完成前缀，不是降低整轮主助手工作量。

## 先领取独立分派结果

主助手先单独调用literature-dispatch skill，取得plan及子task清单；切块命令、输入准备和复核子集选择都归该独立任务。本skill不再提供split入口。先收拢正在跑的范围，不能因尚未落盘而重复分配；分派工具保留旧结果并报告字段问题，由主助手修正，不擅自覆盖。

## 给子agent的任务应明确到动作

给她唯一task文件及以下步骤，授权只写task里的chunk_file、output及其临时文件；不派下一级agent、不联网、不改原输出/catalog/共享表：

1. 读task、reader_guide及唯一选文标准（brief.mjs一并打印）。运行：
   `node .agents/skills/literature-backfill/scripts/reader-work.mjs read <TASK>`
   先 `reader-work.mjs titles <TASK>` 看题名窗口并用 `mark` 提交题名排除（见 reader-card.md），再 `read` 取窗口内其余条目的摘要。默认从已存有效前缀后读取；每次输出最多12000字符，不在一篇摘要中截断。只展示判断所需的id、DOI、题名、期刊日期和完整来源摘要，不打印庞大作者元数据或整包JSON。
2. 完整读本页所有摘要，逐篇判断；缺摘要按规则待核/明显题名排除，不把缺源当读完，也不因此停止整块。
3. **立刻**将本页逐篇判断写到task的唯一chunk_file（UTF-8 JSON数组），然后运行：
   `node .agents/skills/literature-backfill/scripts/reader-work.mjs append <TASK> <CHUNK_FILE>`
   也可把 `<CHUNK_FILE>` 换成 `-`，用 heredoc 经 stdin 直接交，并可用紧凑字段（d/t/r/g/e/s/ss，其余由程序按来源补齐），写法见 reader-card.md 第 4 步；`mark` 同样支持 `-`。
   程序检查原ID顺序、字段、枚举、范围和原文证据后，原子追加到该子块output。程序检查不证明科学判断正确。
4. 再运行read，接着保存下一页，直到该子块完成。不要一次读取100篇后才写；不要已读25篇却因未完成100篇而丢掉这25条。重读可显式`--from`，但不能跳过未判记录后伪造前缀。
5. 汇报实际保存数、剩余数、output路径及少数边界。真实中断也必须留下合法前缀；不能空数组、模板或统计冒充逐篇结果。子块完成是子agent的结束点，主助手整包阶段仍继续。

## 主助手合并与验收

```powershell
node .agents/skills/literature-backfill/scripts/reader-work.mjs merge <PLAN> --dry-run
node .agents/skills/literature-backfill/scripts/reader-work.mjs merge <PLAN>
```

screen合并只扩展原work item的合法连续前缀，不覆盖已有不同判断；review合并只生成独立审阅文件。原文不匹配、重复ID、损坏JSON或并发变化时报错保留现状，不绕过。若后面的子块先交付，文件保留等待前面缺口，不误报整段完成。

机械合并不是内容验收或入库。主助手按review-and-admit.md核对本人拟收、待核、边界及排除抽核，不默认再读全包。Claude自己验收Claude包，Codex自己验收Codex包，不转对方复审；各自通过admit-reviewed.mjs串行入库，保留协调者的分配字段。
