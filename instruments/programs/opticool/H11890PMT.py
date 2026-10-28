# -*- coding: utf-8 -*-
"""
Created on Sun Aug 10 11:47:06 2025

@author: Prof. Wang
"""

import ctypes
from ctypes import *
import time
import numpy as np

class H11890_INF(Structure):
    _fields_ = [
        ("hDeviceHandle", c_void_p),
        ("cSerialNumber", c_char * 10),
        ("IT", c_ulong),
        ("RN", c_ulong),
        ("HVON", c_int)
    ]

class HamamatsuH11890:
    
    def __init__(self, dll_path="h11890api.dll", device_index=0):
        try:
            dll_path = 'C:/Users/Public/OneDrive/Documents/quantummaterials/python_instrument_control/homemade_servers/'+dll_path
            self.lib = WinDLL(dll_path)
            self.devices = (H11890_INF * 16)()
            self.num_devices = 0
            self.device_index = device_index
            self.device = None
            self.handle = None
            self._setup_functions()
            self._open_devices()
            self._select_device()
            self.num_gates = 10
        except:
            print('make sure you have the right driver. Open Zadig and convert the driver if needed')
        
    def _select_device(self):
        if self.device_index >= self.num_devices:
            raise ValueError(f"Device index {self.device_index} out of range.")
        
        self.device = self.devices[self.device_index]
        self.handle = self.device.hDeviceHandle
        
        
    def _setup_functions(self):
        # Existing setup...
        self.lib.H11890ReadHV.argtypes = [c_void_p, POINTER(c_int)]
        self.lib.H11890ReadHV.restype = c_int

        self.lib.H11890ReadIT.argtypes = [c_void_p, POINTER(c_ulong)]
        self.lib.H11890ReadIT.restype = c_int

        self.lib.H11890ReadRN.argtypes = [c_void_p, POINTER(c_ulong)]
        self.lib.H11890ReadRN.restype = c_int

        self.lib.H11890OpenDevices.argtypes = [POINTER(H11890_INF)]
        self.lib.H11890OpenDevices.restype = c_ulong
    
        self.lib.H11890CloseDevices.argtypes = [POINTER(H11890_INF)]
        self.lib.H11890CloseDevices.restype = None
    
        self.lib.H11890ReadInf.argtypes = [H11890_INF]
        self.lib.H11890ReadInf.restype = c_int
    
        self.lib.H11890CountStart.argtypes = [c_void_p, c_int]
        self.lib.H11890CountStart.restype = c_int
    
        self.lib.H11890CountStop.argtypes = [c_void_p]
        self.lib.H11890CountStop.restype = c_int
    
        self.lib.H11890ReadData.argtypes = [c_void_p, POINTER(c_ulong), POINTER(c_ulong), POINTER(c_int)]
        self.lib.H11890ReadData.restype = c_ulong
    
        self.lib.H11890SetHV.argtypes = [c_void_p, c_int]
        self.lib.H11890SetHV.restype = c_int
    
        self.lib.H11890SetIT.argtypes = [c_void_p, c_ulong]
        self.lib.H11890SetIT.restype = c_int
    
        self.lib.H11890SetRN.argtypes = [c_void_p, c_ulong]
        self.lib.H11890SetRN.restype = c_int
        
        self.lib.H11890ReadData.argtypes = [c_void_p, POINTER(c_uint32), POINTER(c_uint32), POINTER(c_bool)]
        self.lib.H11890ReadData.restype = c_uint32
        
        # Already existing setters and other functions...
        
    def run_collection(self,gate_time_ms=200,num_gates=10,remove_first=True):
        time.sleep(.5) #ensures we don't collect old data. just gives the program a second to catch up
        if remove_first:
            num_gates += 1
        self.configure_gate(gate_time_ms, num_gates)
        # time.sleep(.2)
        self.start_counting()
        # time.sleep(.2)
        results = self.read_clean_data(remove_first)
        self.stop_counting()
        return results
    
    def quick_test(self,gate_time_ms=200,num_gates=10,remove_first=True):
        self.set_hv(True)
        counts = self.run_collection(gate_time_ms,num_gates,remove_first)
        self.set_hv(False)
        p=self.get_hv()
        if p == False:
            mean = np.mean(counts)
            print(mean)
            return mean
        else:
            print('hv on: ',p)

    def read_clean_data(self,remove_first=True):
        results=[]
        while True:
            try:
                gate, photons, is_old = self.read_data()
                # print(gate,photons,is_old)
                # print(gate,photons,is_old)
                if not is_old:
                    if remove_first:
                        remove_first = False
                    else:
                        results.append(photons) 
            except:
                break
        return results
    
    def read_data(self):
        
        gate_num = c_uint32()
        data_buf = c_uint32()
        old_flag = c_bool()
        
        result = self.lib.H11890ReadData(self.handle, byref(gate_num), byref(data_buf), byref(old_flag))
        result = ctypes.c_int32(result).value

        if result == -2:
            raise RuntimeError("Invalid device handle.")
        elif result == -3:
            raise RuntimeError("No more data.")
        elif result == -4:
            raise RuntimeError("BulkIn transfer failed.")
        elif result in (1, 15):
            return gate_num.value, data_buf.value, bool(old_flag.value)
        else:
            raise RuntimeError(f"Unexpected return value from DLL: {result}")

    def configure_gate(self, gate_time_ms=1000, num_gates=60):
        self.num_gates_raw = num_gates
        self.set_it(gate_time_ms)
        self.set_rn(num_gates)

    
    def get_hv(self):
        hv = c_int()
        success = self.lib.H11890ReadHV(self.handle, byref(hv))
        if not success:
            raise RuntimeError("Failed to read HV state.")
        return bool(hv.value)

    def get_it(self):
        it = c_ulong()
        success = self.lib.H11890ReadIT(self.handle, byref(it))
        if not success:
            raise RuntimeError("Failed to read integration time.")
        return it.value

    def get_rn(self):
        rn = c_ulong()
        success = self.lib.H11890ReadRN(self.handle, byref(rn))
        if not success:
            raise RuntimeError("Failed to read repeat number.")
        return rn.value
    
    def _open_devices(self):
        self.num_devices = self.lib.H11890OpenDevices(self.devices)
        if self.num_devices == 0:
            raise RuntimeError("No H11890 devices found.")

    def list_devices(self):
        info = []
        for i in range(self.num_devices):
            if self.lib.H11890ReadInf(self.devices[i]):
                serial = self.devices[i].cSerialNumber.decode('ascii').strip('\x00')
                info.append({
                    "index": i,
                    "serial": serial,
                    "IT": self.devices[i].IT,
                    "RN": self.devices[i].RN,
                    "HV": bool(self.devices[i].HVON)
                })
        return info

    def start_counting(self, correction=False):
        result = self.lib.H11890CountStart(self.handle, int(correction))
        # print(f"Start counting result: {result}")
        if not result:
            raise RuntimeError("Failed to start counting.")

    def stop_counting(self):
        result = self.lib.H11890CountStop(self.handle)
        if not result:
            raise RuntimeError("Failed to stop counting.")

    def set_hv(self, on=True):
        self.lib.H11890SetHV(self.handle, int(on))

    def set_it(self, ms=1000):
        self.lib.H11890SetIT(self.handle, ms)
        self.gate_time = ms

    def set_rn(self, rn=0xFFFFFFFF):
        self.lib.H11890SetRN(self.handle, rn)
        self.num_gates=rn

    def close(self):
        hv = self.get_hv()
        if hv:
            self.set_hv(False)
        self.lib.H11890CloseDevices(self.devices)

    def __del__(self):
        try:
            self.close()
        except:
            pass

if __name__ == "__main__":

    PMT = HamamatsuH11890()
    PMT.set_hv(on=True)
    PMT.run_collection(100,10,remove_first=False)
    PMT.set_hv(on=False)
    PMT.close()
