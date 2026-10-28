#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Keithley 2450 SourceMeter, native 2450 SCPI command set (no 2400 emulation).

Split out on 2026-10-14 from KeithleySourceMeter.py (carterfox, 2025-08-08), whose
averaging routines are kept unchanged. This file talks to the 2450 through
PyMeasure's Keithley2450 class, so the front-panel command set must be the
native one (not 2400 emulation). Use Keithley2400.py for a 2400-family
instrument, or for a 2450 that is deliberately left in 2400 emulation.
"""

from pymeasure.adapters import VISAAdapter
from pymeasure.instruments.keithley import Keithley2450
import logging
import numpy as np
import time


class Keithley2450SourceMeter(Keithley2450):
    def __init__(self, resource_name):
        super().__init__(VISAAdapter(resource_name))
        self.model = "2450"
        idn = self.id
        if "2450" not in idn:
            logging.warning("Expected a Keithley 2450, instrument answered: %s", idn)
        # Unlike Keithley2400.py, source_voltage_range is NOT set here.

    def close(self):
        """Only closes the VISA connection. Does NOT change instrument state."""
        logging.info('disconnecting from keithley')
        self.adapter.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def configure_filter(self, filter_count, filter_type='REP', filter_state='ON', function='current'):
        """Sets the averaging filter of the current (default) or voltage measurement."""
        if function == 'current':
            self.current_filter_count = filter_count
            self.current_filter_type = filter_type
            self.current_filter_state = filter_state
        elif function == 'voltage':
            self.voltage_filter_count = filter_count
            self.voltage_filter_type = filter_type
        else:
            raise ValueError(f"Unsupported function: {function}")

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
