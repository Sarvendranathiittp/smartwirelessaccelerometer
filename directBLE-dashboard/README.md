# Smart Wireless Acceleromater Desktop Dashboard

This is the native desktop application wrapper for the ISRO Smart Wireless Accelerometer. It packages the high-performance Web Bluetooth dashboard into a standalone desktop application using **Electron**.

## Features
- **100% Offline-Capable:** All libraries (like Chart.js) and assets are bundled locally. No internet access required.
- **Cross-Platform:** Can be compiled into a Windows portable executable (`.exe`) or a Linux standalone bundle (`.AppImage`).
- **Auto-Pairing:** Automatically handles Web Bluetooth device discovery in the main process to connect to the accelerometer instantly.
- **Branded Native Window:** Runs in a dedicated app window without web browser borders or menus.

---

## Prerequisites
Ensure you have **Node.js** and **NPM** installed on your development machine.
- Node.js version: `>= 18.0.0`
- NPM version: `>= 9.0.0`

---

## How to Setup & Run locally

1. **Install Dependencies:**
   Navigate to this directory and install the required modules:
   ```bash
   cd directBLE-dashboard
   npm install
   ```

2. **Run in Development Mode:**
   Launch the desktop application window for testing:
   ```bash
   npm start
   ```

---

## How to Package the App for Users

### 1. Build for Linux (AppImage)
You can build the Linux AppImage directly from this Linux machine:
```bash
npm run dist
```
Once completed, the output bundle will be created at:
`dist/Smart Wireless Acceleromater-1.0.0.AppImage`

*Note: To run the AppImage, right-click the file -> Properties -> Permissions -> Check "Allow executing file as program", or run:*
```bash
chmod +x "Smart Wireless Acceleromater-1.0.0.AppImage"
./"Smart Wireless Acceleromater-1.0.0.AppImage"
```

### 2. Build for Windows (.exe)
To generate the portable Windows executable:
1. Copy this project folder (`directBLE-dashboard`) to a Windows machine.
2. Open a command prompt/powershell inside the folder.
3. Install dependencies and build:
   ```cmd
   npm install
   npm run dist
   ```
4. The output `.exe` will be located under the `dist/` directory.

---

## Troubleshooting Bluetooth on Linux
If the app opens but cannot scan/discover Bluetooth devices on Linux:
1. Ensure the Bluetooth service is running on the host system:
   ```bash
   sudo systemctl status bluetooth
   ```
2. Your user account must belong to the `bluetooth` group to access the BLE adapter:
   ```bash
   sudo usermod -a -G bluetooth $USER
   ```
   *(After running this, log out and log back in for group changes to take effect).*
