# Smart Wireless Accelerometer (Vibration Telemetry System)

This repository contains the full source code for the **Smart Wireless Accelerometer** system, a high-precision, low-power vibration telemetry platform. 

The project was developed as a joint collaboration under the **ISRO RESPOND Programme** by the **IIT Tirupati Smart Mechatronics Lab (SMA Lab)**.

---

## System Architecture

The project supports two main communication pipelines to stream and reconstruct high-frequency, high-g acceleration data (measured using the **STMicroelectronics H3LIS331DL** sensor):

```mermaid
flowchart TD
    subgraph Transmitter Node Options
        A[nRF5340 Coincell Node]
        B[ESP32 Transmitter Node]
    end

    subgraph Pipeline 1: Bluetooth Low Energy
        A -- BLE Notifications --> C1[ESP32 DAC Receivers]
        B -- BLE Notifications --> C1
        A -- BLE Web API --> C2[Electron Desktop Dashboard]
        B -- BLE Web API --> C2
        A -- BLE Mobile SDK --> C3[Flutter Mobile App]
        B -- BLE Mobile SDK --> C3
        
        C1 --> |I2C| D1[TI DAC7578 12-Bit DAC]
        C1 --> |SPI| D2[TI DAC8568 16-Bit DAC]
        D1 --> |Smooth Analog| E1[Analog Vibration Reconstruction]
        D2 --> |Smooth Analog| E1
    end

    subgraph Pipeline 2: Enhanced ShockBurst (ESB)
        A -- Proprietary ESB --> F1[nRF5340 Network Core Receiver]
        F1 --> |High-Speed UART| F2[Host PC Serial Ingest]
    end
    
    style Pipeline 1: Bluetooth Low Energy fill:#e1f5fe,stroke:#03a9f4,stroke-width:2px
    style Pipeline 2: Enhanced ShockBurst (ESB) fill:#ede7f6,stroke:#673ab7,stroke-width:2px
```

---

## Directory Navigation

Here is an overview of the components available in this repository:

### 1. Sensor Nodes (Transmitters)
*   [coincell-firmware](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware): Production-grade, ultra-low-power BLE firmware running on the nRF5340 App Core. Features advanced power gating (774 µA idle draw).
*   [esb-transmitter](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/esb-transmitter): nRF5340 Network Core firmware streaming 1024 Hz data using the proprietary Nordic Enhanced ShockBurst (ESB) protocol.
*   [esp32-transmitter](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/esp32-transmitter): Alternative ESP32 BLE transmitter firmware with high-capacity circular queue buffering.

### 2. Receiver & Playback Nodes
*   [esb-receiver](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/esb-receiver): nRF5340 Network Core receiver that listens for ESB packets and streams raw binary data directly over UART VCOM1 to a host PC.
*   [esp32-receiver-dac7578](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/esp32-receiver-dac7578): ESP32 receiver that reads BLE notifications, runs a **3x Polyphase Kaiser window FIR upsampler** (from 1024 Hz to 3072 Hz), and outputs analog signals via the **12-bit I2C DAC7578**.
*   [esp32-receiver-dac8568](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/esp32-receiver-dac8568): Identical to the DAC7578 receiver but interfaces with the high-precision **16-bit SPI DAC8568** for maximum analog fidelity.

### 3. Visualization & Analysis Applications
*   [directBLE-dashboard](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/directBLE-dashboard): Standalone offline-capable **Electron** desktop application featuring automatic Bluetooth pairing, control options, and real-time Chart.js telemetry charts.
*   [direct_ble_app](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app): Cross-platform **Flutter** mobile application providing device discovery, DSP filters, zero-g calibration, and stationary noise floor calibration.

---

## Hardware Documentation
A detailed wiring diagram showing the microcontrollers, DACs, and accelerometer pin connections is available in:
*   [peripheral_connections.pdf](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/peripheral_connections.pdf)
