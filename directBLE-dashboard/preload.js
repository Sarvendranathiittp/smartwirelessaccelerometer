const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onBluetoothDevices: (callback) => {
        const listener = (event, devices) => callback(devices);
        ipcRenderer.on('bluetooth-devices-discovered', listener);
        // Return a cleanup function
        return () => {
            ipcRenderer.removeListener('bluetooth-devices-discovered', listener);
        };
    },
    selectDevice: (deviceId) => ipcRenderer.send('select-bluetooth-device-response', deviceId),
    cancelScan: () => ipcRenderer.send('cancel-bluetooth-scan')
});
