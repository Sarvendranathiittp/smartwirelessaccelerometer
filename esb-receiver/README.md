# esb-receiver

This folder contains the **Enhanced ShockBurst (ESB) Receiver (PRX)** firmware. It is designed to run on the **Network Core (CPUNET)** of the **nRF5340** microcontroller.

Its primary role is to listen for incoming wireless vibration telemetry packets sent over the high-speed, low-latency ESB protocol, verify packet integrity, and forward the binary data stream over UART to a host PC.

---

## Technical Specifications
*   **Wireless Protocol:** Nordic Enhanced ShockBurst (ESB)
*   **Role:** Primary Receiver (PRX)
*   **RF Channel:** Channel 78 (carrier frequency of 2478 MHz)
*   **Data Rate:** 2 Mbps
*   **Interface to PC:** High-Speed UART (VCOM1 virtual COM port on the nRF5340 DK)

---

## Telemetry Packet Format (248 Bytes)
The receiver expects packets of exactly 248 bytes to fit the ESB payload limit (max 252 bytes):

| Field | Size (Bytes) | Description |
| :--- | :--- | :--- |
| `packet_counter` | 4 | Monotonically increasing sequence number |
| `sample_count` | 1 | Number of samples in the packet (typically 40) |
| `reserved` | 1 | Padding |
| `samples` | 240 | 40 samples × 3 axes (X, Y, Z) × 2 bytes (int16_t raw ADC values) |
| `crc16` | 2 | CCITT CRC-16 checksum for verification |

---

## UART Forwarding Protocol
To stream data to the PC dashboard, the receiver writes binary blocks over UART. Each block contains a 2-byte synchronization header followed by the raw packet data:

`[SYNC: 0xAA 0x55] [Raw ESB Packet Data (248 bytes)]` (Total: 250 bytes per packet)

At a 1024 Hz sampling rate and 40 samples per packet, the receiver streams ~25.6 packets per second (approx. 6400 bytes/sec).

---
