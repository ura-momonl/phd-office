# -*- coding: utf-8 -*-
"""Only run through node scripts/run-tests.mjs --instruments (sanitised copy)."""
import os
import time
import unittest
from unittest.mock import patch
import tkinter as tk
from pathlib import Path
import control_6221 as panel

if os.environ.get("PHD_ISOLATED_TESTS") != "1":
    raise RuntimeError("Use node scripts/run-tests.mjs --instruments; never test against the real office")


class Instrument:
    def __init__(self):
        self.commands, self.output, self.closed = [], False, False
        self.external_trigger = True  # Representative retained setting, not a clean default.
        self.wave_running = False
        self.identity = "KEITHLEY INSTRUMENTS INC.,MODEL 6221,12345,1.0"
        self.fail = None
        self.error_reply = '0,"No error"'

    def write(self, command):
        self.commands.append(command)
        if self.fail and command.startswith(self.fail):
            raise TimeoutError("injected write timeout")
        if command == "SOUR:WAVE:EXTR OFF":
            self.external_trigger = False
        if command == "SOUR:WAVE:INIT":
            self.wave_running = not self.external_trigger
        elif command == "SOUR:WAVE:ABOR" or command == "OUTP OFF":
            self.wave_running = False
        if command == "OUTP ON" or command == "SOUR:WAVE:INIT":
            self.output = True
        elif command == "OUTP OFF":
            self.output = False

    def query(self, command):
        self.commands.append(command)
        if self.fail == command:
            raise TimeoutError("injected query timeout")
        if command == "*IDN?":
            return self.identity
        if command == "OUTP?":
            return str(int(self.output))
        if command == "SYST:ERR?":
            return self.error_reply
        raise AssertionError("Unexpected query " + command)

    def close(self):
        self.closed = True
        if self.fail == "close":
            raise RuntimeError("injected close failure")


class Manager:
    visalib = "SIMULATED — no real VISA session"
    def __init__(self, inst):
        self.inst, self.closed = inst, False

    def open_resource(self, address):
        return self.inst

    def list_resources(self, expression):
        assert expression == "?*"
        return ("GPIB0::12::INSTR",)

    def close(self):
        self.closed = True


def params(**changes):
    p = dict(dc="30", amplitude="10", offset="-2", frequency="79", compliance="1", limit="1000")
    p.update(changes)
    return panel.settings(**p)


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.inst = Instrument()
        self.manager = Manager(self.inst)
        self.mock = patch.object(panel.pyvisa, "ResourceManager", return_value=self.manager)
        self.factory = self.mock.start()
        self.addCleanup(self.mock.stop)
        self.client = panel.Controller()

    def connect(self):
        self.client.connect("GPIB0::12::INSTR")

    def test_connection_is_read_only_and_explicit_ivi(self):
        self.connect()
        self.factory.assert_called_once_with("@ivi")
        self.assertEqual(self.inst.commands, ["*IDN?", "OUTP?"])
        self.assertEqual(self.inst.read_termination, "\n")
        self.assertIs(self.client.output, False)

    def test_wrong_device_rejected_without_writes(self):
        self.inst.identity = "KEITHLEY INSTRUMENTS INC.,MODEL 2400,x,x"
        with self.assertRaisesRegex(RuntimeError, "不是 Keithley"):
            self.connect()
        self.assertEqual(self.inst.commands, ["*IDN?"])
        self.assertTrue(self.inst.closed and self.manager.closed)
        self.assertIsNone(self.client.driver)

    def test_resource_list_does_not_probe_devices(self):
        self.assertEqual(self.client.resources(), ("GPIB0::12::INSTR",))
        self.assertEqual(self.inst.commands, [])
        self.assertTrue(self.manager.closed)

    def test_dc_uses_original_commands_and_microamps(self):
        self.connect()
        self.client.run("dc", params(dc="-30"))
        self.assertEqual(self.inst.commands[2:], ["SYST:ERR?", "SOUR:WAVE:ABOR", "CURR:COMP 1", "SOUR:CURR -3e-05", "OUTP ON", "SYST:ERR?", "OUTP?"])
        self.assertIs(self.client.output, True)
        self.client.disconnect()
        self.assertFalse(self.inst.output)
        self.assertTrue(self.inst.closed and self.manager.closed)

    def test_sine_retains_verified_duration_marker_and_update(self):
        self.connect()
        self.client.run("ac", params())
        commands = self.inst.commands
        for command in ("SOUR:WAVE:FUNC SIN", "SOUR:WAVE:FREQ 79", "SOUR:WAVE:AMPL 1e-05", "SOUR:WAVE:OFFS -2e-06", "SOUR:WAVE:DUR:TIME 999999", "SOUR:WAVE:PMAR:STAT ON", "SOUR:WAVE:PMAR:OLIN 1", "SOUR:WAVE:RANG BEST", "SOUR:WAVE:ARM", "SOUR:WAVE:INIT"):
            self.assertIn(command, commands)
        self.assertLess(commands.index("OUTP OFF"), commands.index("SOUR:WAVE:ARM"))
        self.assertEqual(commands.count("SOUR:WAVE:EXTR OFF"), 1)
        self.assertLess(commands.index("SOUR:WAVE:ABOR"), commands.index("SOUR:WAVE:EXTR OFF"))
        self.assertLess(commands.index("SOUR:WAVE:EXTR OFF"), commands.index("SOUR:WAVE:PMAR:STAT ON"))
        self.assertLess(commands.index("SOUR:WAVE:EXTR OFF"), commands.index("SOUR:WAVE:ARM"))
        self.assertFalse(self.inst.external_trigger)
        self.assertTrue(self.inst.wave_running)
        start = len(commands)
        self.client.run("update", params(amplitude="20", offset="0"))
        self.assertEqual(commands[start:], ["SYST:ERR?", "SOUR:WAVE:AMPL 2e-05", "SOUR:WAVE:OFFS 0", "SYST:ERR?", "OUTP?"])

    def test_external_trigger_setting_failure_never_arms_or_starts(self):
        self.connect()
        self.inst.fail = "SOUR:WAVE:EXTR OFF"
        with self.assertRaisesRegex(RuntimeError, "操作失败"):
            self.client.run("ac", params())
        self.assertEqual(self.inst.commands.count("SOUR:WAVE:EXTR OFF"), 1)
        self.assertNotIn("SOUR:WAVE:ARM", self.inst.commands)
        self.assertNotIn("SOUR:WAVE:INIT", self.inst.commands)
        self.assertIs(self.client.output, False)

    def test_limits_reject_dc_and_ac_extremes_before_io(self):
        self.connect()
        for mode, p in (("dc", params(dc="1001")), ("ac", params(amplitude="999", offset="2"))):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.client.run(mode, p)
        self.assertEqual(self.inst.commands, ["*IDN?", "OUTP?"])
        for key, value in (("dc", "nan"), ("amplitude", "-1"), ("offset", "inf"), ("frequency", "0"), ("compliance", "106"), ("limit", "0")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                params(**{key: value})

    def test_stale_instrument_error_blocks_enable(self):
        self.connect()
        self.inst.error_reply = '-222,"Data out of range"'
        with self.assertRaisesRegex(RuntimeError, "仪器错误"):
            self.client.run("dc", params())
        self.assertNotIn("OUTP ON", self.inst.commands)

    def test_failure_still_sends_off_if_abort_fails(self):
        self.connect()
        self.inst.output = True
        self.inst.fail = "SOUR:WAVE:ABOR"
        result = self.client.stop()
        self.assertIn("警告", result)
        self.assertIn("OUTP OFF", self.inst.commands)
        self.assertIs(self.client.output, False)

    def test_operation_error_attempts_stop_no_retry(self):
        self.connect()
        self.inst.fail = "SOUR:WAVE:AMPL"
        with self.assertRaisesRegex(RuntimeError, "操作失败"):
            self.client.run("ac", params())
        self.assertEqual(self.inst.commands.count("SOUR:WAVE:AMPL 1e-05"), 1)
        self.assertIs(self.client.output, False)

    def test_unconfirmed_stop_keeps_session_and_unknown_state(self):
        self.connect()
        self.inst.output = True
        self.inst.fail = "OUTP OFF"
        with self.assertRaisesRegex(RuntimeError, "未确认"):
            self.client.disconnect()
        self.assertIsNotNone(self.client.driver)
        self.assertFalse(self.inst.closed)
        self.inst.fail = "OUTP?"
        with self.assertRaises(RuntimeError):
            self.client.stop()
        self.assertIsNone(self.client.output)

    def test_both_resources_closed_despite_close_failure(self):
        self.connect()
        self.inst.fail = "close"
        with self.assertRaisesRegex(RuntimeError, "关闭异常"):
            self.client.release()
        self.assertTrue(self.inst.closed and self.manager.closed)

    def test_real_tk_callbacks_cancel_enable_update_stop_and_exit(self):
        root = tk.Tk()
        app = panel.App(root)
        self.addCleanup(lambda: app.worker.shutdown(wait=True))
        def destroy():
            try:
                root.destroy()
            except tk.TclError:
                pass  # Normal GUI exit already destroyed the window.
        self.addCleanup(destroy)

        def wait():
            until = time.monotonic() + 8
            while app.pending and time.monotonic() < until:
                root.update()
                time.sleep(.01)
            root.update()
            self.assertIsNone(app.pending)

        self.assertEqual(str(app.buttons["dc"]["state"]), "disabled")
        app.buttons["scan"].invoke()
        wait()
        self.assertEqual(app.address["values"], ("GPIB0::12::INSTR",))
        app.buttons["connect"].invoke()
        wait()
        before = len(self.inst.commands)
        with patch.object(panel.messagebox, "askyesno", return_value=False):
            app.buttons["dc"].invoke()
        self.assertEqual(len(self.inst.commands), before)
        with patch.object(panel.messagebox, "askyesno", return_value=True):
            notebook = next(w for w in app.root.winfo_children()[0].winfo_children() if isinstance(w, panel.ttk.Notebook))
            notebook.select(1)
            root.update()
            app.buttons["ac"].invoke()
            wait()
            self.assertIs(app.client.output, True)
            self.assertTrue(self.inst.wave_running)
            app.fields["amplitude"].set("2")
            app.buttons["update"].invoke()
            wait()
        app.buttons["stop"].invoke()
        wait()
        self.assertIs(app.client.output, False)
        self.assertEqual(str(app.buttons["update"]["state"]), "disabled")
        # Render final AC tab and capture this test window only (not the desktop).
        notebook = next(w for w in app.root.winfo_children()[0].winfo_children() if isinstance(w, panel.ttk.Notebook))
        notebook.select(1)
        root.update()
        self.assertLess(app.log.winfo_rooty()+app.log.winfo_height(), root.winfo_rooty()+root.winfo_height()+1)
        from PIL import ImageGrab
        import ctypes
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        ImageGrab.grab(window=hwnd).save(Path("control-panel-test.png"))
        # Also exercise a stop requested while VISA is in flight.
        def slow_read():
            time.sleep(.12)
            return app.client.refresh()
        app.submit("test pending read", slow_read)
        app.buttons["stop"].invoke()
        self.assertTrue(app.stop_requested)
        wait()
        self.assertFalse(app.stop_requested)
        self.assertIs(app.client.output, False)
        # Close through the actual GUI handler; no real instruments touched.
        with patch.object(panel.messagebox, "askyesno", return_value=True):
            app.close()
            until = time.monotonic() + 8
            while app.pending and time.monotonic() < until:
                root.update()
                time.sleep(.01)
        self.assertTrue(self.inst.closed and self.manager.closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
