# -*- coding: utf-8 -*-
"""
Keithley 6221 driver copied from the user's successfully-run instruments.py.

Only one intentional change is made:
    SOUR:WAVE:DUR:TIME INF -> SOUR:WAVE:DUR:TIME 999999

That change is retained because INF caused a real instrument problem in this
setup. The rest of the waveform/phase-marker/range/start/update/stop logic is
kept from the successful code.
"""

from __future__ import annotations

import pyvisa


class Keithley6221:
    """
    用内置波形发生器输出正弦交流电流。涉及的 SCPI:
        SOUR:WAVE:FUNC SIN     选正弦
        SOUR:WAVE:FREQ <Hz>    设频率
        SOUR:WAVE:AMPL <A峰值> 设幅度
        SOUR:WAVE:OFFS <A>     设直流偏置
        SOUR:WAVE:RANG BEST    自动选最佳量程
        SOUR:WAVE:ARM          武装波形
        SOUR:WAVE:INIT         输出 ON,开始出正弦
        SOUR:WAVE:ABOR         停止/解除武装
    """

    # --- 连接参数(GPIB:换行符作结束符) --- #
    TIMEOUT_MS = 10000
    TERMINATOR = "\n"

    # --- 通信底座 --------------------------------------------------------- #
    def __init__(self, resource: str):
        # ▸ 存仪器地址,初始化状态变量(此时还没连)
        self.resource = resource
        self._rm = None
        self._inst = None
        self._armed = False
        self._running = False
        self.frequency = 13.0      # Hz
        self.amplitude = 1e-6      # A(峰值)

    def connect(self):
        """打开端口并复位仪器,返回 *IDN? 识别串。"""
        self._open()
        self._write("*RST")
        self._write("*CLS")
        return self.idn()

    def _open(self):
        """打开 GPIB 资源并设置结束符。"""
        self._rm = pyvisa.ResourceManager()
        self._inst = self._rm.open_resource(self.resource)
        self._inst.timeout = self.TIMEOUT_MS
        self._inst.write_termination = self.TERMINATOR
        self._inst.read_termination = self.TERMINATOR

    def _write(self, cmd: str):
        # ▸ 发一条命令(不读回)
        self._inst.write(cmd)

    def _query(self, cmd: str) -> str:
        # ▸ 发一条命令并读回一行
        return self._inst.query(cmd).strip()

    def _close(self):
        # ▸ 关闭 VISA 会话
        try:
            if self._inst is not None:
                self._inst.close()
            if self._rm is not None:
                self._rm.close()
        except Exception:
            pass

    def idn(self) -> str:
        # ▸ 查身份串 *IDN?
        return self._query("*IDN?")

    def shutdown(self):
        # ▸ 收尾:停波形+关输出+断开
        self.stop()
        self.output_off()
        self._close()

# --- 仪器动作:交流正弦配置(核心) --------------------------------- #
    def configure_sine(self, frequency_hz: float, amplitude_a: float,
                       offset_a: float = 0.0, range_a: float = None):
        """
        【首次配置】设置正弦的频率与幅度，并配置 Trigger Link 输出同步脉冲。
        """
        self.frequency = float(frequency_hz)
        self.amplitude = float(amplitude_a)
        self._write("SOUR:WAVE:ABOR")                       
        self._write("SOUR:WAVE:FUNC SIN")
        self._write(f"SOUR:WAVE:FREQ {frequency_hz:g}")
        self._write(f"SOUR:WAVE:AMPL {amplitude_a:g}")
        self._write(f"SOUR:WAVE:OFFS {offset_a:g}")
        self._write("SOUR:WAVE:DUR:TIME 999999")               
        # 配置 Trigger Link 输出同步脉冲给锁相
        self._write("SOUR:WAVE:PMAR:STAT ON")   # 开启 Phase Marker
        self._write("SOUR:WAVE:PMAR:OLIN 1")    # 从 Trigger Link 的 Line 1 引出 (多数转接线默认走这根)

        if range_a is not None:
            self._write(f"SOUR:CURR:RANG {abs(range_a):g}")
            self._write("SOUR:WAVE:RANG FIX")
        else:
            self._write("SOUR:WAVE:RANG BEST")

    def update_sine(self, amplitude_a: float, offset_a: float = None):
        """
        【运行中调整】在不断开输出(不发 ABOR)的情况下动态调整幅度与偏置。
        6221 允许在波形运行时直接改 AMPL 和 OFFS，避免锁相放大器丢锁。
        """
        self.amplitude = float(amplitude_a)
        self._write(f"SOUR:WAVE:AMPL {amplitude_a:g}")
        if offset_a is not None:
            self._write(f"SOUR:WAVE:OFFS {offset_a:g}")

    def start(self):
        """武装并开始连续正弦输出。"""
        self._write("SOUR:WAVE:ARM")
        self._write("SOUR:WAVE:INIT")
        self._armed = True
        self._running = True

    def stop(self):
        """停止波形输出。"""
        self._write("SOUR:WAVE:ABOR")
        self._running = False
        self._armed = False

    # --- 仪器动作:直流输出(默认交流流程【不用】,保留作扩展积木) ----- #
    def set_dc_current(self, current_a: float, compliance_v: float = 10.0):
        """
        输出一个恒定直流电流。【默认的交流测量不会调用它】。
        保留它是为了方便你以后加 DC 类的功能(比如 DC I-V、delta 法等)。
        """
        self.amplitude = abs(current_a)
        self._write("SOUR:WAVE:ABOR")
        self._write("CURR:COMP {:g}".format(compliance_v))
        self._write(f"SOUR:CURR {current_a:g}")
        self._write("OUTP ON")
        self._running = True

    def output_off(self):
        """关闭输出。"""
        self._write("SOUR:WAVE:ABOR")
        self._write("OUTP OFF")
        self._running = False


