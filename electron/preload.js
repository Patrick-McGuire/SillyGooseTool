const { contextBridge, ipcRenderer } = require('electron');

// Firmware-update bridge, exposed only in the desktop app. The renderer
// feature-detects `window.sgFirmware`; in a plain browser it's undefined, so the
// firmware UI stays hidden and the single shared codebase is unchanged.
contextBridge.exposeInMainWorld('sgFirmware', {
  // Grouped firmware releases: { flight: [...], notFlightTested: [...] }.
  listReleases: () => ipcRenderer.invoke('firmware:list'),
  // USB product descriptor of the last selected port, e.g. "SillyGooseV2".
  boardInfo: () => ipcRenderer.invoke('firmware:board-info'),
  // Download a release asset to a temp file; returns the local path.
  download: (url) => ipcRenderer.invoke('firmware:download', url),
  // Wait for the UF2 bootloader drive and copy the .uf2 onto it.
  waitAndFlash: (uf2Path) => ipcRenderer.invoke('firmware:flash', uf2Path),
  // Subscribe to progress events; returns an unsubscribe function.
  onProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('firmware:progress', listener);
    return () => ipcRenderer.removeListener('firmware:progress', listener);
  }
});
