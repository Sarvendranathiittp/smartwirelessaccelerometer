# Mobile App Deployment & Testing Guide

This guide explains how to deploy, test, and run the newly created **Smart Accelerometer BLE Application** on your physical Android device.

---

## 1. Preparing Your Android Phone for Testing

To load the app from your Linux PC onto your phone, you need to enable **USB Debugging**:

1.  **Open Settings**: Go to **Settings** $\rightarrow$ **About Phone** (or **System** $\rightarrow$ **About Device**).
2.  **Enable Developer Mode**: Tap on the **Build Number** 7 times consecutively. A toast notification will say: *"You are now a developer!"*
3.  **Enable USB Debugging**:
    *   Go back to the main Settings menu and search for **Developer Options** (or find it under **System** $\rightarrow$ **Developer Options**).
    *   Find the **USB Debugging** toggle and switch it **ON**.
4.  **Connect via USB**: Connect your phone to your PC using a USB data cable.
5.  **Authorize connection**: Look at your phone's screen. A popup will ask: *"Allow USB Debugging?"* Check the box for *"Always allow from this computer"* and tap **Allow**.

---

## 2. Running the App in Live Development Mode

Running in live mode allows you to see prints, capture logs, and test in real-time.

1.  **Check Connected Devices**:
    Open a terminal on your computer and run:
    ```bash
    flutter devices
    ```
    Your connected phone should appear in the listed devices.

2.  **Run the App**:
    In the `/home/smalab/ISRO-Project/New_project-demo/direct_ble_app` folder, run:
    ```bash
    flutter run
    ```
    This compiles the app, pushes it to your phone, and launches it. You can press `r` in the terminal to **Hot Reload** code changes instantly or `R` to **Hot Restart** the state machine.

---

## 3. Compiling an Installable APK (Standalone Installation)

If you want to compile a standalone installable file (`.apk`) that you can share or install directly without having the phone connected to the computer:

1.  **Build a Release APK**:
    In your terminal, run:
    ```bash
    flutter build apk --release
    ```
2.  **Locate the APK File**:
    Once compiled successfully, the output file will be saved at:
    `build/app/outputs/flutter-apk/app-release.apk`
3.  **Install on Phone**:
    You can transfer this file to your phone (via USB, email, Google Drive, etc.) and tap on it in the file manager to install. *(Note: You might need to allow installation from "Unknown Sources" when prompted).*

---

## 4. BLE Connection & Calibration

### A. Scanning & Connecting
1.  Turn on **Bluetooth** and **Location Services** on your phone.
2.  Launch the app and tap **CONNECT** on the control deck.
3.  The app will search for advertisements from `ISRO_AccelSensor`. Once detected, it connects and automatically starts receiving data notifications.

### B. Stationary Baseline Noise Calibration
*   **Purpose**: Records baseline sensor variance when static to calculate the signal-to-noise ratio (SNR) correctly during dynamic runs.
*   **Execution**: Mount the sensor rigidly on a stationary, vibration-free surface. Tap **Calibrate Noise** on the SNR card. Keep it still for the 10-second countdown.

### C. Zero-g Offset Tare Calibration
*   **Purpose**: Calibrates out any structural misalignment offsets so X/Y read exactly `0.0g` and Z reads exactly `1.0g` when stationary.
*   **Execution**: Place the sensor flat and still. Tap **OFFSET CALIBRATION** on the control deck and let the 3-second countdown complete.
