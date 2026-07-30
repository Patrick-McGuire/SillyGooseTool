const { contextBridge, ipcRenderer } = require('electron');

// Minimal, locked-down bridge for the Bluetooth picker modal only.
contextBridge.exposeInMainWorld('btPicker', {
  onDevices: (cb) => ipcRenderer.on('bt-picker:devices', (_event, devices) => cb(devices)),
  choose: (deviceId) => ipcRenderer.send('bt-picker:choose', deviceId),
  cancel: () => ipcRenderer.send('bt-picker:cancel')
});
