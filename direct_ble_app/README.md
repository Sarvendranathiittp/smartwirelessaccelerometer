# direct_ble_app

This folder contains the **Smart Wireless Accelerometer Mobile Application**. Built using **Flutter**, it provides a cross-platform (Android, iOS, Web, Desktop) client to connect directly to the accelerometer sensor nodes via **Bluetooth Low Energy (BLE)**.

The app supports real-time data ingestion, high-speed charting via custom canvas painters, digital signal processing (DSP) operations, and sensor calibration.

---

## Features
*   **Real-Time Data Streaming:** Connects to `ISRO_AccelSensor` and streams 3-axis accelerometer data at high sample rates with sub-millisecond precision.
*   **Stationary Noise Calibration:** Analyzes background vibrations over a 10-second static window to establish a noise floor baseline for Signal-to-Noise Ratio (SNR) calculations.
*   **Zero-G Offset Tare:** Calibrates out structural mounting offsets so that the X/Y axes read `0.0g` and the Z-axis reads `1.0g` when stationary.
*   **High-Performance Custom Charts:** Avoids heavy widget builds by using custom canvas painters (`chart_painters.dart`) to render incoming vibration paths at 60 FPS.
*   **On-the-Fly DSP Engine:** Contains filtering algorithms, moving average smoothing, and peak-to-peak amplitude estimations.

---

## Codebase Architecture (Inside `lib/`)

*   [main.dart](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/lib/main.dart): App entry point, sets up global themes and initial screens.
*   [ble_manager.dart](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/lib/ble_manager.dart): The core BLE engine. Manages device scanning, MTU negotiation, GATT service discovery, byte stream decoding, and CRC16 verification.
*   [dsp_engine.dart](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/lib/dsp_engine.dart): Houses the mathematical routines for real-time sensor filtering, baseline offsets, and SNR calculations.
*   [chart_painters.dart](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/lib/chart_painters.dart): Implements high-performance custom canvas painters to draw real-time signals without UI lag.
*   [splash_screen.dart](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/lib/splash_screen.dart): Renders the initial loading UI.

---

## Getting Started

### Prerequisites
Make sure you have the [Flutter SDK](https://flutter.dev/docs/get-started/install) installed and configured on your path.

### 1. Install Dependencies
Navigate to this directory and fetch the pub packages:
```bash
flutter pub get
```

### 2. Run the App (Live Development Mode)
Ensure you have a simulator running or a physical device connected via USB debugging:
```bash
flutter run
```
*Tip: Use `r` in your terminal to trigger a **Hot Reload** or `R` for a **Hot Restart**.*

### 3. Compile a Standalone Android APK
To compile an installable release bundle:
```bash
flutter build apk --release
```
The output file will be saved to:
`build/app/outputs/flutter-apk/app-release.apk`

---

## Calibration Guide
Refer to the [MOBILE_APP_GUIDE.md](file:///C:/Users/DELL/Downloads/SmartWirelessAccelerometer/direct_ble_app/MOBILE_APP_GUIDE.md) file inside this directory for detailed instructions on configuring USB debugging on Android devices, setting up sensor calibration, and conducting SNR baseline captures.
