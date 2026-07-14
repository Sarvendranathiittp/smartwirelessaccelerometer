# esp32-transmitter

This folder contains the **ESP32 Wireless Accelerometer Transmitter** firmware. It acts as the wireless sensor node, reading high-g acceleration data from the **H3LIS331DL** sensor and broadcasting it over **Bluetooth Low Energy (BLE)**.

The project is implemented using the **ESP-IDF framework** and utilizes the lightweight **NimBLE BLE stack**.

---

## Technical Specifications & Features
*   **Sensor Interface:** ST H3LIS331DL over I2C.
*   **Default Sampling Rate:** 1000 Hz (using ESP32 hardware GPTimer periodic interrupts).
*   **I2C Pins:** SDA = Pin 11 (`GPIO11`), SCL = Pin 12 (`GPIO12`) at 400 kHz.
*   **High-Speed Queueing:** Implements an internal circular buffer of **16,384 samples** to prevent data drops during BLE transmission bottlenecks.
*   **BLE GATT Services:** Offers custom characteristics for accelerometer data streams, sampling rate parameters, TX power configurations, and sensor metadata.

---

## Data Packet Format (BLE Notifications)
Accelerometer samples are packed into a custom binary struct of **29 samples** to fit within the BLE Maximum Transmission Unit (MTU):

*   **Sample Structure (8 Bytes):**
    `[rel_timestamp_ms (2B)] [accel_x (2B)] [accel_y (2B)] [accel_z (2B)]`
*   **Data Notification Packet (239 Bytes):**
    `[packet_counter (4B)] [first_sample_offset (1B)] [29 samples x 8B = 232B] [crc16 (2B)]`



## Getting Started

This project is built using the **Espressif IoT Development Framework (ESP-IDF)** version 5.x.

### 1. Set Up Environment
Configure your local shell for ESP-IDF:
```bash
. $HOME/esp/esp-idf/export.sh
```

### 2. Build & Flash
```bash
idf.py build
idf.py -p <PORT> flash monitor
```
*(Replace `<PORT>` with your ESP32's COM port).*
