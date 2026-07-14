# esp32-receiver-dac8568

This folder contains the ESP32 receiver firmware that interfaces with the **TI DAC8568 (16-bit, SPI-controlled high-performance DAC)**. 

The firmware acts as a **Bluetooth Low Energy (BLE) Client** that connects to the wireless accelerometer node, retrieves the high-frequency vibration data, runs a real-time digital upsampling filter, and outputs three channels of high-resolution analog signals (representing X, Y, and Z acceleration).

---

## Architecture & Signal Flow

```mermaid
flowchart LR
    SensorNode[BLE Sensor Node] -- "29-sample BLE packets (~35Hz)" --> ESP32[ESP32 NimBLE Client]
    ESP32 --> PreBuf[Pre-Buffer Queue: 150ms]
    PreBuf --> PolyFIR[3x Polyphase FIR Filter]
    PolyFIR -- "3072 Hz Clock" --> DAC["TI DAC8568 (16-Bit, SPI)"]
    DAC --> Analog[X, Y, Z Analog Waveforms]
```

### 1. BLE Reception
The ESP32 uses the **NimBLE stack** (lightweight BLE host) to search for and connect to `ISRO_AccelSensor`. It subscribes to data notifications, receiving accelerometer packets containing **29 samples** each.

### 2. Playback & Upsampling Engine
*   **3x Polyphase Interpolation:** To eliminate quantization stair-step noise, the incoming **1024 Hz** signal is upsampled 3x to **3072 Hz** (yielding an output timer trigger interval of exactly **325.5 µs**).
*   **Kaiser Window FIR Filter:** A 24-tap windowed sinc filter (Beta = 8.0, cut-off at 1/3 Nyquist) is split into 3 polyphase branches (8 taps per branch) to run the upsampler with very low CPU latency.
*   **Jitter Compensation:** Features a **150 ms pre-buffering** buffer queue to absorb BLE packet arrival jitter and prevent audio-style buffer underflows.
*   **GPTimer Interrupt:** A hardware timer ISR triggers at 3072 Hz to compute the next upsampled sample and command the DAC.

### 3. DAC8568 Driver (High-Precision 16-Bit SPI)
The `dac8568.c` / `dac_driver.c` driver controls the TI DAC8568 16-bit digital-to-analog converter over an **SPI interface**. Compared to the 12-bit DAC7578 version, this 16-bit resolution provides significantly finer voltage steps and a much higher signal-to-noise ratio (SNR) in the reconstructed analog waveforms.

---

## Getting Started

This project is built using the **Espressif IoT Development Framework (ESP-IDF)** version 5.x.

### 1. Set Up Environment
Configure your local shell for ESP-IDF:
```bash
. $HOME/esp/esp-idf/export.sh
```

### 2. Configure Pin mappings
Run the menuconfig utility to adjust SPI pins (MISO, MOSI, SCLK, CS) if necessary:
```bash
idf.py menuconfig
```

### 3. Build & Flash
```bash
idf.py build
idf.py -p <PORT> flash monitor
```
*(Replace `<PORT>` with your ESP32's COM port).*
