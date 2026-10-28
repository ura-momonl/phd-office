# -*- coding: utf-8 -*-
"""
Created on Fri Aug 15 14:31:34 2025
control instruments run by kcube (rotation mount, linear stage)
@author: Prof. Wang
"""


import numpy as np
import os
import time
import logging
from pylablib.devices import Thorlabs

class RotationMount():
    
    def __init__(self, serial_number):
        self.stage = Thorlabs.KinesisMotor(str(serial_number))
        self.steps_per_deg = 1919.59
        logging.info('Connected to Rotation Stage')
        
    def move_to(self,pos_deg,wait=True):
        pos_step = int(pos_deg*self.steps_per_deg)
        self.stage.move_to(pos_step)
        if wait:
            self.wait_for_stop()
    
    def move_by(self,move_deg):
        move_step = int(move_deg*self.steps_per_deg)
        self.stage.move_by(move_step)
    
    def get_pos(self):
        pos_steps = self.stage.get_position()
        pos_deg = pos_steps/self.steps_per_deg
        return pos_deg

    def home(self):
        self.stage.home()
    
    def close(self):
        self.stage.close()
    
    def wait_for_move(self):
        self.stage.wait_move()
        
    def wait_for_stop(self):
        self.stage.wait_for_stop()
    

        