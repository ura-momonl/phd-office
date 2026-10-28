# -*- coding: utf-8 -*-
"""Read-only Lake Shore Model 336 temperature interface."""

from __future__ import annotations

import pyvisa


class LakeShore336Temperature:
    def __init__(
        self,
        resource_name="GPIB0::11::INSTR",
        channel="B",
        timeout_ms=2000,
    ):
        self.resource_name = str(resource_name)
        self.channel = str(channel).upper()
        if self.channel not in {"A", "B", "C", "D"}:
            raise ValueError("Lake Shore 336 channel must be A, B, C, or D.")

        self.timeout_ms = int(timeout_ms)
        self.rm = None
        self.instrument = None

    def connect(self):
        self.rm = pyvisa.ResourceManager()
        self.instrument = self.rm.open_resource(self.resource_name)
        self.instrument.timeout = self.timeout_ms

        # Verified on the experiment PC:
        # LSCI,MODEL336,...
        return self.instrument.query("*IDN?").strip()

    def read_temperature_k(self) -> float:
        if self.instrument is None:
            raise RuntimeError("Lake Shore 336 is not connected.")

        # Read-only Kelvin measurement from the selected input.
        return float(
            self.instrument.query(f"KRDG? {self.channel}").strip()
        )

    def close(self):
        if self.instrument is not None:
            try:
                self.instrument.close()
            finally:
                self.instrument = None

        if self.rm is not None:
            try:
                self.rm.close()
            finally:
                self.rm = None

    shutdown = close
