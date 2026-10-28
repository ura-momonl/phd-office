#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local 6221 panel. Reuses the verified driver, without modifying it."""
import argparse
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import pyvisa
from Keithley6221 import Keithley6221


def number(text, name, low, high):
    try:
        value = float(text)
    except (ValueError, TypeError):
        raise ValueError(f"{name}必须是数字。") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name}必须在 {low:g} ～ {high:g} 之间。")
    return value


def settings(dc, amplitude, offset, frequency, compliance, limit):
    """Displayed currents are µA; driver inputs are A. Peak, never RMS."""
    cap = number(limit, "本次最大 |I| (µA)", 0.000001, 105000) * 1e-6
    values = dict(dc=number(dc, "DC (µA)", -105000, 105000) * 1e-6,
                  amplitude=number(amplitude, "AC 峰值 (µA)", 0.000001, 105000) * 1e-6,
                  offset=number(offset, "AC 偏置 (µA)", -105000, 105000) * 1e-6,
                  frequency=number(frequency, "频率 (Hz)", 0.001, 100000),
                  compliance=number(compliance, "Compliance (V)", 0.1, 105), limit=cap)
    return values


class Controller:
    """Single worker owns this session. Connection is read-only, unlike connect()."""
    def __init__(self, library="@ivi"):
        self.library = library if library.endswith("@ivi") else library + "@ivi"
        self.driver = None
        self.output = None
        self.mode = None
        self.idn = ""

    def resources(self):
        rm = pyvisa.ResourceManager(self.library)
        try:
            return tuple(rm.list_resources("?*"))
        finally:
            rm.close()

    def connect(self, address):
        if self.driver:
            raise RuntimeError("请先停止并断开当前会话。")
        if not address.strip():
            raise ValueError("请输入 VISA 地址。")
        d = Keithley6221(address.strip())
        self.driver = d
        try:
            # Reuse driver I/O; explicitly choose the installed IVI backend.
            # Do not call connect(): it resets before checking device identity.
            d._rm = pyvisa.ResourceManager(self.library)
            d._inst = d._rm.open_resource(d.resource)
            d._inst.timeout = d.TIMEOUT_MS
            d._inst.read_termination = d.TERMINATOR
            d._inst.write_termination = d.TERMINATOR
            identity = d.idn()
            fields = identity.upper().split(",")
            if len(fields) < 2 or "KEITHLEY" not in fields[0] or fields[1].strip() not in ("6221", "MODEL 6221"):
                raise RuntimeError(f"不是 Keithley 6221，拒绝设置：{identity}")
            self.idn = identity
            self.refresh()
            return f"{identity}\nVISA 库：{d._rm.visalib}；连接没有复位或改变输出。"
        except Exception:
            self.release()
            raise

    def require(self):
        if self.driver is None:
            raise RuntimeError("尚未连接 6221。")
        return self.driver

    def refresh(self):
        self.output = None
        state = self.require()._query("OUTP?").upper()
        if state not in ("0", "1", "OFF", "ON"):
            raise RuntimeError(f"无法解析 OUTP?：{state!r}")
        self.output = state in ("1", "ON")
        if not self.output:
            self.mode = None
        return "输出回读：" + ("ON（请核对仪器面板）" if self.output else "OFF")

    def error(self):
        return self.require()._query("SYST:ERR?")

    def check_error(self):
        error = self.error()
        try:
            code = int(error.split(",", 1)[0])
        except ValueError:
            raise RuntimeError(f"无法解析错误队列：{error!r}") from None
        if code:
            raise RuntimeError(f"仪器错误：{error}；每次读取只取一项，没有自动清空。")

    def run(self, mode, p):
        d = self.require()
        if mode not in ("dc", "ac", "update"):
            raise ValueError("未知操作。")
        if mode == "dc" and abs(p["dc"]) > p["limit"] + 1e-15:
            raise ValueError("DC 超过本次最大 |I|。")
        if mode != "dc" and p["amplitude"] + abs(p["offset"]) > p["limit"] + 1e-15:
            raise ValueError("AC 峰值 + |偏置| 超过本次最大 |I|。")
        if mode == "update" and (self.mode != "ac" or self.output is not True):
            raise RuntimeError("只能在本窗口已开启的 AC 输出中更新幅度/偏置。")
        self.check_error()  # Pre-existing errors must not be mistaken for success.
        try:
            if mode == "dc":
                # Original method explicitly enables real output.
                d.set_dc_current(p["dc"], p["compliance"])
            elif mode == "ac":
                # Switch modes only with output OFF; original sine configuration retained.
                d.output_off()
                # Self-start the 6221; its Phase Marker still feeds the external-reference lock-in.
                # Change trigger mode only after ABOR, before configure_sine/ARM/INIT.
                d._write("SOUR:WAVE:EXTR OFF")
                d._write(f'CURR:COMP {p["compliance"]:g}')
                d.configure_sine(p["frequency"], p["amplitude"], p["offset"])
                d.start()
            else:
                d.update_sine(p["amplitude"], p["offset"])
            self.check_error()
            self.refresh()
            if not self.output:
                raise RuntimeError("已发送开启命令，但 OUTP? 回读 OFF。")
            self.mode = "dc" if mode == "dc" else "ac"
        except Exception as exc:
            try:
                stopped = self.stop()
            except Exception as stop_error:
                stopped = f"停止未确认：{stop_error}；立即检查仪器面板！"
            raise RuntimeError(f"操作失败：{exc}\n{stopped}") from exc
        return "命令完成；" + ("DC" if mode == "dc" else "正弦 AC") + " 输出回读 ON。设定值不是实测电流。"

    def stop(self):
        d = self.require()
        self.output, self.mode = None, None
        errors = []
        try:
            d.stop()
        except Exception as exc:
            errors.append(f"ABOR: {exc}")
        # Must still send OFF if waveform abort failed (driver.output_off would stop early).
        try:
            d._write("OUTP OFF")
        except Exception as exc:
            errors.append(f"OUTP OFF: {exc}")
        try:
            self.refresh()
        except Exception as exc:
            errors.append(str(exc))
        if self.output is not False:
            raise RuntimeError("关闭输出未确认；" + "; ".join(errors) + "。请使用仪器面板停止。")
        return "输出回读 OFF。" + (" 通信警告：" + "; ".join(errors) if errors else "")

    def release(self):
        """Close both resources even if the first close fails. No output commands."""
        d, self.driver = self.driver, None
        self.output, self.mode, self.idn = None, None, ""
        errors = []
        if d:
            for obj in (d._inst, d._rm):
                if obj:
                    try:
                        obj.close()
                    except Exception as exc:
                        errors.append(str(exc))
        if errors:
            raise RuntimeError("会话关闭异常：" + "; ".join(errors))

    def disconnect(self):
        result = self.stop()
        self.release()
        return result + " 已断开会话。"


class App:
    def __init__(self, root, library="@ivi"):
        self.root, self.client = root, Controller(library)
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="6221-visa")
        self.pending, self.stop_requested, self.exit_requested = None, False, False
        self.buttons, self.fields = {}, {}
        root.title("Keithley 6221 · 电流源控制")
        root.geometry("920x740")
        root.minsize(870, 710)
        root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("TFrame", background="#f3f7f5")
        style.configure("TLabel", background="#f3f7f5", font=("Microsoft YaHei UI", 10))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=6)
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 19, "bold"), foreground="#087f65")
        f = ttk.Frame(root, padding=18)
        f.pack(fill="both", expand=True)
        f.columnconfigure(0, weight=1)
        f.rowconfigure(7, weight=1)
        ttk.Label(f, text="KEITHLEY 6221", style="Title.TLabel").grid(row=0, sticky="w")
        ttk.Label(f, text="DC / 正弦 AC    ·    原实测驱动    ·    不自动复位、不自动开启输出").grid(row=1, sticky="w", pady=(0, 10))
        link = ttk.LabelFrame(f, text="01  连接", padding=10)
        link.grid(row=2, sticky="ew")
        link.columnconfigure(1, weight=1)
        ttk.Label(link, text="VISA 地址").grid(row=0, column=0, padx=(0, 8))
        self.address = ttk.Combobox(link, width=32)
        self.address.set("GPIB0::12::INSTR")
        self.address.grid(row=0, column=1, sticky="ew")
        self.button(link, "scan", "刷新资源", self.scan, 0, 2)
        self.button(link, "connect", "连接（只读）", self.connect, 0, 3)
        self.button(link, "disconnect", "关输出并断开", self.disconnect, 0, 4)
        self.connection = tk.StringVar(value="未连接 · 地址以测量电脑为准；不要与测量程序同时占用。")
        ttk.Label(link, textvariable=self.connection, wraplength=815).grid(row=1, column=0, columnspan=5, sticky="w", pady=(8, 0))
        safety = ttk.LabelFrame(f, text="02  本次限制（不是样品安全保证）", padding=10)
        safety.grid(row=3, sticky="ew", pady=10)
        self.entry(safety, "limit", "最大 |I| (µA)", "1000", 0, 0)
        self.entry(safety, "compliance", "Compliance (V)", "1", 0, 2)
        ttk.Label(safety, text="先按样品核对限流、电压与功率。AC 用峰值，不是 RMS。", wraplength=790).grid(row=1, column=0, columnspan=4, sticky="w", pady=(7, 0))
        tabs = ttk.Notebook(f)
        tabs.grid(row=4, sticky="ew")
        dc, ac = ttk.Frame(tabs, padding=12), ttk.Frame(tabs, padding=12)
        tabs.add(dc, text="  DC 直流  ")
        tabs.add(ac, text="  AC 正弦  ")
        self.entry(dc, "dc", "DC 电流 (µA)", "0", 0, 0)
        self.button(dc, "dc", "设置并开启 DC…", lambda: self.output_action("dc"), 0, 2)
        ttk.Label(dc, text="允许正负电流；执行会停止原波形并开启输出。", wraplength=780).grid(row=1, column=0, columnspan=4, sticky="w", pady=10)
        self.entry(ac, "amplitude", "幅度 Ipk (µA)", "1", 0, 0)
        self.entry(ac, "offset", "DC 偏置 (µA)", "0", 0, 2)
        self.entry(ac, "frequency", "频率 (Hz)", "13", 1, 0)
        self.button(ac, "ac", "配置并开启 AC…", lambda: self.output_action("ac"), 2, 0)
        self.button(ac, "update", "运行中更新幅度 / 偏置…", lambda: self.output_action("update"), 2, 2)
        ttk.Label(ac, text="6221 自启动（不等待外部触发）；同步脉冲 → Trigger Link Line 1。\n自动最佳量程；持续 999999 s；运行中更新不改频率/compliance。", wraplength=790).grid(row=3, column=0, columnspan=4, sticky="w", pady=(8, 0))
        state = ttk.Frame(f)
        state.grid(row=5, sticky="ew", pady=(12, 4))
        self.status = tk.StringVar(value="输出状态未知 · 未连接")
        ttk.Label(state, textvariable=self.status, font=("Microsoft YaHei UI", 11, "bold")).pack(side="left")
        self.buttons["stop"] = tk.Button(state, text="■  停止 / 关闭输出", command=self.stop, bg="#c53040", fg="white", font=("Microsoft YaHei UI", 11, "bold"), padx=12, pady=8)
        self.buttons["stop"].pack(side="right")
        ops = ttk.Frame(f)
        ops.grid(row=6, sticky="ew", pady=(0, 6))
        self.button(ops, "refresh", "回读输出状态", lambda: self.submit("回读", self.client.refresh), 0, 0)
        self.button(ops, "error", "读取一项仪器错误", lambda: self.submit("错误队列", self.client.error), 0, 1)
        ttk.Label(ops, text="通信期间停止需等当前命令结束；紧急情况请按仪器面板。", wraplength=510).grid(row=0, column=2, padx=8)
        self.log = scrolledtext.ScrolledText(f, height=7, state="disabled", font=("Consolas", 10), bg="#ffffff", relief="flat")
        self.log.grid(row=7, sticky="nsew")
        self.write("就绪。只刷新地址不会查询所有设备；没有后台仪器轮询。")
        self.sync()

    def button(self, frame, key, title, command, row, col):
        b = ttk.Button(frame, text=title, command=command)
        b.grid(row=row, column=col, padx=5, pady=3, sticky="w")
        self.buttons[key] = b

    def entry(self, frame, key, label, value, row, col):
        ttk.Label(frame, text=label).grid(row=row, column=col, sticky="w", padx=5, pady=5)
        v = tk.StringVar(value=value)
        self.fields[key] = v
        ttk.Entry(frame, textvariable=v, width=14).grid(row=row, column=col+1, sticky="w", padx=5, pady=5)

    def write(self, message):
        self.log.configure(state="normal")
        self.log.insert("end", datetime.now().strftime("%H:%M:%S") + "  " + str(message) + "\n")
        if int(self.log.index("end-1c").split(".")[0]) > 1000:
            self.log.delete("1.0", "100.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def sync(self):
        connected, busy = self.client.driver is not None, self.pending is not None
        for key, button in self.buttons.items():
            enabled = not busy and not self.exit_requested
            if key in ("scan", "connect"):
                enabled &= not connected
            else:
                enabled &= connected
            if key == "update":
                enabled &= self.client.mode == "ac" and self.client.output is True
            if key == "stop":
                enabled = connected and not self.stop_requested
            button.configure(state="normal" if enabled else "disabled")
        self.address.configure(state="disabled" if connected or busy else "normal")
        if not busy:
            output = self.client.output
            self.status.set("输出回读 OFF" if output is False else "输出回读 ON" if output is True else "输出状态未知 · 请核对仪器")
            self.connection.set(self.client.idn or "未连接 · 地址以测量电脑为准；不要与测量程序同时占用。")

    def submit(self, name, function, callback=None):
        if self.pending:
            return
        self.write(name + "…")
        self.status.set("正在" + name + " · 请勿用其他程序占用仪器")
        self.pending = self.worker.submit(function)
        self.sync()
        self.root.after(60, lambda: self.poll(callback))

    def poll(self, callback):
        if not self.pending.done():
            self.root.after(60, lambda: self.poll(callback))
            return
        succeeded = False
        try:
            result = self.pending.result()
            self.write(result)
            succeeded = True
            if callback:
                callback(result)
        except Exception as exc:
            self.write("失败：" + str(exc))
            # No modal dialog here: a queued stop must not wait for a click.
        self.pending = None
        self.sync()
        if not succeeded:
            self.status.set("操作失败 · " + self.status.get() + " · 详情见日志")
        if self.stop_requested:
            self.stop_requested = False
            if self.client.driver:
                self.submit("停止输出", self.client.stop)
                return
        if self.exit_requested:
            if succeeded and self.client.driver is None:
                self.worker.shutdown(wait=False)
                self.root.destroy()
            elif not succeeded:
                self.exit_requested = False
                self.sync()
            else:
                self.submit("关闭输出并退出", self.client.disconnect)

    def scan(self):
        self.submit("枚举 VISA 地址", self.client.resources, lambda result: self.address.configure(values=result))

    def connect(self):
        address = self.address.get()
        self.submit("连接并确认身份", lambda: self.client.connect(address))

    def output_action(self, mode):
        try:
            p = settings(**{key: value.get() for key, value in self.fields.items()})
            if mode == "dc":
                if abs(p["dc"]) > p["limit"] + 1e-15:
                    raise ValueError("DC 超过本次最大 |I|。")
                detail = f'DC = {p["dc"]*1e6:g} µA；compliance = {p["compliance"]:g} V'
            else:
                if p["amplitude"] + abs(p["offset"]) > p["limit"] + 1e-15:
                    raise ValueError("AC 峰值 + |偏置| 超过本次最大 |I|。")
                detail = f'Ipk = {p["amplitude"]*1e6:g} µA；偏置 = {p["offset"]*1e6:g} µA'
                detail += ("\n只更新幅度/偏置，频率与 compliance 保持仪器现值。" if mode == "update" else f'\nf = {p["frequency"]:g} Hz；compliance = {p["compliance"]:g} V')
            if messagebox.askyesno("确认真实输出", f"地址：{self.client.driver.resource}\n{detail}\n\n会改变样品上的真实电流。已核对接线及样品限制？", parent=self.root):
                self.submit("更新 AC" if mode == "update" else "开启 " + mode.upper(), lambda: self.client.run(mode, p))
        except Exception as exc:
            messagebox.showerror("参数未接受", str(exc), parent=self.root)

    def stop(self):
        if self.pending:
            self.stop_requested = True
            self.write("已请求停止，等待当前 VISA 操作完成。紧急请使用仪器面板！")
            self.sync()
        else:
            self.submit("停止输出", self.client.stop)

    def disconnect(self):
        self.submit("关闭输出并断开", self.client.disconnect)

    def close(self):
        if self.exit_requested:
            return
        if not messagebox.askyesno("退出 6221 控制", "连接中会先关闭输出再断开。\n通信失败会保留窗口，不能保证输出已停。\n\n退出？", parent=self.root):
            return
        self.exit_requested = True
        if self.pending:
            self.sync()
        elif self.client.driver:
            self.submit("关闭输出并退出", self.client.disconnect)
        else:
            self.worker.shutdown(wait=False)
            self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visa-library", default="@ivi", help="Existing IVI VISA DLL path; no driver installation")
    args = parser.parse_args()
    root = tk.Tk()
    App(root, args.visa_library)
    root.mainloop()


if __name__ == "__main__":
    main()
