"""Offline tests for read_lockin_ui.py: fake VISA, real Tk widgets, never opens an instrument."""
import csv
import gc
import math
import os
import re
import sys
import tempfile
import threading
import time
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import read_lockin_ui as ui  # noqa: E402  (import must not connect anything)

INITIAL = {"FMODD": 1, "FREQD": 79.0, "HARMD1": 1, "HARMD2": 1, "PHASD": 12.5, "SENSD": 13,
           "OFLTD": 11, "OFSLD": 3, "SYNCD": 0, "SLVLD": 5.0}


class Instrument:
    """Remembers writes into a state table, so read-backs are real."""

    def __init__(self, replies=None, fail_after=None, fail_on=None, slow_auto=False):
        self.commands, self.writes, self.closed = [], [], False
        self.replies, self.fail_after, self.fail_on = replies, fail_after, fail_on
        self.state = {ch: dict(INITIAL) for ch in (1, 2)}
        self.timeout_log = []
        self.snapd = 0
        self.lock = threading.Lock()
        self._timeout = 2000

    @property
    def timeout(self):
        return self._timeout

    @timeout.setter
    def timeout(self, value):
        self._timeout = value
        self.timeout_log.append(value)

    def query(self, command):
        with self.lock:
            self.commands.append(command)
            count = len(self.commands)
        if command == "*IDND?":
            return "SSI,OE1022D,TEST\x00\r"
        if self.fail_on and command.startswith(self.fail_on):
            raise TimeoutError("simulated settings timeout")
        match = re.fullmatch(r"([A-Z]+)\? (\d)(?:,(\d))?", command)
        if match:
            name = match.group(1) + (match.group(3) or "")
            if name in INITIAL:
                return f"{self.state[int(match.group(2))][name]}\x00\r"
        if command.startswith("SNAPD"):
            self.snapd += 1
            if self.fail_after is not None and self.snapd > self.fail_after:
                raise TimeoutError("simulated read timeout")
        if self.replies:
            return self.replies.pop(0)
        time.sleep(0.002)
        return f"{count}.5e-6,{count % 90}.25,{count}.2e-7,{count % 90}.75\x00\r"

    def write(self, command):
        with self.lock:
            self.writes.append(command)
        if command.startswith(("APHSD", "AGAND")):
            ch = int(command.split()[1])
            if command.startswith("APHSD"):
                self.state[ch]["PHASD"] = -33.33
            else:
                self.state[ch]["SENSD"] = 15
            return
        match = re.fullmatch(r"([A-Z]+) (\d),(?:(\d),)?(.+)", command)
        name, ch, value = match.group(1), int(match.group(2)), float(match.group(4))
        if name == "HARMD":
            name += match.group(3)
        self.state[ch][name] = int(value) if name not in ("SLVLD", "FREQD", "PHASD") else value

    def close(self):
        self.closed = True


def factory_for(instrument, log):
    class Manager:
        visalib = "fake-ivi"

        def __init__(self, library):
            log["library"] = library

        def open_resource(self, address):
            log["address"] = address
            log["opened"] = True
            return instrument

        def list_resources(self, query):
            return ("ASRL4::INSTR", "GPIB0::12::INSTR")

        def close(self):
            log["manager_closed"] = True

    return Manager


def csv_rows(path):
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    comments = [line for line in lines if line.startswith("#")]
    return comments, list(csv.reader(line for line in lines if not line.startswith("#")))


class Tests(unittest.TestCase):
    def make(self, instrument):
        self.log = {}
        try:
            root = tk.Tk()
        except tk.TclError as exc:
            self.skipTest(f"no display: {exc}")
        root.withdraw()
        self.inst = instrument

        def cleanup():
            reader = self.app.reader
            if reader is not None:  # no worker thread may outlive its test (Tk objects must die in the main thread)
                reader.stopping.set()
                reader.join(5)
            if not self.app.destroyed:
                root.after_cancel(self.app.after_id)  # a pending tick would fire into a dead interpreter
                root.destroy()
            self.app = None
            gc.collect()

        self.addCleanup(cleanup)
        self.app = ui.App(root, "@ivi", factory_for(instrument, self.log))
        return root

    def pump(self, root, until, timeout=5):
        end = time.time() + timeout
        while time.time() < end and not until():
            root.update()
            time.sleep(0.01)
        self.assertTrue(until(), "timeout waiting for condition")

    def connect(self, root, samples=3):
        self.app.toggle_connection()
        self.pump(root, lambda: len(self.app.t) >= samples and self.app.pending == 0 and 1 in self.app.settings)

    def settle(self, root):
        self.pump(root, lambda: self.app.pending == 0)

    def disconnect(self, root):
        self.app.toggle_connection()
        self.pump(root, lambda: self.app.state == "disconnected")

    # ---- tables and helpers ----
    def test_tables_match_the_verified_driver(self):
        from SSI_OE1022D_modified import LockInOE1022D
        import inspect
        source = inspect.getsource(LockInOE1022D.__init__)
        self.assertEqual(ui.SENSITIVITIES, re.findall(r'"(\d+ [num]?V)"', source.split("self.sensitivities")[1].split("self.parameters")[0]))
        self.assertEqual(ui.TIME_CONSTANTS, re.findall(r"'(\d+ [um]?s)'", source.split("self.time_constants")[1].split("self.R_chan")[0]))
        self.assertEqual(ui.TIME_CONSTANTS[10], "1 s")  # driver table, 0-based
        self.assertEqual(ui.TIME_CONSTANTS[11], "3 s")  # the user measured 3 s for command index 11
        self.assertEqual(ui.SENSITIVITIES[13], "20 uV")

    def test_command_spelling_follows_driver(self):
        w = ui.write_command
        self.assertEqual(w("ref", 1, 1), "FMODD 1,1")
        self.assertEqual(w("freq", 1, 79), "FREQD 1,79")
        self.assertEqual(w("phase", 2, -12.5), "PHASD 2,-12.5")
        self.assertEqual(w("sens", 1, 13), "SENSD 1,13")
        self.assertEqual(w("tc", 1, 10), "OFLTD 1,10")
        self.assertEqual(w("slope", 1, 3), "OFSLD 1,3")
        self.assertEqual(w("sync", 1, 1), "SYNCD 1,1")
        self.assertEqual(w("harm1", 1, 2), "HARMD 1,1,2")
        self.assertEqual(w("harm2", 1, 3), "HARMD 1,2,3")
        self.assertEqual(w("amp", 1, 5.0), "SLVLD 1,5")
        self.assertEqual(ui.query_command("harm1", 2), "HARMD? 2,1")
        self.assertEqual(ui.query_command("harm2", 2), "HARMD? 2,2")
        self.assertEqual(ui.query_command("tc", 1), "OFLTD? 1")

    def test_formatting_and_stats(self):
        self.assertEqual(ui.volts(12.345e-6), "12.35 µV")
        self.assertEqual(ui.volts(0.5), "500 mV")
        self.assertEqual(ui.volts(0), "0 V")
        self.assertEqual(ui.volts(3e-9), "3 nV")
        wrap = ui.window_stats([1, 1, 1, 1], [179.0, -179.0, 179.5, -179.5])
        self.assertLess(wrap["p_std"], 1.5)  # naive std would be ~179
        self.assertAlmostEqual(abs(wrap["p_mean"]), 180, delta=1)
        flat = ui.window_stats([2e-6, 4e-6], [10.0, 20.0])
        self.assertAlmostEqual(flat["r_mean"], 3e-6)
        self.assertAlmostEqual(flat["r_std"], math.sqrt(2) * 1e-6)
        self.assertAlmostEqual(flat["p_mean"], 15.0, places=6)

    # ---- connection and reading ----
    def test_connect_reads_settings_without_any_write(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root, 25)
        self.assertEqual(self.log["address"], "ASRL4::INSTR")
        self.assertEqual(self.log["library"], "@ivi")
        self.assertEqual((inst.baud_rate, inst.read_termination, inst.write_termination), (9600, "\r", "\r"))
        self.assertEqual(inst.timeout_log[-1] if inst.timeout_log else 2000, 2000)
        self.assertEqual(inst.writes, [], "connecting and reading must not write")
        self.assertEqual(inst.commands[0], "*IDND?")
        for command in inst.commands:
            self.assertTrue(command == "*IDND?" or command == "SNAPD? 1,7,8,11,12" or re.fullmatch(r"[A-Z]+\? 1(,[12])?", command), command)
        # Panel shows the instrument's actual state, using the driver's 0-based tables.
        self.assertEqual(self.app.boxes["tc"].get(), "3 s [11]")
        self.assertEqual(self.app.boxes["sens"].get(), "20 uV [13]")
        self.assertEqual(self.app.boxes["ref"].get(), "内部 [1]")
        self.assertEqual(self.app.entries["freq"].get(), "79")
        self.assertEqual(self.app.entries["harm1"].get(), "1")
        self.assertEqual(self.app.cards[1]["title"].get(), "谐波 1 · 1 f（基波）")
        self.assertEqual(self.app.cards[1]["r_big"].get(), ui.volts(self.app.rs[0][-1]))
        self.assertEqual(self.app.cards[2]["r_big"].get(), ui.volts(self.app.rs[1][-1]))
        self.assertNotEqual(self.app.rs[0][-1], self.app.rs[1][-1])  # the two slots are two different readings
        self.app.toggle_reading()
        time.sleep(0.15)
        root.update()
        paused = len(inst.commands)
        time.sleep(0.2)
        root.update()
        self.assertEqual(len(inst.commands), paused, "pause must stop querying")
        self.disconnect(root)
        self.assertTrue(inst.closed and self.log["manager_closed"])
        self.assertEqual(inst.writes, [])

    def test_error_stops_without_retry_and_closes(self):
        inst = Instrument(fail_after=3)
        root = self.make(inst)
        self.app.toggle_connection()
        self.pump(root, lambda: self.app.state == "disconnected" and self.log.get("opened"))
        self.assertEqual(sum(c.startswith("SNAPD") for c in inst.commands), 4)
        self.assertTrue(inst.closed and self.log["manager_closed"])
        self.assertIn("不自动重试", self.app.status.get())

    def test_malformed_reply_stops(self):
        inst = Instrument(replies=["1e-6\r"])
        root = self.make(inst)
        self.app.toggle_connection()
        self.pump(root, lambda: self.app.state == "disconnected" and self.log.get("opened"))
        self.assertIn("读数格式异常", self.app.status.get())
        self.assertEqual(self.app.t, [])

    def test_close_window_closes_session(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        self.app.close()
        self.pump(root, lambda: self.app.destroyed)
        root.update()  # run the idle destroy
        self.assertTrue(inst.closed and self.log["manager_closed"])
        self.assertEqual(inst.writes, [])

    # ---- settings writes ----
    def choose(self, key, text):
        box = self.app.boxes[key]
        box.set(text)
        box.event_generate("<<ComboboxSelected>>")
        self.app.root.update()

    def test_sensitivity_and_time_constant_write_and_readback(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        self.choose("sens", "100 uV [15]")
        self.settle(root)
        self.choose("tc", "1 s [10]")
        self.settle(root)
        self.assertEqual(inst.writes, ["SENSD 1,15", "OFLTD 1,10"])
        self.assertEqual(self.app.settings[1]["sens"], 15)
        self.assertEqual(self.app.boxes["tc"].get(), "1 s [10]")
        self.assertIn("已回读确认", self.app.status.get())
        self.assertEqual(len(self.app.markers), 2)  # setting changes are marked on the curves
        self.app.refresh_display()
        self.disconnect(root)
        self.assertEqual(inst.state[1]["OFLTD"], 10)

    def test_reference_switch_updates_frequency_availability(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        self.assertEqual(str(self.app.boxes["freq"]["state"]), "normal")
        self.choose("ref", "外部 [0]")
        self.settle(root)
        self.assertEqual(inst.writes, ["FMODD 1,0"])
        self.assertEqual(str(self.app.boxes["freq"]["state"]), "disabled")  # external: measured frequency only
        self.assertEqual(self.app.row_labels["freq"].get(), "外部频率 (测得)")
        self.choose("ref", "内部 [1]")
        self.settle(root)
        self.assertEqual(str(self.app.boxes["freq"]["state"]), "normal")
        self.disconnect(root)

    def test_numeric_validation_and_confirmation(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        for key, bad in (("freq", "0"), ("freq", "abc"), ("freq", "200000"), ("phase", "181"), ("harm1", "2.5"), ("harm2", "0"), ("amp", "5.5")):
            self.app.entries[key].set(bad)
            self.app.on_num(key)
            self.assertIn("必须是", self.app.status.get(), (key, bad))
        self.assertEqual(inst.writes, [])
        self.app.entries["freq"].set("133.5")
        self.app.on_num("freq")
        self.settle(root)
        self.app.entries["harm2"].set("3")
        self.app.on_num("harm2")
        self.settle(root)
        self.app.entries["phase"].set("-45")
        self.app.on_num("phase")
        self.settle(root)
        self.assertEqual(inst.writes, ["FREQD 1,133.5", "HARMD 1,2,3", "PHASD 1,-45"])
        self.app.entries["amp"].set("1.5")
        with patch.object(ui.messagebox, "askyesno", return_value=False) as ask:
            self.app.on_num("amp")
        self.assertTrue(ask.called)
        self.assertEqual(len(inst.writes), 3, "declined SINE OUT confirmation must not write")
        self.assertEqual(self.app.entries["amp"].get(), "5")  # declined: box shows the instrument's real value again
        self.app.entries["amp"].set("1.5")
        with patch.object(ui.messagebox, "askyesno", return_value=True):
            self.app.on_num("amp")
        self.settle(root)
        self.assertEqual(inst.writes[-1], "SLVLD 1,1.5")
        self.assertEqual(inst.state[1]["SLVLD"], 1.5)
        self.disconnect(root)

    def test_auto_phase_uses_long_timeout_and_restores_it(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        with patch.object(ui.messagebox, "askyesno", return_value=True):
            self.app.on_auto("phase")
        self.settle(root)
        self.assertEqual(inst.writes, ["APHSD 1"])
        self.assertEqual(inst.timeout_log[-2:], [ui.AUTO_TIMEOUT_MS, 2000])
        self.assertAlmostEqual(self.app.settings[1]["phase"], -33.33)
        self.assertIn("自动相位完成", self.app.status.get())
        self.disconnect(root)

    def test_declined_auto_does_not_write(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        with patch.object(ui.messagebox, "askyesno", return_value=False):
            self.app.on_auto("gain")
        self.assertEqual(inst.writes, [])
        self.disconnect(root)

    def test_setting_failure_stops_and_closes(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        inst.fail_on = "OFLTD?"
        self.choose("tc", "1 s [10]")
        self.pump(root, lambda: self.app.state == "disconnected")
        self.assertTrue(inst.closed and self.log["manager_closed"])
        self.assertIn("不自动重试", self.app.status.get())
        self.assertEqual(self.app.pending, 0)

    def test_channel_two_reads_and_writes_its_own_settings(self):
        inst = Instrument()
        inst.state[2]["SENSD"] = 20
        root = self.make(inst)
        self.connect(root)
        self.app.toggle_reading()  # pause so the channel can change
        time.sleep(0.1)
        root.update()
        self.app.channel.set("2")
        with patch.object(ui.messagebox, "askyesno", return_value=True):  # curve of channel 1 is discarded
            self.app.channel_changed()
        self.pump(root, lambda: 2 in self.app.settings and self.app.pending == 0)
        self.assertEqual(self.app.boxes["sens"].get(), "5 mV [20]")
        self.assertIn("SENSD? 2", inst.commands)
        self.choose("sens", "10 mV [21]")
        self.settle(root)
        self.assertEqual(inst.writes, ["SENSD 2,21"])
        self.assertEqual(inst.state[1]["SENSD"], 13, "channel 1 must be untouched")
        self.disconnect(root)

    # ---- data ----
    def test_channel_switch_and_csv(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root, 5)
        self.assertEqual(str(self.app.channel["state"]), "disabled")  # no switching mid-read
        self.app.toggle_reading()
        time.sleep(0.1)
        root.update()
        self.choose("sens", "100 uV [15]")
        self.settle(root)
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "out.csv")
            with patch.object(ui.filedialog, "asksaveasfilename", return_value=target):
                self.app.save()
            comments, rows = csv_rows(target)
        self.assertEqual(rows[0], ["time_s", "timestamp", "R_h1_V", "phi_h1_deg", "R_h2_V", "phi_h2_deg", "channel"])
        self.assertEqual(len(rows) - 1, len(self.app.t))
        self.assertEqual(rows[1][6], "1")
        self.assertEqual(float(rows[1][2]), self.app.rs[0][0])
        self.assertEqual(float(rows[1][3]), self.app.ps[0][0])
        self.assertEqual(float(rows[1][4]), self.app.rs[1][0])
        self.assertEqual(float(rows[1][5]), self.app.ps[1][0])
        self.assertTrue(any("harm1=1" in line and "harm2=1" in line for line in comments), comments)
        self.assertTrue(any("tc=3 s [11]" in line for line in comments), comments)
        self.assertTrue(any("change at" in line and "灵敏度" in line for line in comments), comments)
        with patch.object(ui.messagebox, "askyesno", return_value=True):
            self.app.channel.set("2")
            self.app.channel_changed()
        self.assertEqual(self.app.t, [])
        self.assertEqual(self.app.markers, [])
        self.app.toggle_reading()
        self.pump(root, lambda: len(self.app.t) >= 3)
        self.assertIn("SNAPD? 2,7,8,11,12", inst.commands)
        self.assertEqual(self.app.channel_of_data, 2)
        self.disconnect(root)

    def test_2f_3f_in_one_channel(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        self.assertEqual(str(self.app.b_23["state"]), "normal")
        self.app.b_23.invoke()
        self.settle(root)
        self.assertEqual(inst.writes, ["HARMD 1,1,2", "HARMD 1,2,3"])
        self.assertEqual((inst.state[1]["HARMD1"], inst.state[1]["HARMD2"]), (2, 3))
        self.assertEqual(inst.state[2]["HARMD1"], 1, "channel 2 must be untouched")
        self.assertEqual(self.app.cards[1]["title"].get(), "谐波 1 · 2 f")
        self.assertEqual(self.app.cards[2]["title"].get(), "谐波 2 · 3 f")
        self.assertEqual(self.app.entries["harm1"].get(), "2")
        self.assertEqual(self.app.entries["harm2"].get(), "3")
        count = len(self.app.t)
        self.pump(root, lambda: len(self.app.t) > count + 3)
        self.assertEqual({c for c in inst.commands if c.startswith("SNAPD")}, {"SNAPD? 1,7,8,11,12"})
        self.assertEqual(len(self.app.markers), 2)
        self.disconnect(root)

    def test_clamped_harmonic_is_reported(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root)
        real_write = inst.write

        def clamping(command):
            real_write(command)
            if command == "HARMD 1,2,3":
                inst.state[1]["HARMD2"] = 2  # instrument reduces the order (k * f > 102 kHz)

        inst.write = clamping
        self.app.entries["harm2"].set("3")
        self.app.on_num("harm2")
        self.settle(root)
        self.assertIn("不一致", self.app.status.get())
        self.assertEqual(self.app.cards[2]["title"].get(), "谐波 2 · 2 f")
        self.disconnect(root)

    def test_statistics_use_the_chosen_number_of_points(self):
        inst = Instrument()
        root = self.make(inst)
        self.connect(root, 30)
        self.app.toggle_reading()
        time.sleep(0.1)
        root.update()
        self.app.stat_box.set("20 点")
        self.app.refresh_display()
        self.assertIn("n=20", self.app.cards[1]["r_detail"].get())
        self.assertIn("n=20", self.app.cards[2]["r_detail"].get())
        self.app.stat_box.set("全部")
        self.app.refresh_display()
        self.assertIn(f"n={len(self.app.t)}", self.app.cards[1]["r_detail"].get())
        self.app.clear()
        self.assertEqual(self.app.cards[1]["r_big"].get(), "—")
        self.assertEqual(self.app.rs, ([], []))
        self.disconnect(root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
