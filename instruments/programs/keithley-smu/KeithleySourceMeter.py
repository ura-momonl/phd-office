#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Fri Aug  8 21:44:12 2025

@author: carterfox
"""

from pymeasure.adapters import VISAAdapter
from pymeasure.instruments.keithley import Keithley2400, Keithley2450
import logging
import numpy as np
import time

def KeithleySourceMeter(resource_name, model="2450"):
    adapter = VISAAdapter(resource_name)
    
    allowed_models = ['2450','2400']
    
    if model in allowed_models:
        base_class = Keithley2400
    else:
        logging.ERROR('model not allowed')
    
    class Keithley(base_class):
        def __init__(self):
            super().__init__(adapter)
            self.model = model
            try:
                self.ask(":TRAC:POIN?")
            except Exception as e:
                logging.ERROR('Instrument must be in 2400 emulation mode. Manually set it in settings')
            try:
                self.source_voltage_range=210
            except:
                vrange = self.source_voltage_range
                logging.ERROR(f"Error setting source voltage range. Range is {vrange} V")                

        def close(self):
            """Only closes the VISA connection. Does NOT change instrument state."""
            logging.info('disconnecting from keithley')
            self.adapter.connection.close()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            self.close()
            
        def configure_filter(self,filter_count,filter_type='REP',filter_state='ON'):
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
            # 1. Configure measurement parameters using standard PyMeasure API
            if current_max is not None: self.measure_current(nplc=nplc, auto_range=False, current=current_max)
            else: self.measure_current(nplc=nplc, auto_range=True)
        
            # 2. Collect readings into a NumPy array
            readings = np.empty(num_points)
            for i in range(num_points): 
                time.sleep(0.1)
                readings[i] = self.current
        
            # 3. Compute absolute or signed average
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
            # 1. Configure measurement parameters using standard PyMeasure API
            if voltage_max is not None: self.measure_voltage(nplc=nplc, auto_range=False, voltage=voltage_max)
            else: self.measure_voltage(nplc=nplc, auto_range=True)
        
            # 2. Collect readings into a NumPy array
            readings = np.empty(num_points)
            for i in range(num_points):
                time.sleep(0.1)
                readings[i] = self.voltage
        
            # 3. Compute absolute or signed average
            if absolute:
                return float(np.average(np.abs(readings)))
            else:
                return float(np.average(readings))
        
    return Keithley()
        
        # def configure_filter(self, function="current", count=10, filter_type="REP", enable=True):
        #     """
        #     Configures filtering for voltage or current measurements.
        
        #     Parameters:
        #         function: "current" or "voltage"
        #         count: number of samples to average (1–100)
        #         filter_type: "MOV" (moving average) or "REP" (repeat)
        #         enable: True to enable filtering, False to disable
        #     """
        #     func = function.lower()
        #     if self.model == "2400":
        #         self.write(f":SENS:AVER:TCON {filter_type}")
        #         self.write(f":SENS:AVER:COUNT {count}")
        #         self.write(f":SENS:AVER {'ON' if enable else 'OFF'}")
        #     elif self.model == "2450":
        #         if func == "current":
        #             self.write(f":SENS:CURR:AVER:TCON {filter_type}")
        #             self.write(f":SENS:CURR:AVER:COUNT {count}")
        #             self.write(f":SENS:CURR:AVER {'ON' if enable else 'OFF'}")
        #         elif func == "voltage":
        #             self.write(f":SENS:VOLT:AVER:TCON {filter_type}")
        #             self.write(f":SENS:VOLT:AVER:COUNT {count}")
        #             # No ON/OFF control for voltage filtering in 2450
        #         else:
        #             raise ValueError(f"Unsupported function: {function}")
        #     else:
        #         raise ValueError(f"Unsupported model: {self.model}")
                
        # def query_filter(self, function="current"):
        #     """
        #     Queries the current filter settings for voltage or current.
        #     Returns a dict with type, count, and state (if available).
        #     """
        #     func = function.lower()
        #     if self.model == "2400":
        #         ftype = self.filter_type
        #         count = self.filter_count
        #         state = self.filter_state
        #         return {"type": ftype, "count": count, "state": state}
        #     elif self.model == "2450":
        #         if func == "current":
        #             ftype = self.current_filter_type
        #             count = self.current_filter_count
        #             state = self.current_filter_state
        #             return {"type": ftype, "count": count, "state": state}
        #         elif func == "voltage":
        #             ftype = self.voltage_filter_type
        #             count = self.voltage_filter_count
        #             return {"type": ftype, "count": count}
        #         else:
        #             raise ValueError(f"Unsupported function: {function}")
        #     else:
        #         raise ValueError(f"Unsupported model: {self.model}")

