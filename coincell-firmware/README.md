# coincell-firmware

This folder contains the firmware for the **Precision Wireless Vibration Telemetry Node**. It runs on the application core of the **Nordic nRF5340** microcontroller and interfaces with the **STMicroelectronics H3LIS331DL** 3-axis accelerometer.

The firmware is designed with extreme focus on power optimization to run on a standard **CR2032 coincell battery (~225 mAh)** while maintaining a high-frequency sampling rate of **1024 Hz**.

---

## Hardware Configuration & Pin Mapping

The node uses an SPI interface (SPIM3) to communicate with the H3LIS331DL accelerometer. This is configured in the device overlay:

*   **SCK:** Port 1 Pin 15 (`P1.15`)
*   **MOSI:** Port 1 Pin 14 (`P1.14`)
*   **MISO:** Port 1 Pin 13 (`P1.13`)
*   **CS (Chip Select):** Port 1 Pin 12 (`P1.12`)

---

## Power Optimization Highlights

The system was optimized in five phases to reduce average continuous current draw from **~6.0 mA** down to **774 µA Idle / 2.54 mA Active**:

1.  **Console Logging Suppression:** All boot banners, printk engines, UART console drivers, and RTT backends are disabled in production to shut down the physical UART peripheral (saving ~2.71 mA).
2.  **SPI Migration & Runtime PM:** Migrating from I2C (400 kHz) to SPI (1 MHz SPIM3) reduced the sample read window from **230 µs** to **56 µs**. Power management (`CONFIG_PM_DEVICE_RUNTIME`) is used to gate the SPI controller and set pins to low-power states between reads.
3.  **DC-DC Switching Regulators:** Configured the internal high-efficiency DCDC regulators (`CONFIG_REGULATOR=y`) for both the application and network cores rather than default linear LDOs, increasing efficiency from 36% to >85%.
4.  **RTC0 LFCLK Clock Gating:** Samples are triggered at exactly 1024 Hz using `RTC0` (running off the 32.768 kHz Low Frequency Clock). The high-frequency oscillator (`HFCLK`) is kept off and gated until the SPI transfer is needed.
5.  **Dynamic BLE Connection & TX Power:** Configured optimized BLE connection intervals and TX power levels matching target distances.

---

## Codebase Architecture (Inside `src/`)

*   [main.c](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/main.c): Main application loop, system clock gating, and state machine transitions.
*   [accel_service.c](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/accel_service.c) / [accel_service.h](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/accel_service.h): Manages the custom Bluetooth Low Energy (BLE) GATT service, handles notifications, and packs 29-sample frames.
*   [flash_logger.c](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/flash_logger.c) / [flash_logger.h](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/flash_logger.h): Interface for writing events and telemetry data safely to internal flash.
*   [link_monitor.c](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/link_monitor.c) / [link_monitor.h](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/link_monitor.h): Handles BLE link state checks and handles disconnects.
*   [timer_hal.h](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/coincell-firmware/src/timer_hal.h): Hardware abstraction layer for low-level timing.

---

## Build and Flash Instructions

This project is built using the **nRF Connect SDK (NCS)** and **Zephyr RTOS**.

### 1. Build for Development / Debugging
```bash
west build -b nrf5340dk_nrf5340_cpuapp
```

### 2. Build for Production (Maximum Power Savings)
```bash
west build -b nrf5340dk_nrf5340_cpuapp -- -DOVERLAY_CONFIG=prj_production.conf
```

### 3. Flash the Board
```bash
west flash
```
