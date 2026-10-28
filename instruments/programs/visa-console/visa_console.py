#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Small Tk/PyVISA console using the existing IVI/NI-VISA installation."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import pyvisa

TERMINATIONS = {"LF (\\n)": "\n", "CR (\\r)": "\r", "CRLF (\\r\\n)": "\r\n", "None": None}


class VisaClient:
    """One session; all VISA calls execute serially on the GUI's one worker."""
    def __init__(self, library="@ivi"):
        # Explicit IVI: never silently fall back to pyvisa-py.
        self.library = library if library.endswith("@ivi") else library + "@ivi"
        self.rm = self.instrument = None

    def manager(self):
        if self.rm is None:
            self.rm = pyvisa.ResourceManager(self.library)
        return self.rm

    def scan(self):
        rm = self.manager()
        return tuple(rm.list_resources("?*")), str(rm.visalib)

    def connect(self, address, timeout_ms, baud, read_end, write_end):
        if not address.strip():
            raise ValueError("请选择或输入 VISA 地址。")
        if not 1 <= timeout_ms <= 60000 or baud <= 0:
            raise ValueError("超时应为 1–60000 ms，波特率必须大于 0。")
        self.disconnect()
        instrument = self.manager().open_resource(address.strip(), open_timeout=timeout_ms)
        try:
            instrument.timeout = timeout_ms
            instrument.read_termination = TERMINATIONS[read_end]
            instrument.write_termination = TERMINATIONS[write_end]
            if instrument.interface_type == pyvisa.constants.InterfaceType.asrl:
                instrument.baud_rate = baud
        except Exception:
            instrument.close()
            raise
        self.instrument = instrument
        return f"已连接 {instrument.resource_name}；timeout={timeout_ms} ms；读结束符={read_end}；写结束符={write_end}"

    def communicate(self, mode, command):
        if self.instrument is None:
            raise RuntimeError("尚未连接仪器。")
        if mode != "read" and not command.strip():
            raise ValueError("请输入命令。")
        if mode == "query":
            return f"RX: {self.instrument.query(command)!r}"
        if mode == "write":
            return f"已发送 {self.instrument.write(command)} bytes（没有读取响应）"
        if mode == "read":
            return f"RX: {self.instrument.read()!r}"
        raise ValueError("Unknown operation")

    def disconnect(self):
        if self.instrument is not None:
            self.instrument.close()
            self.instrument = None
        return "已断开会话（未改变仪器输出）"

    def close(self):
        errors = []
        for label, resource in (("instrument", self.instrument), ("ResourceManager", self.rm)):
            if resource is not None:
                try:
                    resource.close()
                except Exception as exc:
                    errors.append(f"{label}: {exc}")
        self.instrument = self.rm = None
        if errors:
            raise RuntimeError("; ".join(errors))


class App:
    def __init__(self, root, library="@ivi"):
        self.root, self.client = root, VisaClient(library)
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="visa")
        self.pending = None
        self.closing = False
        self.action = ""
        self.buttons = {}
        root.title("VISA Lite — PyVISA / existing NI-VISA")
        root.geometry("880x580")
        root.minsize(760, 500)
        root.protocol("WM_DELETE_WINDOW", self.close)

        frame = ttk.Frame(root, padding=12)
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(1, weight=1)
        frame.rowconfigure(5, weight=1)
        ttk.Label(frame, text="VISA 地址").grid(row=0, column=0, sticky="w")
        self.address = ttk.Combobox(frame, width=44)  # editable for manual TCPIP/alias addresses
        self.address.grid(row=0, column=1, sticky="ew", padx=8)
        controls = ttk.Frame(frame)
        controls.grid(row=0, column=2)
        self.button(controls, "refresh", "刷新资源", self.refresh).pack(side="left", padx=2)
        self.button(controls, "connect", "连接 / 应用", self.connect).pack(side="left", padx=2)
        self.button(controls, "disconnect", "断开", lambda: self.submit("disconnect", self.client.disconnect)).pack(side="left", padx=2)

        settings = ttk.Frame(frame)
        settings.grid(row=1, column=0, columnspan=3, sticky="w", pady=12)
        self.timeout = tk.StringVar(root, "2000")
        self.baud = tk.StringVar(root, "9600")
        self.read_end = tk.StringVar(root, "LF (\\n)")
        self.write_end = tk.StringVar(root, "LF (\\n)")
        for label, variable, width, choices in (
            ("超时 ms", self.timeout, 7, None), ("波特率", self.baud, 8, None),
            ("读结束符", self.read_end, 13, tuple(TERMINATIONS)),
            ("写结束符", self.write_end, 13, tuple(TERMINATIONS)),
        ):
            ttk.Label(settings, text=label).pack(side="left", padx=(0, 4))
            widget = ttk.Entry(settings, textvariable=variable, width=width) if choices is None else \
                ttk.Combobox(settings, textvariable=variable, values=choices, state="readonly", width=width)
            widget.pack(side="left", padx=(0, 12))

        ttk.Label(frame, text="命令").grid(row=2, column=0, sticky="w")
        self.command = ttk.Entry(frame)
        self.command.insert(0, "*IDN?")
        self.command.grid(row=2, column=1, sticky="ew", padx=8)
        operations = ttk.Frame(frame)
        operations.grid(row=2, column=2)
        for mode, text in (("query", "查询 ↔"), ("write", "发送 →"), ("read", "读取 ←")):
            self.button(operations, mode, text, lambda m=mode: self.communicate(m)).pack(side="left", padx=2)

        ttk.Label(frame, text="OE1022D：9600 / 读写 CR / *IDND?　　Keithley 6221：读写 LF / *IDN?").grid(
            row=3, column=0, columnspan=3, sticky="w", pady=(12, 3))
        ttk.Label(frame, text="改通信参数后点“连接 / 应用”。发送只执行一次，不自动重试；退出仅断开，不关闭仪器输出。").grid(
            row=4, column=0, columnspan=3, sticky="w", pady=(0, 10))
        self.log = scrolledtext.ScrolledText(frame, wrap="word", font=("Consolas", 10), state="disabled")
        self.log.grid(row=5, column=0, columnspan=3, sticky="nsew")
        self.status = tk.StringVar(root, "就绪：先刷新资源，再连接。")
        ttk.Label(frame, textvariable=self.status).grid(row=6, column=0, columnspan=3, sticky="w", pady=(8, 0))
        self.append("使用已有 IVI VISA 库；不安装/修改 NI-VISA，不自动识别、复位或配置仪器。")
        self.append("刷新列出 VISA 资源；串口资源不一定已连接仪器。查询 = 发送命令后读取响应。")
        root.after(80, self.poll)

    def button(self, parent, key, text, command):
        widget = ttk.Button(parent, text=text, command=command)
        self.buttons[key] = widget
        return widget

    def append(self, message):
        self.log.configure(state="normal")
        self.log.insert("end", datetime.now().strftime("[%H:%M:%S] ") + str(message) + "\n")
        # Bound display memory; no persistent log or instrument-data files.
        if int(self.log.index("end-1c").split(".")[0]) > 2000:
            self.log.delete("1.0", "200.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def submit(self, action, function):
        if self.closing or self.pending is not None:
            return
        self.action = action
        self.status.set("操作中…（界面保持响应；不自动重试）")
        for button in self.buttons.values():
            button.configure(state="disabled")
        self.pending = self.worker.submit(function)

    def refresh(self):
        self.submit("scan", self.client.scan)

    def connect(self):
        try:
            args = (self.address.get(), int(self.timeout.get()), int(self.baud.get()),
                    self.read_end.get(), self.write_end.get())
        except ValueError:
            self.append("ERROR: 超时和波特率必须是整数。")
            return
        self.submit("connect", lambda: self.client.connect(*args))

    def communicate(self, mode):
        if self.closing or self.pending is not None:
            return
        command = self.command.get()
        self.append(f"{mode.upper()}: {command!r}" if mode != "read" else "READ: 等待仪器响应")
        self.submit(mode, lambda: self.client.communicate(mode, command))

    def poll(self):
        if self.pending is not None and self.pending.done():
            try:
                result = self.pending.result()
                if self.action == "scan":
                    resources, backend = result
                    self.address.configure(values=resources)
                    if resources and not self.address.get():
                        self.address.set(resources[0])
                    self.append(f"VISA 库：{backend}\n资源（{len(resources)}）：{resources!r}")
                elif result is not None:
                    self.append(result)
                self.status.set("就绪")
            except Exception as exc:
                self.append(f"ERROR: {exc}（本次操作不重试）")
                self.status.set("操作失败；检查地址、结束符、命令和超时。")
                if self.closing:
                    messagebox.showerror("VISA 会话关闭失败", str(exc), parent=self.root)
            self.pending = None
            if self.closing:
                self.worker.shutdown(wait=False)
                self.root.destroy()
                return
            for button in self.buttons.values():
                button.configure(state="normal")
        self.root.after(80, self.poll)

    def close(self):
        if self.closing:
            return
        self.closing = True
        self.status.set("正在关闭会话；等待当前通信结束…")
        for button in self.buttons.values():
            button.configure(state="disabled")
        # Same worker: never close VISA while another call is still in flight.
        self.action = "close"
        self.pending = self.worker.submit(self.client.close)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visa-library", default="@ivi",
                        help="existing NI/IVI VISA DLL path; no installation or config edits")
    args = parser.parse_args()
    root = tk.Tk()
    App(root, args.visa_library)
    root.mainloop()


if __name__ == "__main__":
    main()
