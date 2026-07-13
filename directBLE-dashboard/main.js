const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Enforce single instance lock to prevent multi-port origin conflicts and memory leaks
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Enable Web Bluetooth and experimental features in Electron
app.commandLine.appendSwitch('enable-experimental-web-platform-features', 'true');
app.commandLine.appendSwitch('enable-web-bluetooth', 'true');

let mainWindow;
let server;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 868,
    title: "Smart Wireless Acceleromater",
    icon: path.join(__dirname, 'app_icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Set to false to allow proper local server requests
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Hide default menu bar for a clean, native app appearance
  mainWindow.setMenu(null);

  // Spin up a simple secure-context local server to bypass file:// Web Bluetooth restrictions
  server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0].split('#')[0];
    let filePath = path.join(__dirname, urlPath === '/' ? 'index1.html' : urlPath);
    
    // Resolve path and prevent path traversal
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(__dirname)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
      case '.js': contentType = 'text/javascript'; break;
      case '.css': contentType = 'text/css'; break;
      case '.png': contentType = 'image/png'; break;
      case '.jpg': contentType = 'image/jpeg'; break;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.statusCode = 404;
          res.end('Not Found');
        } else {
          res.statusCode = 500;
          res.end('Internal Server Error: ' + err.code);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
      }
    });
  });

  const BASE_PORT = 58331;
  function startLocalServer(portAttempts = 0) {
    const port = BASE_PORT + portAttempts;
    if (portAttempts > 10) {
      server.listen(0, '127.0.0.1', () => {
        const fallbackPort = server.address().port;
        console.log(`Local secure context server running at fallback http://127.0.0.1:${fallbackPort}`);
        mainWindow.loadURL(`http://127.0.0.1:${fallbackPort}`);
      });
      return;
    }

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        startLocalServer(portAttempts + 1);
      } else {
        console.error('Local server error:', err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Local secure context server running at http://127.0.0.1:${port}`);
      mainWindow.loadURL(`http://127.0.0.1:${port}`);
    });
  }

  startLocalServer(0);

  // --- Bluetooth Handling System ---
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    activeBluetoothCallback = callback;

    // Filter devices matching our accelerometer naming criteria
    const filteredList = deviceList.filter(d => 
      d.deviceName.includes('ISRO') || 
      d.deviceName.includes('Accel') ||
      d.deviceName.includes('Smart') ||
      d.deviceName.includes('Coincell')
    );

    // Send the filtered device list to the renderer process
    mainWindow.webContents.send('bluetooth-devices-discovered', filteredList);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (server) {
      server.close();
    }
  });
}

// Module-level Bluetooth selection callback reference
let activeBluetoothCallback = null;

// Handle user response from the renderer process
ipcMain.on('select-bluetooth-device-response', (event, deviceId) => {
  if (activeBluetoothCallback) {
    console.log("Connecting to user-selected device ID:", deviceId);
    activeBluetoothCallback(deviceId);
    activeBluetoothCallback = null;
  }
});

// Handle scan cancel from the renderer process
ipcMain.on('cancel-bluetooth-scan', (event) => {
  if (activeBluetoothCallback) {
    console.log("BLE scan cancelled by user/dashboard");
    activeBluetoothCallback(''); // Empty string cancels the requestDevice promise
    activeBluetoothCallback = null;
  }
});

// Grant Bluetooth access permissions automatically (necessary in Electron Web Bluetooth)
app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'bluetooth') {
      return true;
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'bluetooth') {
      callback(true);
    } else {
      callback(false);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('second-instance', (event, commandLine, workingDirectory) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    process.exit(0);
  }
});
