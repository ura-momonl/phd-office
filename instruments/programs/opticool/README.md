# OptiCool 系统与固定配套

2026-10-15：按用户本轮初步确认，暂将以下配套归入同一张「OptiCool 系统」仪器卡；这不是已核实的现场资产清单，归属可后续调整。锁相放大器和 Keithley 源表保留原独立卡片，不纳入本组。

本目录从 `D:/Main/instruments/` 原样收录控制文件，不合并、不重写驱动。图鉴提供源码查看、复制和下载，不配置运行按钮，也不自动连接设备。

| 配套 | 文件／类 | 代码可确认的功能与连接 |
| --- | --- | --- |
| OptiCool 主机 | `QDopticool.py`／`Opticool` | MultiPyVu 客户端；当前主机地址为 **`192.168.50.1`**（用户 2026-10-15 更正）。原驱动仍保留旧默认 `169.254.170.239`，调用时必须显式传入当前 host；端口 `5000` 仅为原代码值，未另行核实。先在主机电脑运行 `python -m MultiPyVu`。构造时立即连接。 |
| Andor 相机＋Shamrock 光谱仪 | `AndorCameraSpectrometer.py`／`AndorCamSpec` | pyAndorSDK2、pylablib、NumPy、tqdm；代码指定 Andor SDK 与 Shamrock64 安装路径，提供光谱仪配置、图像采集与 Raman shift 换算。未由代码确认具体相机型号。 |
| Hamamatsu H11890 PMT | `H11890PMT.py`／`HamamatsuH11890` | Windows ctypes DLL 接口；默认设备索引 0，提供高压、门时间、重复次数与计数读写。 |
| Thorlabs K-Cube 旋转架 | `ThorlabsKCube.py`／`RotationMount` | pylablib `Thorlabs.KinesisMotor`；序列号由调用者传入；旋转位置读写、相对移动、回零和等待停止。 |
| Lake Shore 336：nanopositioner 温度读取 | `LakeShore336Temperature.py`／`LakeShore336Temperature` | 用户 2026-10-15 明确其用途是读取 nanopositioner 的温度。PyVISA；默认 `GPIB0::11::INSTR`、输入 B、超时 2000 ms；`connect()` 查询 `*IDN?`，`read_temperature_k()` 用 `KRDG?` 只读开尔文温度。此文件不控制加热器，也不控制位移。 |

## Nanopositioner 位移控制：当前缺项

2026-10-15 检查 `D:/Main/instruments/` 的控制代码：未找到可识别的 nanopositioner 位移／轴控制驱动。本卡已收录的 Lake Shore 接口只有温度读取，不能据此认定已有 nanopositioner 控制。

`ThorlabsKCube.py` 的文件头虽提到 linear stage，但实际实现为 `RotationMount`，按角度及 `1919.59 steps/deg` 换算；不能把它当作已确认的 nanopositioner 控制接口。控制器型号与实际控制代码位置尚待补充，不据此新增驱动或设备控制功能。

## OptiCool 主机自身的温度与磁场

这两项属于 `QDopticool.py` 的主机接口，不由 Lake Shore 336 配套驱动代替。`Opticool` 继承 `MultiPyVu.Client`，未重写父类的温度和磁场方法。

根据 [MultiPyVu 发布者文档](https://pypi.org/project/MultiPyVu/)（2026-10-15 查阅）：温度通过 `get_temperature()`／`set_temperature(...)` 读取／设置；磁场通过 `get_field()`／`set_field(...)` 读取／设置。设置还涉及速率与接近模式，实际调用须以测量电脑安装版本及主机配置为准；不在此提供会改变真实设定值的示例。

以上只据继承关系和发布者接口说明，未在本机导入或连接实机验证。图鉴仍只是资料入口，没有温度／磁场控制面板。

## 运行前必须知道

- **OptiCool**：文件没有温度／磁场恢复、归零或停机命令；断开通信不等于系统进入安全状态。显式调用 `close()`，不要依赖析构中的 `disconnect()`；父类具体读写接口、范围和单位未在本文件展开。
- **Andor**：构造函数会开启制冷、设置温度（默认 −85 °C）、采集模式、光栅和中心波长，并循环等待温度降至代码固定阈值 −79 °C，无超时。`close()` 会关制冷并等待回温至 −20 °C 后再关 SDK，同样无超时。上述温度是代码设定值／等待阈值，不是本次认定的安全操作规程或设备指标。
- **PMT**：`quick_test()` 和文件的主程序会开高压；高压开启到关闭之间没有 `try/finally`，异常时不能依赖该路径保证关高压。`close()` 包含检查和关闭高压，但通信异常仍需人工确认。初始化会捕获异常并打印提示，未抛出失败不代表连接成功。代码中关于 Zadig 的提示不等于本次建议更换设备驱动。
- **PMT DLL**：`H11890api.dll` 也原样保存在本目录，但原 Python 文件将路径硬编码为 `C:/Users/Public/OneDrive/Documents/quantummaterials/python_instrument_control/homemade_servers/`。同目录存在 DLL 不代表原脚本就能加载它；本次不改路径、不加载 DLL。图鉴不支持直接展示或下载 DLL，可在本地目录取用。
- **旋转架**：原驱动固定换算系数 `1919.59 steps/deg`；不要视为所有旋转台的通用标定。移动、回零会带来真实机械动作，原文件未设置软件角度限位。`close()` 仅调用底层关闭接口，没有显式停止运动命令。
- **Lake Shore**：原文件注释声称已在实验电脑验证型号字符串；这是原文件作者的记录，不是本轮实测。默认地址与输入通道仍以实际接线为准。

`ThorCam.txt` 为空，未据此建立相机功能或接口；`rotationTest.py` 是会实际扫角的测试脚本，未纳入本次仪器卡驱动集合。

