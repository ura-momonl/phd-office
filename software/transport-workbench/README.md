# Transport Workbench：Codex 操作入口

软件本体：`D:/Main/transport-workbench-mcp/`，原始包 `D:/Main/主程序.zip` 保持原位。操作与维护由 Codex 接手。分析引擎、MCP 工具说明和上游 smoke test 沿用该目录，不另复制。

## 从办公室调用

使用已有独立 Python 环境，以官方 MCP SDK 启动原 stdio 服务；不需要改助手个人配置，不依赖桌面 GUI。这里是脚本调用入口，**不是本聊天已经挂载了原生 MCP 工具**。

```powershell
# 列工具及其完整参数 schema
& D:/Main/transport-workbench-mcp/.venv/Scripts/python.exe -B -I software/transport-workbench/client.py
# 运行示例（只读程序自带的合成示例，不是用户实验数据）
& D:/Main/transport-workbench-mcp/.venv/Scripts/python.exe -B -I software/transport-workbench/client.py software/transport-workbench/example.json --output .runtime/transport-example.json
```

以上命令从 `D:/Main/assistant` 执行。其他 cwd 用 client.py 和请求文件的绝对路径。

本机 `.venv` 依赖 `C:/Users/24193/AppData/Local/Programs/Python/Python312/python.exe`。本轮默认沙箱不可访问它，经正常授权后 MCP 启动与示例读取成功；在同样沙箱里调用时需走正常授权，不表示虚拟环境损坏。

请求为 UTF-8 JSON 数组，每项 `{ "tool": "工具名", "arguments": {...} }`，所有调用依次在**同一服务进程**内执行。新会话第一次 load_data 的句柄为 ds1，Excel 多 sheet 会继续分配 ds2 等；返回值包含实际句柄。新进程没有此前的 ds/sc 句柄，需要再次加载。工具返回错误时保留已执行结果并以退出码 1 结束，不重复调用。

输入和图/导出路径用绝对路径；实际研究的请求、结果和图放相应项目目录。`--output` 保存 UTF-8 结果；省略则输出 JSON。需要根据中间结果动态决定后续调用时，直接复用 client.py 的 ClientSession 写当前任务脚本即可。

引擎目前可用的工具及未接入的功能以软件本体 README 和实际工具 schema 为准。机制拟合已接入（2026-10-28，Claude）：`scaling_mechanism_fit`、`scaling_identifiability`，PRX 2026 Table I 的 20 个三阶机制齐全，来源与 Eq.17 不一致处见软件 README「机制拟合」。真实实验数据试用尚未进行。本次没有改动其他助手配置，也没有修改原始包、引擎或 server.py。

本轮自带 PPMS 示例读到 50 行、15 列，温度 2–38.505 K；单位元数据返回 null、幅相通道对列表为空（此例本身是 X/Y 列）。列名仍保留单位文本，做 Scaling 时可显式给列映射与单位。
