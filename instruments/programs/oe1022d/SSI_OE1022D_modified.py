#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Created on Thu Dec 12 11:27:27 2024

@author: carterfox

read data from lock in amp

Local additions are deliberately minimal:
    set_ref_slope()  - same RSLPD behavior as the user's successful code
    set_input_mode() - new differential-input control required by this setup

All pre-existing GitHub driver behavior is otherwise retained.
"""

import numpy as np
import os
import pyvisa
import time
import logging
import matplotlib.pyplot as plt


class LockInOE1022D():

    def __init__(self, resource_name="ASRL12::INSTR"):

        rm = pyvisa.ResourceManager()

        self.instrument = rm.open_resource(resource_name)

        self.instrument.baud_rate = 9600

        self.instrument.timeout = 2000

        self.instrument.read_termination = '\r'
        self.instrument.write_termination = '\r'

        self.sensitivities = np.array([
            "1 nV", "2 nV", "5 nV", "10 nV", "20 nV", "50 nV",
            "100 nV", "200 nV", "500 nV",
            "1 uV", "2 uV", "5 uV", "10 uV", "20 uV", "50 uV",
            "100 uV", "200 uV", "500 uV",
            "1 mV", "2 mV", "5 mV", "10 mV", "20 mV", "50 mV",
            "100 mV", "200 mV", "500 mV", "1 V"
        ])

        # R 为 RMS 幅值。
        self.parameters = np.array([
            "X", "Y", "R", "theta", "Frequency",
            "Xh1", "Yh1", "Rh1", "thetah1",
            "Xh2", "Yh2", "Rh2", "thetah2",
            "Noise", "A1", "A2", "A3", "A4",
            "E1", "E2", "E3", "E4"
        ])

        self.time_constants = np.array([
            '10 us', '30 us', '100 us', '300 us',
            '1 ms', '3 ms', '10 ms', '30 ms', '100 ms',
            '300 ms', '1 s', '3 s', '10 s', '30 s',
            '100 s', '300 s', '1000 s', '3000 s'
        ])

        self.R_chan = 1  # channels: 1 is channel A. 2 is channel B

        self.dR_chan = 2

        self.num_avgs = 150

        self.set_harmonic(self.dR_chan, 1, 2)

        self.sine_out_freq = 0

        logging.info("Conected to OE1022D LockIn")

    # --- Generic Commands ---

    def query(self, command):

        try:

            return self.instrument.query(command)

        except Exception as e:

            logging.error(f"Query error: {e}")

            return None

    def write(self, command):

        try:

            self.instrument.write(command)

        except Exception as e:

            logging.error(f"Write error: {e}")

    def close(self):

        try:

            self.instrument.close()

            logging.info("Disconnected from Lockin In ")

        except Exception as e:

            logging.error(f"Write error: {e}")

    def identify(self):
        return self.query("*IDND?").strip().replace('\x00', '')

    # --- Data Reading and storage ---

    def read_single(self, channel=1, param=2):

        """Read a single parameter (e.g., R, X, Y, theta)"""

        self.reset_buffer()

        raw = self.query(f"SNAPD? {channel},{param}")

        clean = float(raw.replace('\x00', '').strip())

        return clean

    def read_multiple(self, channel=1, params=[0, 1, 2, 3]):

        """Read multiple parameters simultaneously"""

        self.reset_buffer()

        param_str = ",".join(map(str, params))

        raw = self.query(f"SNAPD? {channel},{param_str}")

        clean = raw.replace('\x00', '').strip()

        return clean

    def read_average_dual(self, params=[0, 1, 2, 3], num_avgs=100, delay=0.01):

        """
        Read and average multiple measurements from both channels.

        Returns:
        - mean_R_chan, std_R_chan: mean and std for R channel parameters
        - mean_dR_chan, std_dR_chan: mean and std for dR channel parameters
        """

        data_R_chan = []

        data_dR_chan = []

        for _ in range(num_avgs):

            try:

                values_R_chan = self.read_multiple(self.R_chan, params)
                values_dR_chan = self.read_multiple(self.dR_chan, params)

                data_R_chan.append(
                    [float(v) for v in values_R_chan.strip().split(',')]
                )

                data_dR_chan.append(
                    [float(v) for v in values_dR_chan.strip().split(',')]
                )

            except Exception as e:

                logging.error(f"Error reading data: {e}")

            time.sleep(delay)

        mean_R_chan = np.mean(data_R_chan, axis=0) if data_R_chan else None

        std_R_chan = np.std(data_R_chan, axis=0) if data_R_chan else None

        mean_dR_chan = (
            np.mean(data_dR_chan, axis=0) if data_dR_chan else None
        )

        std_dR_chan = (
            np.std(data_dR_chan, axis=0) if data_dR_chan else None
        )

        pack = mean_R_chan, std_R_chan, mean_dR_chan, std_dR_chan

        return pack

    def reset_buffer(self, channels=[1, 2]):

        for chan in channels:

            self.write(f"RESTD {chan}")

    # --- Auto Configuration ---

    def auto_scale(self, channel=1):

        self.write(f"ASCLD {channel}")

    def auto_gain(self, channel=1):

        self.write(f"AGAND {channel}")

    def auto_reserve(self, channel=1):

        self.write(f"ARSVD {channel}")

    def auto_phase(self, channel=1):

        self.write(f"APHSD {channel}")

    def auto_phase_all(self):

        self.auto_phase(1)

        self.auto_phase(2)

    # --- Configuration ---

    def get_reference_source(self, channel=1):

        return self.query(
            f"FMODD? {channel}"
        ).strip().replace('\x00', '')

    def get_reference_frequency(self, channel=1):

        return float(
            self.query(f"FREQD? {channel}").strip().replace('\x00', '')
        )

    def get_phase_shift(self, channel=1):

        return float(
            self.query(f"PHASD? {channel}").strip().replace('\x00', '')
        )

    def get_sensitivity(self, channel=1):

        index = int(
            self.query(f"SENSD? {channel}").strip().replace('\x00', '')
        )

        if 0 <= index < len(self.sensitivities):

            return self.sensitivities[index]

        else:

            logging.warning(f"Invalid sensitivity index: {index}")

            return None

    def get_time_constant(self, channel=1):

        return int(
            self.query(f"OFLTD? {channel}").strip().replace('\x00', '')
        )

    def get_filter_slope(self, channel=1):

        return int(
            self.query(f"OFSLD? {channel}").strip().replace('\x00', '')
        )

    def get_sync_filter(self, channel=1):

        return bool(
            int(
                self.query(
                    f"SYNCD? {channel}"
                ).strip().replace('\x00', '')
            )
        )

    def get_harmonic(self, channel=1, slot=1):

        return int(
            self.query(
                f"HARMD? {channel},{slot}"
            ).strip().replace('\x00', '')
        )

    def get_sine_output(self, channel=1):

        try:

            amplitude = float(
                self.query(
                    f"SLVLD? {channel}"
                ).strip().replace('\x00', '')
            )

            offset = float(
                self.query(
                    f"SVLLD? {channel}"
                ).strip().replace('\x00', '')
            )

            waveform_type = int(
                self.query(
                    f"SWVTD? {channel}"
                ).strip().replace('\x00', '')
            )

            return {
                "amplitude_v": amplitude,
                "offset_v": offset,
                "waveform_type": waveform_type
            }

        except Exception as e:

            logging.error(f"Error reading SINE OUT: {e}")

            return None

    def set_reference_source(self, channel=1, mode=1):

        self.write(f"FMODD {channel},{mode}")

    def set_reference_frequency(self, channel=1, freq_hz=1000):

        self.write(f"FREQD {channel},{freq_hz}")

    def set_phase_shift(self, channel=1, degrees=0.0):

        self.write(f"PHASD {channel},{degrees}")

    def set_sensitivity(self, channel=1, sensitivity="5 mV"):

        """Index from 0 to 27 (see manual for mapping)"""

        if sensitivity in self.sensitivities:

            index = str(
                np.where(self.sensitivities == sensitivity)[0][0]
            )

            self.write(f"SENSD {channel},{index}")

        else:

            logging.warning(f"Invalid sensitivity: {sensitivity}")

    def set_time_constant(self, channel=1, index=13):

        self.write(f"OFLTD {channel},{index}")

    def set_filter_slope(self, channel=1, db_per_oct=3):

        self.write(f"OFSLD {channel},{db_per_oct}")

    def set_sync_filter(self, channel=1, enable=True):

        self.write(f"SYNCD {channel},{1 if enable else 0}")

    def set_harmonic(self, channel=1, slot=1, order=3):

        self.write(f"HARMD {channel},{slot},{order}")

    def set_sine_output(
        self,
        channel=1,
        amplitude_v=1.0,
        offset_v=0.0,
        waveform_type=0,
    ):

        """
        Configure the SINE OUT signal using SLVLD, SVLLD, and SWVTD commands.

        Parameters:
        channel (int): Channel number (1 or 2)
        amplitude_v (float): Peak amplitude in volts
        offset_v (float): DC offset in volts
        waveform_type (int): 0 = sine, 1 = square, 2 = triangle (if supported)
        """

        try:

            self.write(f"SLVLD {channel},{amplitude_v}")

            self.write(f"SVLLD {channel},{offset_v}")

            self.write(f"SWVTD {channel},{waveform_type}")

        except Exception as e:

            logging.error(f"Error configuring SINE OUT: {e}")

    # --- Local additions: copied/added without changing existing methods ---

    def set_ref_slope(self, channel=1, edge=1):
        """RSLPD i,j; same behavior as the user's successful driver."""
        self.write(f"RSLPD {int(channel)},{int(edge)}")

    def set_input_mode(self, channel, mode):
        """
        Set signal input mode.

        Only the newly required, verified A-B differential mapping is added.
        Existing GitHub behavior is otherwise untouched.
        """
        mode_name = str(mode).strip().lower()
        if mode_name not in {"differential", "diff", "a-b"}:
            raise ValueError(
                "Only the verified A-B differential mapping is implemented."
            )
        self.write(f"ISRCD {int(channel)},1")

    def read_continuous(
        self,
        channel=1,
        param=2,
        interval=0.01,
        save_to=None,
    ):

        self.reset_buffer()

        plt.ion()

        fig, ax = plt.subplots(figsize=(8, 4))

        ax.set_xlabel("Time (s)")

        ax.set_ylabel(self.parameters[param])

        line, = ax.plot([], [], 'b.-')

        fig.canvas.manager.window.move(1920, 100)

        values, times = [], []

        start_time = time.time()

        try:

            while True:

                val = self.read_single(channel=channel, param=param)

                times.append(time.time() - start_time)

                values.append(val)

                line.set_data(times, values)

                ax.relim()

                ax.autoscale_view()

                fig.canvas.draw()

                fig.canvas.flush_events()

                time.sleep(interval)

        except KeyboardInterrupt:

            plt.ioff()

            if save_to is not None:

                with open(save_to, 'a') as file:

                    file.write('#' + self.parameters[param] + '\n')

                    for val in values:

                        file.write(str(val) + '\n')
