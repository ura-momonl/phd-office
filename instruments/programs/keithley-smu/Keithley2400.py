#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Keithley 2400-family SourceMeter, 2400 SCPI command set.

Split out on 2026-10-14 from KeithleySourceMeter.py (carterfox, 2025-08-08); the
constructor behaviour (:TRAC:POIN? check, 210 V source range) and the averaging
routines are kept as in that file, with the broken logging.ERROR(...) calls
replaced by logging.error(...) and an identity warning added.
A 2450 can also be driven by this file only if it is set to 2400 emulation on
the front panel; for a 2450 in native mode use Keithley2450.py.
"""

from pymeasure.adapters import VISAAdapter
from pymeasure.instruments.keithley import Keithley2400
import logging
import numpy as np
import time


class Keithley2400SourceMeter(Keithley2400):
    def __init__(self, resource_name):
        super().__init__(VISAAdapter(resource_name))
        self.model = "2400"
        idn = self.id
        if "MODEL 24" not in idn.upper():
            logging.warning("Expected a Keithley 2400-family instrument, instrument answered: %s", idn)
        try:
            self.ask(":TRAC:POIN?")
        except Exception:
            logging.error('Instrument does not answer 2400 commands. A 2450 must be in 2400 emulation mode (set manually on the front panel).')
        try:
            self.source_voltage_range = 210
        except Exception:
            logging.error("Error setting source voltage range to 210 V")

    def close(self):
        """Only closes the VISA connection. Does NOT change instrument state."""
        logging.info('disconnecting from keithley')
        self.adapter.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def configure_filter(self, filter_count, filter_type='REP', filter_state='ON'):
        self.filter_count = filter_count
        self.filter_type = filter_type
        self.filter_state = filter_state

    def wait_complete(self):
        self.ask("*OPC?")

    def measure_current_avg(self, num_points: int, nplc=0.5, absolute=False, current_max=None):
        """Measures current over `num_points` samples using PyMeasure.
        :param num_points: Number of measurement points to average
        :param nplc: Number of Power Line Cycles (integration time)
        :param absolute: If True, calculates the average of absolute values
        :param current_max: Maximum current range (Amps). If None, uses auto-range.
        """
        if current_max is not None: self.measure_current(nplc=nplc, auto_range=False, current=current_max)
        else: self.measure_current(nplc=nplc, auto_range=True)

        readings = np.empty(num_points)
        for i in range(num_points):
            time.sleep(0.1)
            readings[i] = self.current

        if absolute:
            return float(np.average(np.abs(readings)))
        else:
            return float(np.average(readings))

    def measure_voltage_avg(self, num_points: int, nplc=0.5, absolute=False, voltage_max=None):
        """Measures voltage over `num_points` samples using PyMeasure.
        :param num_points: Number of measurement points to average
        :param nplc: Number of Power Line Cycles (integration time)
        :param absolute: If True, calculates the average of absolute values
        :param voltage_max: Maximum voltage range (Volts). If None, uses auto-range.
        """
        if voltage_max is not None: self.measure_voltage(nplc=nplc, auto_range=False, voltage=voltage_max)
        else: self.measure_voltage(nplc=nplc, auto_range=True)

        readings = np.empty(num_points)
        for i in range(num_points):
            time.sleep(0.1)
            readings[i] = self.voltage

        if absolute:
            return float(np.average(np.abs(readings)))
        else:
            return float(np.average(readings))
