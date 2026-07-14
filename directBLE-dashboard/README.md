# directBLE-dashboard

This folder contains the **Smart Wireless Accelerometer Desktop Dashboard**. It is a standalone desktop application built using **Electron** that packages a high-performance **Web Bluetooth (BLE)** interface to visualize real-time vibration data.

Developed in collaboration between **IIT Tirupati (Smart Mechatronics Lab)** and **ISRO (RESPOND Programme)**, this dashboard allows laboratory operators to connect directly to the sensor node, calibrate offsets, and plot X/Y/Z high-frequency acceleration data.



## Prerequisites
*   **Node.js:** `>= 18.0.0`
*   **NPM:** `>= 9.0.0`

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Run in Development Mode
```bash
npm start
```

---

## Packaging the App for Distribution

This project uses `electron-builder` to bundle the app into single-file executables.

### Build for Windows (.exe)
```bash
npm run dist
```
The output portable executable will be created under:
`dist/Smart Wireless Acceleromater.exe`

### Build for Linux (.AppImage)
```bash
npm run dist
```
The output AppImage bundle will be created at:
`dist/Smart Wireless Acceleromater-1.0.0.AppImage`

*To make it executable on Linux:*
```bash
chmod +x "Smart Wireless Acceleromater-1.0.0.AppImage"
./"Smart Wireless Acceleromater-1.0.0.AppImage"
```

---

## Bluetooth troubleshooting (Linux)
If the application launches but fails to scan/discover Bluetooth devices:
1.  Check if the system Bluetooth service is active:
    ```bash
    sudo systemctl status bluetooth
    ```
2.  Ensure your user account belongs to the `bluetooth` group to access the hardware adapter:
    ```bash
    sudo usermod -a -G bluetooth $USER
    ```
    *(Log out and log back in to apply group changes).*
