const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Adafruit USB vendor ID. SillyGoose boards enumerate under Adafruit's VID and
// set their USB product string to "SillyGoose" (platformio.ini board.name).
const ADAFRUIT_VENDOR_ID = '239a';

// Decide which connected serial ports are SillyGoose boards. Electron exposes
// vendorId/productId as lowercase hex strings and the product string in
// displayName. Prefer the precise match (Adafruit VID + "SillyGoose" in the
// name); if no name matches (e.g. the OS didn't surface a product string), fall
// back to any Adafruit device so the user can still connect.
function filterSillyGoosePorts(portList) {
  const named = portList.filter(
    (p) =>
      (p.vendorId || '').toLowerCase() === ADAFRUIT_VENDOR_ID &&
      (p.displayName || '').toLowerCase().includes('sillygoose')
  );
  if (named.length > 0) return named;
  return portList.filter((p) => (p.vendorId || '').toLowerCase() === ADAFRUIT_VENDOR_ID);
}

// Styled, frameless chooser. Shown when more than one SillyGoose is present, or
// as a fallback list of all serial ports when no SillyGoose is detected.
// Resolves with the chosen portId, or '' if the user cancels / closes it.
function pickPortWithModal(parentWindow, candidates, fallback) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: parentWindow,
      modal: true,
      frame: false,
      resizable: false,
      width: 460,
      height: Math.min(520, 200 + candidates.length * 64),
      backgroundColor: '#0f172a',
      webPreferences: {
        preload: path.join(__dirname, 'serial-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    let settled = false;
    const finish = (portId) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('serial-picker:choose', onChoose);
      ipcMain.removeListener('serial-picker:cancel', onCancel);
      if (!picker.isDestroyed()) picker.close();
      resolve(portId);
    };
    const onChoose = (_event, portId) => finish(portId);
    const onCancel = () => finish('');

    ipcMain.on('serial-picker:choose', onChoose);
    ipcMain.on('serial-picker:cancel', onCancel);
    picker.on('closed', () => finish(''));

    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('serial-picker:devices', {
        fallback: Boolean(fallback),
        devices: candidates.map((p) => ({
          portId: p.portId,
          displayName: p.displayName || 'Unknown Device',
          portName: p.portName || ''
        }))
      });
    });

    picker.loadFile(path.join(__dirname, 'serial-picker.html'));
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // Intercept the native serial chooser and apply SillyGoose-aware logic:
  // 0 boards -> error, 1 board -> auto-connect, >1 -> styled picker.
  win.webContents.session.on('select-serial-port', async (event, portList, _webContents, callback) => {
    event.preventDefault();

    // Logged so the matcher can be tuned against a real board if the product
    // string differs from what we expect.
    console.log('select-serial-port portList:', JSON.stringify(portList, null, 2));

    const allPorts = portList || [];
    const candidates = filterSillyGoosePorts(allPorts);

    // No SillyGoose detected: fall back to letting the user pick from every
    // available serial port (some boards may not surface a product string).
    if (candidates.length === 0) {
      if (allPorts.length === 0) {
        dialog.showErrorBox(
          'No Serial Devices Found',
          'Plug in your SillyGoose board and try again.'
        );
        callback('');
        return;
      }
      const chosen = await pickPortWithModal(win, allPorts, true);
      callback(chosen || '');
      return;
    }

    // Exactly one SillyGoose: connect without prompting.
    if (candidates.length === 1) {
      callback(candidates[0].portId);
      return;
    }

    // More than one SillyGoose: let the user choose.
    const chosen = await pickPortWithModal(win, candidates, false);
    callback(chosen || '');
  });

  // Permissions required for the Web Serial API to work.
  win.webContents.session.setPermissionCheckHandler((_webContents, permission) => permission === 'serial');
  win.webContents.session.setDevicePermissionHandler((details) => details.deviceType === 'serial');

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Check GitHub Releases for updates once the window has loaded. Only runs in
  // the packaged app (electron-updater needs app-update.yml from the installer).
  win.webContents.once('did-finish-load', () => initAutoUpdater(win));
}

// Prompt-based auto-update against the GitHub Releases publish config. Mirrors
// rocket-flight-data: ask before downloading, ask before restarting to install.
let autoUpdaterStarted = false;
function initAutoUpdater(win) {
  if (autoUpdaterStarted || !app.isPackaged) return;
  autoUpdaterStarted = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `SillyGoose Tool ${info.version} is available.`,
      detail: 'Download it now? You can keep working while it downloads in the background.'
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((err) => console.error('update download failed:', err));
    }
  });

  autoUpdater.on('download-progress', (p) => win.setProgressBar(p.percent / 100));

  autoUpdater.on('update-downloaded', async (info) => {
    win.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `SillyGoose Tool ${info.version} has been downloaded.`,
      detail: 'Restart to install now? It will also install automatically next time you quit.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => console.error('auto-updater error:', err));

  autoUpdater.checkForUpdates().catch((err) => console.error('update check failed:', err));
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
