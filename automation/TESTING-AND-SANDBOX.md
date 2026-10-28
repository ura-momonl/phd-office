# 测试与沙箱权限

（自 AGENTS.md 原样迁出，2026-10-23；AGENTS.md 只留入口行。）

- 测试用 `node scripts/run-tests.mjs` 创建脱敏隔离副本，需要保留失败现场时加 `--keep`；不在真实项目目录直接运行会改数据的测试，不关闭沙箱、不用 bypass、不把授权泛化到所有 Node 命令。
- 普通读取、项目内修改和不启动受限子进程的检查用默认权限。`--browser-safety --keep` 默认权限可跑；默认能启动 Node/Python 子进程，不预设 `spawn EPERM`。
- 当前环境经验：`--sandbox`、`--mail` 默认权限会失败（Docker 配置被拒、`--mail` 还会遗留测试子进程），走正常工具授权：Codex 的 `exec_command` 用 `sandbox_permissions:"require_escalated"` 并说明宿主依赖，Claude 用当前工具的正常审批。授权任务内的常规隔离测试直接提交审批，不先停下来问用户“要不要授权”；环境或权限策略变化后重新判断。
- 例外：**新 Codex 会话**跑 `node D:/Main/assistant/scripts/run-tests.mjs --sandbox --keep`（必须用这个绝对路径，工具用 `use_default`），用户级 `~/.codex/rules/office-tests.rules` 只放行这个固定入口。规则启动时加载，旧会话可能仍需正常审批；不要把它泛化到 `--mail`、其他 Node、Docker 或其他命令。
- 审批被拒、管理员要求或新增持久权限设置，按实际边界处理，不绕过、不换壳、不改写命令。当前工具不能请求授权时，停止该执行路径并如实报告。
- 只有实际跑完的测试结果才算通过；权限失败不是断言失败，记下命令、环境和错误即可。

