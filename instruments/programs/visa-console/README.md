# VISA Lite

一个 Python 文件的小窗口：列出当前 VISA 资源，选择或手输地址，连接后发送/查询命令、读取响应。只依赖 Python 自带 Tkinter 和已安装的 PyVISA，使用现有 NI-VISA/IVI 后端；**不安装、更新或修改 NI-VISA，不改系统驱动、`.pyvisarc` 或环境变量**。

## 运行

```powershell
python visa_console.py
```

也可双击 `visa_console.py`（如果 Python 文件关联正确）。若机器有多个 VISA 厂商库，可仅为这次运行指定已有 NI-VISA DLL 的实际路径：

```powershell
python visa_console.py --visa-library "C:\Windows\System32\visa64.dll"
```

该路径是示例，需以本机安装为准。程序显式使用 `@ivi`，不会自动退回 pyvisa-py。运行时会显示实际加载的库；多个厂商库共存时不能仅据默认路径就认定加载的是 NI 的实现。NI-VISA 和 Python 位数需匹配。没有自动安装或修复驱动的功能。

## 使用

1. 点击 **刷新资源**。这会调用 `list_resources('?*')`，不向每台设备发送身份或设置命令。资源列表可能包含串口、接口等，**列出资源不等于证实连接了仪器**；未被 VISA 发现的地址可以手输。不是局域网扫描器，也不是所有 USB 设备的枚举器。
2. 选择地址，设置读/写结束符、超时（默认 2000 ms）、串口波特率（默认 9600），点 **连接 / 应用**。串口其余格式使用 VISA 默认值；如仪器需要非默认数据位、校验、停止位或流控，本工具暂不提供调整。改参数后再次点连接才能生效。
3. **查询 ↔**：发送一次命令，再读取响应。**发送 →**：只发一次，不读。**读取 ←**：只读，不发命令。响应用 Python 字符串表示显示，便于看出 NUL/换行等隐藏字符。面向文本命令，不处理波形/图片等二进制块。

本次用到的两台设备：

| 仪器 | 波特率 | 读/写结束符 | 身份查询 |
|---|---|---|---|
| OE1022D（串口） | 9600 | CR (`\r`) | `*IDND?` |
| Keithley 6221（GPIB） | 不适用 | LF (`\n`) | `*IDN?` |

Lock-in 可以查询 `FREQD? 1`、`SENSD? 1`、`OFLTD? 1`，以及 `SNAPD? 1,2,3`（Ch1 R、φ）。不强制通用仪器使用这些命令，需按各自手册输入。

程序不会自动复位、设电流、改 Lock-in 参数或启用输出。**用户手动发送的设置命令仍会改变仪器**，例如 `OUTP ON`，请自行核对。不要和测量程序同时占用同一仪器。查询超时可能意味着命令已发但未读到回复；不自动重发，先检查仪器和接收缓冲，再决定是否只读取或断开重连。

断开/退出仅关闭 VISA 会话，**不关闭仪器实际输出**。退出会等待正在进行的操作结束；程序不并发重试或强制中断 VISA。日志仅留在窗口，显示保留约 2000 行，不写文件。

依据：[PyVISA 通信与资源枚举](https://pyvisa.readthedocs.io/en/latest/introduction/communication.html)、[后端配置](https://pyvisa.readthedocs.io/en/latest/introduction/configuring.html)。仪器专用参数沿用用户提供的两份驱动。
