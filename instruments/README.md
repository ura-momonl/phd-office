# 仪器图鉴与控制代码

办公室入口：**更多 → 仪器图鉴**。卡片记录在 `instruments/catalog.json`，可在页面新增、编辑与补实机照片。图鉴不连接仪器、不运行代码；展开代码时读取当前源文件，可查看、复制、下载，并显示 SHA256。

助手入口：`node automation/run.mjs instruments list` 找仪器，`show <名称关键词或id>` 读完整卡片，`note <JSON文件路径>` 追加带日期和来源的使用记录（参数见 `help instruments`）。用户提供的新能力或限制记在对应卡片，不另建一份设备清单；本命令不连接或运行仪器。

## 当前文件位置

按“归谁管放哪里”：

- `programs/oe1022d/`：Lock-in 主驱动 `SSI_OE1022D_modified.py`、窗口版读取＋控制程序 `read_lockin_ui.py`、其离线测试、说明和验证记录。
- `programs/keithley-6221/`：`Keithley6221.py`。
- 联合测量程序属于实验，不属于仪器：在 `workspace/projects/graphene-thz/experiments/dc-lockin-sweep/`（`measure_simple.py`、说明和数据）。它启动时会在上层目录里查找 `instruments/programs/{keithley-6221,oe1022d}/` 并把驱动加入 `sys.path`；驱动与脚本放在同一目录时以同目录的为准，所以拷到测量电脑时把两份驱动放在脚本旁边即可。

说明：`measure_dc_lockin.py` 及专测它的 `test_offline.py` 已按用户要求删除（恢复副本在 `.runtime/removed/2026-10-12/`，原交付压缩包 `deliverables/dc-lockin-sweep.zip` 里另有更早版本）；`lockin-live` 里重复的旧版驱动副本已去掉；联合测量程序默认数据目录是实验目录自己的 `data/`。

## 参考与验证

OE1022D 优先使用图鉴所登记的 `oe1022d/SSI_OE1022D_modified.py`；按用户指定，该控制文件高于通用仪器手册，常规不重复查手册。R 标为 RMS 幅值。未覆盖或实测冲突时再补查，不为登记图鉴重写仪器逻辑。

图鉴不连接真机，也不重新认定仪器输出准确度。
