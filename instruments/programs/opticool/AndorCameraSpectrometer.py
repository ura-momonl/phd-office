import numpy as np
from pyAndorSDK2 import atmcd, atmcd_codes, atmcd_errors
import logging
import time
import pylablib as pll
from pylablib.devices import Andor
from tqdm import tqdm

class AndorCamSpec:
    def __init__(self, exposure=1.0, temperature=-85, accumulations=3, excitation_nm=632.8):
        pll.par["devices/dlls/andor_sdk2"] = 'C:/Program Files/Andor SDK'
        pll.par["devices/dlls/andor_shamrock"] = 'C:/Program Files/Andor SDK/Shamrock64'
        
        self.sdk = atmcd()  # Load the atmcd library
        self.codes = atmcd_codes
        ret = self.sdk.Initialize("") 
        (ret, iSerialNumber) = self.sdk.GetCameraSerialNumber()
        
        ret = self.sdk.CoolerON()
        ret = self.sdk.SetTemperature(temperature)
        # ret = self.sdk.SetCoolerMode(1)
        # print(ret)
        # ret = self.sdk.SetAcquisitionMode(self.codes.Acquisition_Mode.SINGLE_SCAN)
        ret = self.sdk.SetAcquisitionMode(self.codes.Acquisition_Mode.ACCUMULATE)
        ret = self.sdk.SetReadMode(self.codes.Read_Mode.FULL_VERTICAL_BINNING)
        ret = self.sdk.SetTriggerMode(self.codes.Trigger_Mode.INTERNAL)
        ret = self.sdk.SetVSSpeed(2)
        (ret, self.xpixels, self.ypixels) = self.sdk.GetDetector()
        
        self.spec = Andor.ShamrockSpectrograph(0)
        self.excitation_nm = excitation_nm
        self.central_wavelength = 644.22e-9
        self.grating = 3
        self.configure_spectrometer(grating=self.grating, central_wl=self.central_wavelength)
        self.accumulations = accumulations
        
        ret, START_TEMP = self.sdk.GetTemperature()    
        TARGET_TEMP = -79
        progress_bar = tqdm(total=START_TEMP - TARGET_TEMP,
        bar_format="{l_bar}{bar}",leave=False)
        while True:
            ret,temp = self.sdk.GetTemperature()
            clamped_temp = min(max(temp, TARGET_TEMP), START_TEMP)
            cooled = START_TEMP - clamped_temp
            progress_bar.n = cooled
            progress_bar.set_description(f"Temp: {temp:.1f}°C / Target: {TARGET_TEMP}°C")
            progress_bar.refresh()
            if temp <= TARGET_TEMP:
                break
            time.sleep(1)
        logging.info('Connected to Andor CamSpec. Temp = {}'.format(temp))

    def close(self):
        self.spec.close()
        logging.info('Disconnecting from Spectrometer')
        ret, START_TEMP = self.sdk.GetTemperature()    
        TARGET_TEMP = -20
        progress_bar = tqdm(total=TARGET_TEMP - START_TEMP,
        bar_format="{l_bar}{bar}",leave=False)
        ret=self.sdk.CoolerOFF()
        while True:
            ret,temp = self.sdk.GetTemperature()
            clamped_temp =min(max(temp, START_TEMP), TARGET_TEMP)
            warmed = clamped_temp - START_TEMP
            progress_bar.n = warmed
            progress_bar.set_description(f"Temp: {temp:.1f}°C / Target: {TARGET_TEMP}°C")
            progress_bar.refresh()
            if temp >= TARGET_TEMP:
                break
            time.sleep(1)
        logging.info('Disconnecting from Camera. Temperature = {}'.format(temp))
        self.sdk.ShutDown()
        
    def set_exposure(self,exposure_time):
        self.sdk.SetExposureTime(exposure_time)
        
    def acquire_image(self):
        self.sdk.PrepareAcquisition()
        self.sdk.StartAcquisition()
        self.sdk.WaitForAcquisition()
        ret, fullFrameBuffer = self.sdk.GetMostRecentImage(self.xpixels)
        self.sdk.AbortAcquisition()
        return np.ctypeslib.as_array(fullFrameBuffer)
    
    def acquire_multiple_images(self,num_images):
        images =[]
        for i in range(num_images):
            data = self.acquire_image()
            images.append(data)
        return images
    
    def acquire_accumulation(num_images):
        
        print('test')
        return 
    
    def configure_spectrometer(self, grating=3, central_wl=644.21e-9):
        self.spec.set_grating(grating)
        self.spec.set_wavelength(central_wl)
        re,detx,dety= self.sdk.GetDetector()
        (ret,xsize,ysize) = self.sdk.GetPixelSize()
        self.spec.set_pixel_width(xsize)
        self.spec.set_number_pixels(detx)
        # self.wavelengths = self.spec.get_calibration()
        # self.raman_shifts = self.wavelength_to_raman_shift(self.wavelengths)
        # self.spec.set_slit_width(slit_width)
    
    def wavelength_to_raman_shift(self, wavelengths_nm):
        excitation_cm = 1e7 / self.excitation_nm
        measured_cm = 1e7 / np.array(wavelengths_nm)
        return excitation_cm - measured_cm

        
    # def remove_spikes(self,data):
        #insert later... 
        # return filtered_data

    
    
    
    
