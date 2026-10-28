# 独立命令沙箱

从外部 PowerShell 运行，不依赖 Workbench。当前完成的是 **Linux 命令执行隔离**：Node 24、Python 3.11、只读输入、独立可写工作目录、禁网。没有模型调用、重试或后台任务。

宿主上的启动器负责准备输入、管理容器与保存结果。Docker Desktop 的 Linux 容器负责实际隔离。复制输入只用于保留原件，不单独充当安全边界。

## 使用

前提：本机 Docker Desktop 的 `desktop-linux` 引擎已运行。未运行时手动执行 `docker desktop start --timeout 45`。启动器不自动启动、切换、安装或升级 Docker。

```powershell
cd D:\Main\assistant
# 首次准备运行时；这一步需要下载官方 Node 镜像和 Debian Python 包。
node sandbox/run.mjs build

# 运行已有的虚构示例，不需要重新构建。
node sandbox/run.mjs run sandbox/examples/task.json
$LASTEXITCODE
```

示例应生成 `{"count":4,"sum":17,"node":"…"}`（Node 版本取决于构建的镜像）。

任务文件只接受三个字段：

```json
{
  "input": "./input",
  "command": ["python3", "/input/task.py"],
  "timeoutSeconds": 30
}
```

`input` 相对任务 JSON 所在目录解析，必须是明确指定的普通目录。每次运行复制到独立任务目录并只读挂载到 `/input`。`command` 是容器内的程序和参数数组，不经过宿主 shell。工作目录为可写的 `/work`，需要修改输入副本时先复制到这里。`/tmp` 是临时内存目录；其余运行时文件系统只读。超时默认 120 秒，允许 1～3600 秒。

不接受输入中的符号链接、Windows junction 或路径祖先中的链接，也不接受包含任务存储目录的宽泛输入。遇到这些情况会保留失败记录并拒绝运行，不自动跟随或跳过资料。不要把整个办公室根目录作为输入。

## 结果、失败与停止

终端打印本次 UUID 和结果 JSON。文件保存在：

```text
.runtime/sandbox/jobs/<UUID>/
  input/       本次输入副本
  output/      容器 /work，包含任务产出
  task.json    解析后的任务参数（预检失败时可能没有）
  stdout.log   容器标准输出
  stderr.log   容器错误输出
  result.json  阶段、退出码、镜像 ID、时间和清理结果
```

退出码 `0` 表示命令成功；普通命令失败保留其退出码；`124` 表示超时，`130` 表示收到中断。准备或清理失败返回 `1`，原因写在 `error` / `cleanupError`。命令成功不能代替对实际产出的核对。

正常结束、命令失败、超时或 Ctrl+C 后，启动器只删除本次拥有的容器，保留输入、输出及日志。容器内的后台子进程随容器一起结束。若宿主启动器被强制终止，或终端消失，可凭已打印的 UUID 在另一个终端停止：

```powershell
node sandbox/run.mjs stop <UUID>
```

停止命令核对记录中的容器 ID 和所属标签，拒绝处理其他容器。如果 Docker 引擎不可达，恢复引擎后再执行；不需要重新安装原生沙箱或杀其他 Codex 进程。此入口不会删除保留的任务资料。

## 隔离边界

容器以非 root 用户运行，去除 Linux capabilities、禁止提权，限制为 1 GiB 内存、2 个 CPU、128 个进程和 128 MiB 临时目录。不挂载 Docker socket、宿主盘、用户目录、凭据、邮箱或桌面接口，不继承宿主环境变量，只挂载本轮输入副本和全新输出目录。任务运行时 `--network=none`；构建时的下载与任务联网是两个阶段。

测试：`node scripts/run-tests.mjs --sandbox --keep`（脱敏隔离副本；需访问 Docker 并启动子进程，按工具正常审批运行；不调用模型、不启动浏览器、不用真实科研资料）。默认完整测试不隐式运行这组 Docker 测试。覆盖：宿主假秘密不可读、容器内链接与输入 junction 被拒、输入及运行时不可写、环境变量不继承、外网与宿主网关不可连、任务间不可见、失败／超时／停止后的容器清理。

## 会话桥接：让 agent 只通过容器干活（`sandbox/mcp.mjs`）

`node sandbox/mcp.mjs <输入目录>` 是一个 stdio MCP 服务，由 agent 宿主（如 Codex app-server）按 `mcp_servers.<名>.command/args` 启动。它复制输入、起一个离线容器（同上述边界，`sleep 3600` 兜底），只暴露一个工具 `sandbox_exec`（argv 数组 + 1～300 秒超时，超时由容器内 `timeout` 终止），宿主关闭 stdin 时删除容器。每次调用的 argv、退出码和完整输出追加到 `.runtime/sandbox/jobs/<UUID>/calls.jsonl`；`stop <UUID>` 同样适用。

**模型和认证留在宿主，凭据不进容器；命令执行只走这个容器工具；其余宿主工具的残余限制见下文。** 前提是宿主 Codex 的内置 shell 工具关闭：`features.shell_tool=false`、`features.unified_exec=false`，同时关掉其他 MCP 与插件，线程用 `read-only` + `never`。在本机 Codex 0.163.0 上的观察（模型自述工具表加实际尝试）：没有 shell；JS `exec` 无文件系统；`apply_patch` 写宿主被只读沙箱拒绝；`view_image` 仍在列表中，对文本文件返回“不是图片”，**不能排除它读取宿主图片文件**；`tools.view_image=false`、`include_apply_patch_tool=false` 在该版本无效，别指望它们。`features.code_mode_host=false` 会让 MCP 工具一并不可用，不要关。证据与可复现的探针在 `.runtime/acceptance/codex-only-mail-20261015-r2/run-sandboxed.mjs probe`（换成自己的金丝雀路径）。

## 能力范围

宿主线程的 `read-only` 约束宿主文件工具，不撤销 `sandbox_exec` 明确提供的容器 `/work` 写入能力。工具声明 `readOnlyHint:false`：需要修改办公室记录时，把 `/input` 复制为 `/work/office`，在那里调用现有模块，原输入保持不变。宿主客户端应在其 developer instructions 中准确声明这两个权限范围，不把容器可写误报为宿主权限被放宽，也不把尚未尝试的写入说成已经被拒绝。只有实际工具返回的权限失败才算失败。

这是 **离线 Linux 命令沙箱**，可供当前助手或程序显式调用。它不运行 Windows GUI，也不提供浏览器、桌面、邮件或联网工具；日常 Codex/Workbench 的工具及全局配置未改动，**日常工作不经过它**（日常被审批/`spawn EPERM` 拦下是另一回事，不由本沙箱解决）。会话桥接只用于需要“读不到宿主其余资料”的受控回放；不要把它当作日常工具的替代。

Docker 的使用方式依据 [Windows 权限边界](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/) 和 [只读 bind mount](https://docs.docker.com/engine/storage/bind-mounts/)。交接记录见 [沙箱交接](../automation/SANDBOX-HANDOFF.md)。
