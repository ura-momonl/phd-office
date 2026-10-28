#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OE1022D live reader (harmonic 1 + harmonic 2 of one channel) and control panel.

Connecting and reading never change the instrument: *IDND? once, SNAPD? <ch>,7,8,11,12
(Rh1, theta h1, Rh2, theta h2: the two harmonic slots of one channel, read at the same instant)
while reading, and read-back queries of the settings. Only the buttons/boxes in
the settings panel write to the instrument, and every write is followed by a
read-back of that setting. Disconnecting only closes the serial session.

Command spellings and index tables follow SSI_OE1022D_modified.py (the verified
driver, which always wins); only items the driver lacks use the vendor manual.
This file does not import the driver (its constructor writes Ch2 harmonic).
Needs only tkinter, numpy and pyvisa (IVI / NI-VISA).
"""
import argparse
import bisect
import csv
import math
import queue
import threading
import time
from datetime import datetime, timedelta
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

import numpy as np
import pyvisa

ADDRESS = "ASRL4::INSTR"
MAX_SAMPLES = 500_000
AUTO_TIMEOUT_MS = 30_000  # auto gain/phase can keep the instrument busy for a while
STAT_POINTS = {"20 点": 20, "50 点": 50, "200 点": 200, "全部": None}
SNAP_PARAMS = "7,8,11,12"  # Rh1, thetah1, Rh2, thetah2 (driver parameter list indices)
FONT = "Microsoft YaHei UI"
BG, CARD, INK, MUTED = "#f6f3ee", "#fffdf9", "#2f2f33", "#7a746b"
R_COLOR, P_COLOR, RED = "#1f7a6b", "#c4622d", "#b3362f"

# Index tables copied from SSI_OE1022D_modified.py (0-based). The vendor manual numbers the
# time constants from 1 (11 = 1 s); the driver, and the user's measurement on this unit
# (index 11 was 3 s), follow this 0-based table, so the driver table is used.
SENSITIVITIES = [
    "1 nV", "2 nV", "5 nV", "10 nV", "20 nV", "50 nV", "100 nV", "200 nV", "500 nV",
    "1 uV", "2 uV", "5 uV", "10 uV", "20 uV", "50 uV", "100 uV", "200 uV", "500 uV",
    "1 mV", "2 mV", "5 mV", "10 mV", "20 mV", "50 mV", "100 mV", "200 mV", "500 mV", "1 V",
]
TIME_CONSTANTS = [
    "10 us", "30 us", "100 us", "300 us", "1 ms", "3 ms", "10 ms", "30 ms", "100 ms",
    "300 ms", "1 s", "3 s", "10 s", "30 s", "100 s", "300 s", "1000 s", "3000 s",
]

# kind "enum": index -> text. kind "num": float/int with a range. Commands: driver spelling
# (FMODD/FREQD/PHASD/SENSD/OFLTD/OFSLD/SYNCD/HARMD/SLVLD) are all set/get commands of the driver;
# the driver passes reference/slope/sync as raw numbers, their meanings come from the manual.
SPECS = {
    "ref": dict(label="参考来源", cmd="FMODD", kind="enum", options=[(0, "外部"), (1, "内部")], extra={2: "内部扫频"}),
    "freq": dict(label="参考频率 (Hz)", cmd="FREQD", kind="num", lo=0.001, hi=102000.0, tol=5e-4),
    "harm1": dict(label="谐波 1 次数", cmd="HARMD", kind="num", lo=1, hi=32767, tol=0.5, integer=True, slot=1),
    "harm2": dict(label="谐波 2 次数", cmd="HARMD", kind="num", lo=1, hi=32767, tol=0.5, integer=True, slot=2),
    "phase": dict(label="相位 (°)", cmd="PHASD", kind="num", lo=-180.0, hi=180.0, tol=0.0051),
    "sens": dict(label="灵敏度", cmd="SENSD", kind="enum", options=list(enumerate(SENSITIVITIES))),
    "tc": dict(label="时间常数", cmd="OFLTD", kind="enum", options=list(enumerate(TIME_CONSTANTS))),
    "slope": dict(label="滤波斜率", cmd="OFSLD", kind="enum",
                  options=[(0, "6 dB/oct"), (1, "12 dB/oct"), (2, "18 dB/oct"), (3, "24 dB/oct")]),
    "sync": dict(label="同步滤波", cmd="SYNCD", kind="enum", options=[(0, "关"), (1, "开")]),
    "amp": dict(label="SINE OUT (Vrms)", cmd="SLVLD", kind="num", lo=0.0, hi=5.0, tol=5e-4),
}
ORDER = ("ref", "freq", "harm1", "harm2", "phase", "sens", "tc", "slope", "sync", "amp")
ALSO_READ = {"ref": ("freq",), "freq": ("harm1", "harm2")}  # settings the instrument may change as a side effect
AUTO = {"phase": ("APHSD", "自动相位"), "gain": ("AGAND", "自动增益")}


def clean(text):
    return str(text).replace("\x00", "").strip()


def query_command(key, channel):
    spec = SPECS[key]
    if "slot" in spec:
        return f"{spec['cmd']}? {channel},{spec['slot']}"
    return f"{spec['cmd']}? {channel}"


def write_command(key, channel, value):
    spec = SPECS[key]
    text = str(int(value)) if spec["kind"] == "enum" or spec.get("integer") else format(float(value), ".10g")
    if "slot" in spec:
        return f"{spec['cmd']} {channel},{spec['slot']},{text}"
    return f"{spec['cmd']} {channel},{text}"


def parse_setting(key, reply):
    value = float(clean(reply))
    spec = SPECS[key]
    return int(round(value)) if spec["kind"] == "enum" or spec.get("integer") else value


def enum_text(key, value):
    spec = SPECS[key]
    for index, text in spec["options"]:
        if index == value:
            return f"{text} [{index}]"
    return f"{spec.get('extra', {}).get(value, '未知')} [{value}]"


def setting_matches(key, wanted, got):
    spec = SPECS[key]
    return wanted == got if spec["kind"] == "enum" else abs(wanted - got) <= spec["tol"]


def volts(value, digits=4):
    """12.34 µV style text for an amplitude in volts."""
    if value is None or not math.isfinite(value):
        return "—"
    if value == 0:
        return "0 V"
    for scale, unit in ((1, "V"), (1e-3, "mV"), (1e-6, "µV"), (1e-9, "nV")):
        if abs(value) >= scale:
            break
    return f"{value / scale:.{digits}g} {unit}"


def window_stats(r, phi):
    """Mean/σ/min/max for R; circular mean/σ for phi (degrees), so ±180° wrap does not fake noise."""
    out = {"n": len(r)}
    if not len(r):
        return out
    out.update(r_mean=float(np.mean(r)), r_std=float(np.std(r, ddof=1)) if len(r) > 1 else 0.0,
               r_min=float(np.min(r)), r_max=float(np.max(r)))
    rad = np.radians(phi)
    mean = math.atan2(float(np.mean(np.sin(rad))), float(np.mean(np.cos(rad))))
    dev = (rad - mean + math.pi) % (2 * math.pi) - math.pi
    out.update(p_mean=math.degrees(mean),
               p_std=math.degrees(math.sqrt(float(np.sum(dev ** 2)) / (len(r) - 1))) if len(r) > 1 else 0.0,
               p_min=float(np.min(phi)), p_max=float(np.max(phi)))
    return out


class Reader(threading.Thread):
    """Owns the VISA session. Reads only while `go` is set; setting jobs run between reads.
    Any error stops everything and closes the session; nothing is retried."""

    def __init__(self, address, library, events, factory=pyvisa.ResourceManager):
        super().__init__(daemon=True, name="oe1022d-read")
        self.address, self.library, self.events, self.factory = address, library, events, factory
        self.go, self.stopping = threading.Event(), threading.Event()
        self.jobs = queue.Queue()
        self.channel = 1

    def read_settings(self, inst, channel, keys):
        values = {}
        for key in keys:
            values[key] = parse_setting(key, inst.query(query_command(key, channel)))
        return values

    def do(self, inst, job):
        kind, channel = job[0], job[1]
        if kind == "read":
            self.events.put(("settings", channel, self.read_settings(inst, channel, job[2]), time.perf_counter()))
        elif kind == "set":
            _, _, key, value = job
            inst.write(write_command(key, channel, value))
            keys = (key,) + ALSO_READ.get(key, ())
            self.events.put(("applied", channel, key, value, self.read_settings(inst, channel, keys), time.perf_counter()))
        elif kind == "auto":
            command = job[2]
            inst.timeout = AUTO_TIMEOUT_MS
            try:
                inst.write(f"{command} {channel}")
                values = self.read_settings(inst, channel, ORDER)  # waits until the instrument answers again
            finally:
                inst.timeout = 2000
            self.events.put(("auto", channel, command, values, time.perf_counter()))
        else:
            raise ValueError(f"unknown job {kind}")

    def run(self):
        rm = inst = None
        error = None
        try:
            rm = self.factory(self.library)
            inst = rm.open_resource(self.address)
            inst.baud_rate = 9600  # computer-side serial settings only
            inst.timeout = 2000
            inst.read_termination = "\r"
            inst.write_termination = "\r"
            self.events.put(("connected", clean(inst.query("*IDND?")), str(getattr(rm, "visalib", ""))))
            while not self.stopping.is_set():
                try:
                    job = self.jobs.get(timeout=0.0 if self.go.is_set() else 0.05)
                except queue.Empty:
                    job = None
                if job is not None:
                    self.do(inst, job)
                    continue
                if not self.go.is_set():
                    continue
                channel = self.channel
                reply = clean(inst.query(f"SNAPD? {channel},{SNAP_PARAMS}"))
                stamp = time.perf_counter()
                values = reply.split(",")
                if len(values) != 4:
                    raise ValueError(f"读数格式异常：{reply!r}")
                self.events.put(("sample", stamp, [float(v) for v in values], channel))
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        close_errors = []
        for obj in (inst, rm):
            if obj is not None:
                try:
                    obj.close()
                except Exception as exc:
                    close_errors.append(str(exc))
        self.events.put(("closed", error, close_errors))


class App:
    def __init__(self, root, library="@ivi", factory=pyvisa.ResourceManager):
        self.root, self.library, self.factory = root, library, factory
        self.events = queue.Queue()
        self.reader = None
        self.state = "disconnected"  # disconnected / connecting / connected
        self.reading = False
        self.exit_requested = self.destroyed = False
        self.t, self.rs, self.ps = [], ([], []), ([], [])  # time; R and phi of harmonic 1 / 2
        self.markers = []
        self.t0 = self.wall0 = None
        self.trimmed = False
        self.channel_of_data = None
        self.settings = {}  # channel -> {key: last read-back}
        self.pending = 0  # setting jobs sent but not yet answered
        self.boxes, self.entries, self.apply_buttons, self.row_labels = {}, {}, {}, {}
        root.title("OE1022D · 谐波读取与控制")
        root.geometry("1260x880")
        root.minsize(1120, 840)
        root.configure(bg=BG)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.style()
        self.build()
        self.sync()
        self.after_id = self.root.after(40, self.tick)

    # ---- layout ----
    def style(self):
        s = ttk.Style(self.root)
        s.theme_use("clam")
        s.configure("TFrame", background=BG)
        s.configure("TLabel", background=BG, foreground=INK, font=(FONT, 10))
        s.configure("TButton", font=(FONT, 10), padding=(10, 5))
        s.configure("Small.TButton", font=(FONT, 9), padding=(8, 2))
        s.configure("Accent.TButton", font=(FONT, 10, "bold"), padding=(14, 5))
        s.configure("TLabelframe", background=BG)
        s.configure("TLabelframe.Label", background=BG, foreground=MUTED, font=(FONT, 9))

    def harmonic_card(self, parent, slot):
        frame = tk.Frame(parent, bg=CARD, highlightthickness=1, highlightbackground="#e2dcd2", padx=16, pady=10)
        frame.columnconfigure((0, 1), weight=1, uniform="v")
        title = tk.StringVar(value=f"谐波 {slot}")
        tk.Label(frame, textvariable=title, bg=CARD, fg=INK, font=(FONT, 12, "bold")).grid(row=0, column=0, columnspan=2, sticky="w")
        out = {"title": title}
        for column, (name, caption, color) in enumerate((("r", "R  幅值（RMS）", R_COLOR), ("p", "φ  相位", P_COLOR))):
            tk.Label(frame, text=caption, bg=CARD, fg=MUTED, font=(FONT, 9)).grid(row=1, column=column, sticky="w", pady=(6, 0))
            big, detail = tk.StringVar(value="—"), tk.StringVar(value="")
            tk.Label(frame, textvariable=big, bg=CARD, fg=color, font=("Consolas", 30, "bold")).grid(row=2, column=column, sticky="w")
            tk.Label(frame, textvariable=detail, bg=CARD, fg=MUTED, font=("Consolas", 9), justify="left", anchor="w").grid(row=3, column=column, sticky="w")
            out[name + "_big"], out[name + "_detail"] = big, detail
        return frame, out

    def build(self):
        outer = ttk.Frame(self.root)
        outer.pack(fill="both", expand=True)
        self.build_settings(outer).pack(side="right", fill="y", padx=(0, 14), pady=12)
        f = ttk.Frame(outer, padding=(16, 12, 10, 12))
        f.pack(side="left", fill="both", expand=True)
        f.columnconfigure(0, weight=1)
        head = ttk.Frame(f)
        head.grid(row=0, sticky="ew")
        tk.Label(head, text="OE1022D 谐波读取与控制", bg=BG, fg=R_COLOR, font=(FONT, 18, "bold")).pack(side="left")
        self.led = tk.Label(head, text="● 未连接", bg=BG, fg=MUTED, font=(FONT, 10, "bold"))
        self.led.pack(side="right")
        self.rate = tk.StringVar(value="")
        ttk.Label(head, textvariable=self.rate, foreground=MUTED).pack(side="right", padx=(0, 14))
        link = ttk.LabelFrame(f, text="连接  ·  9600 baud · CR · 2000 ms  ·  连接与读取不改仪器，只有右侧设置面板会写入", padding=8)
        link.grid(row=1, sticky="ew", pady=(6, 8))
        link.columnconfigure(1, weight=1)
        ttk.Label(link, text="VISA 地址").grid(row=0, column=0, padx=(0, 8))
        self.address = ttk.Combobox(link, width=30)
        self.address.set(ADDRESS)
        self.address.grid(row=0, column=1, sticky="ew")
        self.b_scan = ttk.Button(link, text="刷新资源", command=self.scan)
        self.b_scan.grid(row=0, column=2, padx=6)
        self.b_connect = ttk.Button(link, text="连接并读取", style="Accent.TButton", command=self.toggle_connection)
        self.b_connect.grid(row=0, column=3)
        self.idn = tk.StringVar(value="地址以测量电脑为准；不要与测量程序或 VISA Lite 同时占用同一串口。")
        ttk.Label(link, textvariable=self.idn, foreground=MUTED, wraplength=600).grid(row=1, column=0, columnspan=4, sticky="w", pady=(6, 0))
        self.cards = {}
        for slot in (1, 2):
            frame, self.cards[slot] = self.harmonic_card(f, slot)
            frame.grid(row=1 + slot, sticky="ew", pady=(0, 8))
        bar = ttk.Frame(f)
        bar.grid(row=4, sticky="ew", pady=(2, 8))
        self.b_run = ttk.Button(bar, text="暂停", command=self.toggle_reading)
        self.b_run.pack(side="left")
        self.b_clear = ttk.Button(bar, text="清空", command=self.clear)
        self.b_clear.pack(side="left", padx=6)
        self.b_save = ttk.Button(bar, text="保存 CSV…", command=self.save)
        self.b_save.pack(side="left")
        ttk.Label(bar, text="通道").pack(side="left", padx=(18, 4))
        self.channel = ttk.Combobox(bar, values=("1", "2"), width=3, state="readonly")
        self.channel.set("1")
        self.channel.pack(side="left")
        self.channel.bind("<<ComboboxSelected>>", self.channel_changed)
        ttk.Label(bar, text="统计最近").pack(side="left", padx=(18, 4))
        self.stat_box = ttk.Combobox(bar, values=tuple(STAT_POINTS), width=6, state="readonly")
        self.stat_box.set("50 点")
        self.stat_box.pack(side="left")
        self.stat_box.bind("<<ComboboxSelected>>", lambda _e: self.refresh_display())
        self.status = tk.StringVar(value="就绪。读取的是所选通道的“谐波 1”和“谐波 2”（SNAPD? 参数 7、8、11、12，同一时刻读出）。R 的单位按用户现有程序取 V。")
        self.status_label = ttk.Label(f, textvariable=self.status, foreground=MUTED, wraplength=720)
        self.status_label.grid(row=5, sticky="w", pady=(4, 0))
        self.root.bind("<space>", lambda _e: self.toggle_reading() if self.b_run["state"] == "normal" and self.root.focus_get() is not self.address
                       and not isinstance(self.root.focus_get(), (ttk.Entry, ttk.Combobox)) else None)

    def build_settings(self, parent):
        panel = ttk.LabelFrame(parent, text="仪器设置（写入仪器，改后自动回读）", padding=10)
        self.panel_title = tk.StringVar(value="通道 1")
        ttk.Label(panel, textvariable=self.panel_title, font=(FONT, 11, "bold"), foreground=R_COLOR).grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 6))
        groups = {"ref": "参考", "sens": "增益与滤波", "amp": "输出"}
        row = 1
        for key in ORDER:
            if key in groups:
                ttk.Label(panel, text=groups[key], foreground=MUTED, font=(FONT, 9, "bold")).grid(row=row, column=0, columnspan=3, sticky="w", pady=(8 if row > 1 else 0, 2))
                row += 1
            spec = SPECS[key]
            label = tk.StringVar(value=spec["label"])
            self.row_labels[key] = label
            ttk.Label(panel, textvariable=label, font=(FONT, 9)).grid(row=row, column=0, sticky="w", pady=2, padx=(0, 8))
            if spec["kind"] == "enum":
                box = ttk.Combobox(panel, values=[f"{text} [{index}]" for index, text in spec["options"]], width=17, state="readonly")
                box.grid(row=row, column=1, columnspan=2, sticky="ew", pady=2)
                box.bind("<<ComboboxSelected>>", lambda _e, k=key: self.on_enum(k))
                self.boxes[key] = box
            else:
                var = tk.StringVar()
                entry = ttk.Entry(panel, textvariable=var, width=11)
                entry.grid(row=row, column=1, sticky="ew", pady=2)
                entry.bind("<Return>", lambda _e, k=key: self.on_num(k))
                button = ttk.Button(panel, text="应用", style="Small.TButton", command=lambda k=key: self.on_num(k))
                button.grid(row=row, column=2, padx=(6, 0), pady=2)
                self.entries[key], self.apply_buttons[key] = var, button
                self.boxes[key] = entry
            row += 1
            if key == "harm2":
                self.b_23 = ttk.Button(panel, text="谐波 1 = 2f，谐波 2 = 3f", style="Small.TButton", command=self.set_2f3f)
                self.b_23.grid(row=row, column=0, columnspan=3, sticky="ew", pady=2)
                row += 1
        row += 1
        ttk.Label(panel, text="自动", foreground=MUTED, font=(FONT, 9, "bold")).grid(row=row, column=0, columnspan=3, sticky="w", pady=(8, 2))
        row += 1
        self.auto_buttons = {}
        for column, (key, (_cmd, text)) in enumerate(AUTO.items()):
            button = ttk.Button(panel, text=text, style="Small.TButton", command=lambda k=key: self.on_auto(k))
            button.grid(row=row, column=column, sticky="ew", pady=2, padx=(0, 4))
            self.auto_buttons[key] = button
        self.b_readback = ttk.Button(panel, text="读回设置", style="Small.TButton", command=self.read_back)
        self.b_readback.grid(row=row, column=2, sticky="ew", pady=2)
        row += 1
        notes = ("谐波 1/2 是该通道的两个谐波检测槽，读数来自它们，不是基波。方括号内是发给仪器的下标，可对照面板；"
                 "时间常数下标按主驱动（0 起始），与手册差 1。外部参考时频率只读。SINE OUT 写入前会确认。")
        ttk.Label(panel, text=notes, foreground=MUTED, font=(FONT, 8), wraplength=290, justify="left").grid(row=row, column=0, columnspan=3, sticky="w", pady=(10, 0))
        panel.columnconfigure(1, weight=1)
        return panel

    # ---- state ----
    def notify(self, text, bad=False):
        self.status.set(text)
        self.status_label.configure(foreground=RED if bad else MUTED)

    def sync(self):
        connected, busy = self.state == "connected", self.state == "connecting"
        self.address.configure(state="disabled" if self.state != "disconnected" else "normal")
        self.b_scan.configure(state="normal" if self.state == "disconnected" else "disabled")
        self.b_connect.configure(text="断开" if connected else "连接中…" if busy else "连接并读取",
                                 state="disabled" if busy or self.exit_requested else "normal")
        self.b_run.configure(text="暂停" if self.reading else "继续读取", state="normal" if connected else "disabled")
        self.channel.configure(state="readonly" if connected and not self.reading or self.state == "disconnected" else "disabled")
        self.b_save.configure(state="normal" if self.t else "disabled")
        self.b_clear.configure(state="normal" if self.t else "disabled")
        if connected and self.reading:
            self.led.configure(text="● 读取中", fg=R_COLOR)
        elif connected:
            self.led.configure(text="● 已连接 · 已暂停", fg=P_COLOR)
        else:
            self.led.configure(text="● 连接中" if busy else "● 未连接", fg=MUTED)
        self.sync_panel()

    def current_channel(self):
        return int(self.channel.get())

    def sync_panel(self):
        known = self.settings.get(self.current_channel(), {})
        live = self.state == "connected" and self.pending == 0 and not self.exit_requested
        self.panel_title.set(f"通道 {self.current_channel()}" + ("" if live or self.state != "connected" else "  ·  通信中…"))
        for key in ORDER:
            spec, widget = SPECS[key], self.boxes[key]
            value = known.get(key)
            if spec["kind"] == "enum":
                widget.set("—" if value is None else enum_text(key, value))
            elif value is not None and self.root.focus_get() is not widget:
                self.entries[key].set(f"{value:d}" if spec.get("integer") else f"{value:.10g}")
            elif value is None:
                self.entries[key].set("—")
            enabled = live and value is not None
            if key == "freq":
                enabled = enabled and known.get("ref") == 1  # external: instrument reports the measured frequency
                self.row_labels[key].set("参考频率 (Hz)" if known.get("ref") != 0 else "外部频率 (测得)")
            state = ("readonly" if spec["kind"] == "enum" else "normal") if enabled else "disabled"
            widget.configure(state=state)
            if key in self.apply_buttons:
                self.apply_buttons[key].configure(state="normal" if enabled else "disabled")
        for button in list(self.auto_buttons.values()) + [self.b_readback]:
            button.configure(state="normal" if live else "disabled")
        self.b_23.configure(state="normal" if live and "harm1" in known else "disabled")
        for slot in (1, 2):
            order = known.get(f"harm{slot}")
            self.cards[slot]["title"].set(f"谐波 {slot} · " + ("次数未知" if order is None else f"{order} f" + ("（基波）" if order == 1 else "")))

    def scan(self):
        try:
            rm = self.factory(self.library)
            try:
                resources = tuple(rm.list_resources("?*"))
            finally:
                rm.close()
            self.address.configure(values=resources)
            self.notify("刷新只列出地址，不证明接有仪器：" + (", ".join(resources) or "无资源"))
        except Exception as exc:
            self.notify(f"枚举失败：{exc}", bad=True)

    def toggle_connection(self):
        if self.state == "connected":
            self.stop_reader()
            return
        address = self.address.get().strip()
        if not address:
            self.notify("请输入 VISA 地址。", bad=True)
            return
        self.state = "connecting"
        self.settings, self.pending = {}, 0
        self.reader = Reader(address, self.library, self.events, self.factory)
        self.reader.channel = self.current_channel()
        self.reader.start()
        self.notify(f"正在连接 {address} …")
        self.sync()

    def stop_reader(self):
        if self.reader:
            self.reader.stopping.set()
            self.reader.go.clear()
            self.notify("正在断开（等待当前通信结束，自动调整时最长约 30 秒）…")
            self.b_connect.configure(state="disabled")

    def toggle_reading(self):
        if self.state != "connected":
            return
        self.reading = not self.reading
        if self.reading:
            self.reader.go.set()
        else:
            self.reader.go.clear()
        self.sync()

    def channel_changed(self, _event=None):
        new = self.current_channel()
        if self.t and self.channel_of_data not in (None, new):
            if not messagebox.askyesno("切换通道", "切换通道会清空当前曲线。需要的话请先保存 CSV。\n继续切换？", parent=self.root):
                self.channel.set(str(self.channel_of_data))
                return
            self.clear()
        if self.reader:
            self.reader.channel = new
            if new not in self.settings:
                self.submit(("read", new, ORDER))
        self.sync()

    def clear(self):
        self.t, self.rs, self.ps, self.markers = [], ([], []), ([], []), []
        self.t0 = self.wall0 = self.channel_of_data = None
        self.trimmed = False
        for card in self.cards.values():
            for name in ("r_big", "p_big", "r_detail", "p_detail"):
                card[name].set("—" if name.endswith("big") else "")
        self.rate.set("")
        self.sync()

    def settings_line(self, channel):
        known = self.settings.get(channel)
        if not known:
            return "settings not read"
        parts = []
        for key in ORDER:
            if key in known:
                value = known[key]
                parts.append(f"{key}={enum_text(key, value) if SPECS[key]['kind'] == 'enum' else format(value, '.10g')}")
        return f"channel {channel} last read-back: " + "; ".join(parts)

    def save(self):
        if not self.t:
            return
        name = f"lockin_ch{self.channel_of_data or self.channel.get()}_{datetime.now():%Y%m%d_%H%M%S}.csv"
        path = filedialog.asksaveasfilename(parent=self.root, defaultextension=".csv", initialfile=name,
                                            filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
        if not path:
            return
        try:
            with open(path, "w", newline="", encoding="utf-8") as handle:
                handle.write(f"# OE1022D live reader; h1/h2 = harmonic slots 1/2 of one channel (SNAPD? params {SNAP_PARAMS}); R in V, phi in degrees; {self.settings_line(self.channel_of_data)}\n")
                handle.write("# Settings were not re-read per point; see setting changes below (time_s of change)\n")
                for when, label in self.markers:
                    handle.write(f"# change at {when:.3f} s: {label}\n")
                writer = csv.writer(handle)
                writer.writerow(["time_s", "timestamp", "R_h1_V", "phi_h1_deg", "R_h2_V", "phi_h2_deg", "channel"])
                for i, t in enumerate(self.t):
                    stamp = (self.wall0 + timedelta(seconds=t)).isoformat(timespec="milliseconds")
                    writer.writerow([f"{t:.4f}", stamp, repr(self.rs[0][i]), repr(self.ps[0][i]),
                                     repr(self.rs[1][i]), repr(self.ps[1][i]), self.channel_of_data])
            self.notify(f"已保存 {len(self.t)} 点到 {path}（R 单位 V，φ 单位度；文件头 # 行记录谐波次数等设置与改动时刻）。")
        except Exception as exc:
            self.notify(f"保存失败：{exc}", bad=True)
            messagebox.showerror("保存失败", str(exc), parent=self.root)

    # ---- instrument settings ----
    def submit(self, job):
        if self.state != "connected" or self.reader is None:
            return
        self.pending += 1
        self.reader.jobs.put(job)
        self.sync_panel()

    def read_back(self):
        self.submit(("read", self.current_channel(), ORDER))

    def on_enum(self, key):
        spec = SPECS[key]
        index = self.boxes[key].current()
        if index < 0:
            return
        value = spec["options"][index][0]
        known = self.settings.get(self.current_channel(), {})
        if known.get(key) == value:
            return
        self.submit(("set", self.current_channel(), key, value))

    def on_num(self, key):
        spec = SPECS[key]
        text = self.entries[key].get().strip()
        try:
            value = float(text)
            if not math.isfinite(value) or not spec["lo"] <= value <= spec["hi"]:
                raise ValueError
            if spec.get("integer") and value != int(value):
                raise ValueError
        except ValueError:
            self.notify(f"{spec['label']}必须是 {spec['lo']:g} ～ {spec['hi']:g} 之间的{'整' if spec.get('integer') else ''}数。", bad=True)
            self.sync_panel()
            return
        if key == "amp" and not messagebox.askyesno(
                "确认 SINE OUT", f"将通道 {self.current_channel()} 的 SINE OUT 幅度设为 {value:g} Vrms。\n"
                "这会改变加在样品上的真实激励，已核对？", parent=self.root):
            self.sync_panel()
            return
        self.submit(("set", self.current_channel(), key, int(value) if spec.get("integer") else value))

    def set_2f3f(self):
        channel = self.current_channel()
        self.submit(("set", channel, "harm1", 2))
        self.submit(("set", channel, "harm2", 3))

    def on_auto(self, key):
        command, text = AUTO[key]
        if not messagebox.askyesno(text, f"执行 {text}（{command}）：仪器会自行调整，可能持续数秒到数十秒，期间读数暂停；"
                                         "结果会改变相位或灵敏度设置。继续？", parent=self.root):
            return
        self.notify(f"{text}中…（通信最长等待 {AUTO_TIMEOUT_MS // 1000} 秒）")
        self.submit(("auto", self.current_channel(), command))

    def mark(self, stamp, label):
        if self.t0 is not None:
            self.markers.append((stamp - self.t0, label))

    # ---- event pump ----
    def tick(self):
        got = False
        try:
            while True:
                event = self.events.get_nowait()
                got |= self.handle(event)
        except queue.Empty:
            pass
        if self.destroyed:
            return
        if got:
            self.refresh_display()
        self.after_id = self.root.after(60, self.tick)

    def handle(self, event):
        kind = event[0]
        if kind == "sample":
            _, stamp, values, channel = event
            if self.reader is None or channel != self.reader.channel:
                return False  # stale sample from before a channel switch
            if self.t0 is None:
                self.t0, self.wall0, self.channel_of_data = stamp, datetime.now(), channel
            self.t.append(stamp - self.t0)
            for slot in (0, 1):
                self.rs[slot].append(values[2 * slot])
                self.ps[slot].append(values[2 * slot + 1])
            if len(self.t) > MAX_SAMPLES:
                cut = MAX_SAMPLES // 10
                del self.t[:cut]
                for slot in (0, 1):
                    del self.rs[slot][:cut], self.ps[slot][:cut]
                if not self.trimmed:
                    self.trimmed = True
                    self.notify(f"缓冲上限 {MAX_SAMPLES} 点，已丢弃最早的点；需要完整记录请先保存 CSV。")
            if len(self.t) == 1:
                self.sync()
            return True
        if kind == "connected":
            self.state, self.reading = "connected", True
            self.idn.set(f"{event[1] or '（无身份回复）'}   ·   {event[2]}")
            self.notify("已连接，立即读取，并回读当前设置（只查询，不写入）。")
            self.reader.go.set()
            self.submit(("read", self.reader.channel, ORDER))
            self.sync()
        elif kind == "settings":
            _, channel, values, _stamp = event
            self.settings.setdefault(channel, {}).update(values)
            self.pending = max(0, self.pending - 1)
            self.sync_panel()
        elif kind == "applied":
            _, channel, key, wanted, values, stamp = event
            self.settings.setdefault(channel, {}).update(values)
            self.pending = max(0, self.pending - 1)
            spec, got = SPECS[key], values[key]
            shown = enum_text(key, got) if spec["kind"] == "enum" else format(got, ".10g")
            if setting_matches(key, wanted, got):
                self.notify(f"通道 {channel} {spec['label']} → {shown}（已回读确认）")
                self.mark(stamp, f"{spec['label']} {shown}")
            else:
                wanted_text = enum_text(key, wanted) if spec["kind"] == "enum" else format(wanted, ".10g")
                self.notify(f"通道 {channel} {spec['label']}：设置 {wanted_text}，仪器回读 {shown}，不一致，请检查仪器面板。", bad=True)
                self.mark(stamp, f"{spec['label']} 回读 {shown}")
            self.sync_panel()
        elif kind == "auto":
            _, channel, command, values, stamp = event
            self.settings.setdefault(channel, {}).update(values)
            self.pending = max(0, self.pending - 1)
            text = next(t for c, t in AUTO.values() if c == command)
            self.notify(f"通道 {channel} {text}完成；已回读：{enum_text('sens', values['sens'])}，相位 {values['phase']:.2f}°。")
            self.mark(stamp, text)
            self.sync_panel()
        elif kind == "closed":
            error, close_errors = event[1], event[2]
            self.reader, self.state, self.reading, self.pending = None, "disconnected", False, 0
            message = "已断开会话（只关闭串口，没有改动仪器的设置或输出）。"
            if error:
                message = f"通信错误，已停止并关闭会话，不自动重试（最后一次设置是否生效请看面板）：{error}"
            if close_errors:
                message += "；关闭异常：" + "; ".join(close_errors)
            self.notify(message, bad=bool(error))
            self.idn.set("地址以测量电脑为准；不要与测量程序或 VISA Lite 同时占用同一串口。")
            self.sync()
            if self.exit_requested:
                self.destroyed = True
                self.root.after_idle(self.root.destroy)  # not from inside the running tick callback
        return False

    # ---- display ----
    def refresh_display(self):
        if not self.t:
            return
        limit = STAT_POINTS[self.stat_box.get()]
        start = 0 if limit is None else max(0, len(self.t) - limit)
        for slot in (0, 1):
            card = self.cards[slot + 1]
            r, p = np.asarray(self.rs[slot][start:]), np.asarray(self.ps[slot][start:])
            s = window_stats(r, p)
            card["r_big"].set(volts(self.rs[slot][-1]))
            card["p_big"].set(f"{self.ps[slot][-1]:.3f}°")
            card["r_detail"].set(f"均值 {volts(s['r_mean'])}   σ {volts(s['r_std'], 3)}"
                                 f"\n最小 {volts(s['r_min'])}   最大 {volts(s['r_max'])}"
                                 f"\nn={s['n']}   原始 {self.rs[slot][-1]:.6e}")
            card["p_detail"].set(f"均值 {s['p_mean']:.3f}°   σ {s['p_std']:.3f}°（圆周）"
                                 f"\n最小 {s['p_min']:.3f}°   最大 {s['p_max']:.3f}°"
                                 f"\n原始 {self.ps[slot][-1]:.6f}")
        last = len(self.t) - bisect.bisect_left(self.t, self.t[-1] - 1.0)
        self.rate.set(f"{last}/s · {len(self.t)} 点" if self.reading else f"已暂停 · {len(self.t)} 点")

    # ---- exit ----
    def close(self):
        if self.exit_requested:
            return
        self.exit_requested = True
        if self.reader:
            self.reader.stopping.set()
            self.reader.go.clear()
            self.notify("正在关闭会话…")
            self.sync()
        else:
            self.destroyed = True
            self.root.destroy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--visa-library", default="@ivi", help="Existing IVI VISA DLL path; no driver installation")
    args = parser.parse_args()
    try:  # crisp text on high-DPI screens
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    root = tk.Tk()
    App(root, args.visa_library if args.visa_library.endswith("@ivi") else args.visa_library + "@ivi")
    root.mainloop()


if __name__ == "__main__":
    main()
