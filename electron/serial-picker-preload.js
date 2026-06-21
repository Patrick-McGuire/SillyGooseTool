const { contextBridge, ipcRenderer } = require('electron');

// Minimal, locked-down bridge for the serial picker modal only.
contextBridge.exposeInMainWorld('picker', {
  onDevices: (cb) => ipcRenderer.on('serial-picker:devices', (_event, devices) => cb(devices)),
  choose: (portId) => ipcRenderer.send('serial-picker:choose', portId),
  cancel: () => ipcRenderer.send('serial-picker:cancel')
});
