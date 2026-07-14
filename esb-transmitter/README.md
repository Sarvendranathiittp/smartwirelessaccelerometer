# esb-transmitter

This folder contains the **Enhanced ShockBurst (ESB) Transmitter (PTX)** firmware. It is designed to run on the **Network Core (CPUNET)** of the **nRF5340** microcontroller.

Its role is to sample the **H3LIS331DL** accelerometer at high frequencies, assemble samples into 248-byte packets, and transmit them wirelessly with sub-milliamp power consumption.

## Technical Specifications
*   **Wireless Protocol:** Nordic Enhanced ShockBurst (ESB)
*   **Role:** Primary Transmitter (PTX)
*   **RF Channel:** Channel 78 (2478 MHz)
*   **Bitrate:** 2 Mbps
*   **Sampling Rate:** 1024 Hz (1 sample per 976 µs)
*   **Packet Interval:** ~25.6 Hz (triggered every 40 samples)