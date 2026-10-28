# 6221 控制前端验证 · 2026-10-13

## 做了什么

- 新增 `control_6221.py` 与 README；Tkinter + 现有 PyVISA / IVI。
- 通过图鉴的既有登记接口将控制窗口加入 Keithley 6221 卡片的 `code_paths` 和 `run_paths`。没有改图鉴启动器或测量程序。
- 连接只读；DC、正弦 AC、运行中幅度/偏置更新复用原驱动。新增确认、µA→A 转换、限流、错误检查、输出回读、失败时尝试停止。

## 验证了什么

正常授权运行 `node scripts/run-tests.mjs --instruments --keep`：**10/10 通过，退出码 0**。脱敏副本：`C:/Users/24193/AppData/Local/Temp/phd-tests-oP8mH0`，日志 `.runtime/test-results.log`。

该套件包含 `test_control_offline.py`，使用真实原驱动与真实 Tk 控件，替换 VISA ResourceManager 工厂，不连接仪器：
- 只读连接/型号拒绝、资源枚举不探测设备、LF、显式 IVI；
- DC 原指令与单位转换，AC 原持续时间/Phase Marker/量程，更新无 ABOR；
- 非数、无穷、负幅度、频率/compliance 边界与 DC/AC 电流上限；
- 仪器已有错误阻止开启；设置失败不重试而尝试 OFF；ABOR 失败仍发送 OFF；
- OFF 未确认保留会话；关闭仪器对象失败仍关闭 ResourceManager；
- GUI 刷新、连接、取消开启、开启 AC、更新、停止、通信中排队停止、退出。

实际 Tk 窗口截图 `instruments/programs/keithley-6221/control-panel-test.png` 已检查：AC 标签页各输入、停止按钮、状态和日志均可见。

真实卡片读回确认启动目标为 `instruments/programs/keithley-6221/control_6221.py`；注册读取和启动选择接口检查通过。

通过真实图鉴启动器打开正式控制前端，未连接仪器。正常授权的 `Get-Process -Id 32116` 核对主窗口标题为 `Keithley 6221 · 电流源控制`、`Responding=True`。默认 Windows/workspace-write 权限下桌面 `EnumWindows` 查询失败（Windows error=5，Access Denied）；未绕过，改走工具的正常授权只读核对。下次类似桌面窗口验证应请求正常授权，不能仅凭普通权限的空标题断定没有窗口。

原 `Keithley6221.py` 修改前后 SHA256 一致：`17c38ddf9b9e7e441b7e71d3103354a527f411553072c99659735aabd8c95e7f`。

## 没验证什么

没有连接真实 6221，没有真实输出、测量或采集数据。实际 GPIB 通信、设备当前错误队列、波形/电流准确度、compliance 的实际作用及样品安全仍需测量电脑实机验收。输出状态是按需查询，不代表其他程序/面板之后没有改动。

## 2026-10-13 增量：关闭 6221 外部等待启动

- 用户明确批准增加这一项。只在 `control_6221.py` 的重新配置开启 AC 路径新增 `SOUR:WAVE:EXTR OFF`，位于关闭输出/ABOR 之后、原驱动 `configure_sine()` 和 ARM/INIT 之前。依据官方参考手册 §7-31，不改变原 Phase Marker Line 1 指令、不修改锁相 External。
- 原 `Keithley6221.py` 当时正开在 VS Code；为保留可能的未保存编辑，没有修改、保存或重载该编辑器文件。原驱动磁盘 SHA256 仍为上述值。
- AC 窗口说明增加“6221 自启动（不等待外部触发）”；README 说明新增行为与旧窗口重启要求。连接、DC、运行中调幅没有新增此指令。
- 正常授权 `node scripts/run-tests.mjs --instruments --keep`：**10/10 通过，退出码 0**。脱敏副本 `C:/Users/24193/AppData/Local/Temp/phd-tests-30sAAE`，结果 `.runtime/test-results.log`。Python 控制测试增加初始外触发已开启的模拟状态，核对 OFF 在 ABOR 后、Phase Marker/ARM 前；确认同步原指令保持、运行中更新不重置触发；新增指令通信失败不 ARM/INIT、不重试并尝试 OFF。真实 Tk 控件路径通过。
- 未连接真实仪器、未开启真实输出；未认定用户当前故障确由外部等待启动造成。尚需测量电脑重新启动前端并进行实机验收。没有自动关闭用户旧窗口、自动切换真实仪器模式或自动重新开启输出。
