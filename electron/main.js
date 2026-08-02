const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { APP_ID, APP_NAME, PRODUCT_NAME, ensureLinuxAppImageIntegration } = require('./linux-appimage');

// Firmware releases (UF2) are published here by build-release.yml.
const FIRMWARE_REPO = 'AerospaceNU/nuli-avionics-flight-software';

app.setName(APP_NAME);
// Give an unpackaged dev run (electron .) a distinct AppUserModelID from the
// installed release. Windows uses this ID to decide "same app" for taskbar
// grouping/pinning, so sharing it made a local dev launch collapse into the
// already-pinned installed copy instead of getting its own taskbar identity.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', PRODUCT_NAME);
  app.commandLine.appendSwitch('no-sandbox');
}

// USB product descriptor ("SillyGooseV2", "SeriousGooseV1") of the most recently
// selected port. Used by the renderer to auto-detect the board family + variant.
// This is the compile-time USB iProduct string, NOT the user-writable BOARD_NAME
// config.
let lastBoardDisplayName = '';

// Board families this tool knows how to flash. `prefix` matches both the USB
// product string and release asset names (platformio.ini's board.build.usb_product
// is set to "<prefix><variant>", e.g. "SeriousGooseV1"), so adding a new board
// family only means adding an entry here. An already-deployed SeriousGooseGroundV1
// unit (pre-GROUND_STATION_MODE_c firmware, when it was separate firmware rather
// than a runtime toggle on SeriousGoose) still matches the SeriousGoose entry below,
// since this is a substring match against the prefix.
const BOARD_FAMILIES = [
  { id: 'SillyGoose', prefix: 'SillyGoose', variants: [1, 2] },
  { id: 'SeriousGoose', prefix: 'SeriousGoose', variants: [1] }
];

// Adafruit USB vendor ID. All our boards enumerate under Adafruit's VID and set
// their USB product string to "<family><variant>" (platformio.ini board.name).
const ADAFRUIT_VENDOR_ID = 0x239a; // 9114
const UF2_MAGIC = 0x0a324655;

// Electron reports vendorId as a *decimal* string ("9114") on Windows, but some
// platforms/versions report hex ("239a"). Accept either so the match is robust.
function vendorMatches(vendorId, target) {
  if (vendorId == null) return false;
  const s = String(vendorId).trim().toLowerCase().replace(/^0x/, '');
  return parseInt(s, 10) === target || parseInt(s, 16) === target;
}

// Decide which connected serial ports are one of our known boards. Prefer the
// precise match (Adafruit VID + a known family prefix in the displayName, e.g.
// "SeriousGooseV1"); if no name matches (e.g. the OS didn't surface a product
// string), fall back to any Adafruit device so the user can still connect.
function filterKnownBoardPorts(portList) {
  const named = portList.filter(
    (p) =>
      vendorMatches(p.vendorId, ADAFRUIT_VENDOR_ID) &&
      BOARD_FAMILIES.some((f) => (p.displayName || '').toLowerCase().includes(f.prefix.toLowerCase()))
  );
  if (named.length > 0) return named;
  return portList.filter((p) => vendorMatches(p.vendorId, ADAFRUIT_VENDOR_ID));
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

// Styled Bluetooth device chooser (mirrors pickPortWithModal above). Unlike
// serial ports, BLE scanning is open-ended - 'select-bluetooth-device' fires
// repeatedly as new devices are discovered, so this state persists across
// calls instead of resolving once: the first call creates the picker window
// and stores it in `activeBlePicker`; later calls (from the same in-flight
// scan) just push the growing device list into the already-open window and
// refresh the stored callback, since Electron hands a fresh callback each
// time and the most recent one is the live one to invoke.
let activeBlePicker = null; // { picker, latestCallback } | null

function handleSelectBluetoothDevice(parentWindow) {
  return (event, deviceList, callback) => {
    event.preventDefault();
    const devices = (deviceList || []).map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName }));

    if (activeBlePicker) {
      activeBlePicker.latestCallback = callback;
      activeBlePicker.pendingDevices = devices;
      if (activeBlePicker.picker && !activeBlePicker.picker.isDestroyed()) {
        activeBlePicker.picker.webContents.send('bt-picker:devices', { devices });
      }
      return;
    }

    // Claim the slot synchronously, before creating the BrowserWindow (a
    // reported "multiple picker windows from one click" bug traced back to
    // this): native BrowserWindow construction on Windows can pump the OS
    // message loop, and a discovered-device event landing during that pump
    // would otherwise still see activeBlePicker as null and spawn a second
    // picker for what is really the same scan.
    activeBlePicker = { picker: null, latestCallback: callback, pendingDevices: devices };

    const picker = new BrowserWindow({
      parent: parentWindow,
      modal: true,
      frame: false,
      resizable: false,
      width: 460,
      height: 420,
      backgroundColor: '#0f172a',
      webPreferences: {
        preload: path.join(__dirname, 'bluetooth-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    activeBlePicker.picker = picker;

    let settled = false;
    const finish = (deviceId) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('bt-picker:choose', onChoose);
      ipcMain.removeListener('bt-picker:cancel', onCancel);
      if (!picker.isDestroyed()) picker.close();
      const cb = (activeBlePicker && activeBlePicker.latestCallback) || callback;
      activeBlePicker = null;
      cb(deviceId || '');
      // A modal child window closing has been observed (reported: the main
      // window's rendered content shrinking to roughly half its real width,
      // leaving raw background in the rest) to leave the parent's renderer
      // out of sync with its actual OS window bounds on Windows. Setting
      // bounds to their own current value is a no-op sizewise but forces
      // Chromium to re-query and re-layout against the real bounds instead
      // of whatever stale size it had while the modal was up.
      if (!parentWindow.isDestroyed()) {
        parentWindow.setBounds(parentWindow.getBounds());
      }
    };
    const onChoose = (_event, deviceId) => finish(deviceId);
    const onCancel = () => finish('');

    ipcMain.on('bt-picker:choose', onChoose);
    ipcMain.on('bt-picker:cancel', onCancel);
    picker.on('closed', () => finish(''));

    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('bt-picker:devices', { devices: activeBlePicker.pendingDevices || devices });
    });
    picker.loadFile(path.join(__dirname, 'bluetooth-picker.html'));
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
    const candidates = filterKnownBoardPorts(allPorts);

    // Remember the chosen port's USB product string so the firmware tab can
    // auto-detect the board variant (V1/V2).
    const remember = (portId) => {
      const p = allPorts.find((pp) => pp.portId === portId);
      lastBoardDisplayName = (p && p.displayName) || '';
    };

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
      if (chosen) remember(chosen);
      callback(chosen || '');
      return;
    }

    // Exactly one SillyGoose: connect without prompting.
    if (candidates.length === 1) {
      remember(candidates[0].portId);
      callback(candidates[0].portId);
      return;
    }

    // More than one SillyGoose: let the user choose.
    const chosen = await pickPortWithModal(win, candidates, false);
    if (chosen) remember(chosen);
    callback(chosen || '');
  });

  // Intercept the native Bluetooth chooser the same way as serial above.
  // Note this is a webContents event, not a session event (unlike
  // 'select-serial-port') - that's an Electron API asymmetry, not a mistake.
  win.webContents.on('select-bluetooth-device', handleSelectBluetoothDevice(win));

  // Our BLE module (Ebyte E104-BT5005A, see ars_platformio's SerialDebug.cpp)
  // doesn't require OS-level pairing, but Electron requires *some* handler to
  // be registered or a pairing request would otherwise hang with no prompt
  // ever shown. Auto-accept without a PIN if one isn't requested; if a PIN
  // ever is requested, there's nowhere to surface a prompt for it, so cancel
  // pairing rather than hang forever.
  win.webContents.session.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm') {
      callback({ confirmed: true });
    } else {
      console.log('Unhandled Bluetooth pairing request:', JSON.stringify(details));
      callback({ confirmed: false });
    }
  });

  // Permissions required for the Web Serial/Bluetooth APIs to work.
  win.webContents.session.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'serial' || permission === 'bluetooth'
  );
  win.webContents.session.setDevicePermissionHandler(
    (details) => details.deviceType === 'serial' || details.deviceType === 'bluetooth'
  );

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

// ---------------------------------------------------------------------------
// Firmware update (desktop-only)
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function validateUf2Path(uf2Path) {
  if (typeof uf2Path !== 'string' || !uf2Path.toLowerCase().endsWith('.uf2')) {
    throw new Error('Selected file is not a .uf2 file.');
  }
  const file = await fs.promises.open(uf2Path, 'r');
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead < 512 || header.readUInt32LE(0) !== UF2_MAGIC) {
      throw new Error('Selected file is not a valid UF2.');
    }
  } finally {
    await file.close();
  }
  return path.resolve(uf2Path);
}

// Download URL for the "<prefix>V<n>" (non-Sim) asset of a release. Asset names
// look like SeriousGooseV1.uf2 / SeriousGooseV1_not_flight_tested.uf2 /
// SeriousGooseV1_v1.00.uf2, with e.g. SeriousGooseV1Sim.uf2 variants we must
// exclude (and, since prefixes aren't substrings of each other, no risk of
// SillyGoose/SeriousGoose assets cross-matching).
function pickAsset(assets, prefix, n) {
  const re = new RegExp(`^${prefix}V${n}(?!Sim)`);
  const a = (assets || []).find((x) => re.test(x.name));
  return a ? a.browser_download_url : null;
}

// Group GitHub releases into the two firmware channels the UI offers.
function normalizeReleases(releases) {
  const flight = [];
  const notFlightTested = [];
  for (const r of releases) {
    const tag = r.tag_name || '';
    let channel;
    if (tag === 'latest' || tag.startsWith('main-')) channel = flight;
    else if (tag === 'not-flight-tested-latest') channel = notFlightTested;
    else continue;

    // assets.<familyId> = { V1: url, V2: url, ... } for whichever variants that
    // family's release actually published assets for.
    const assets = {};
    let anyAsset = false;
    for (const family of BOARD_FAMILIES) {
      const familyAssets = {};
      for (const n of family.variants) {
        const url = pickAsset(r.assets, family.prefix, n);
        if (url) { familyAssets['V' + n] = url; anyAsset = true; }
      }
      assets[family.id] = familyAssets;
    }
    if (!anyAsset) continue;

    const isLatest = tag === 'latest' || tag === 'not-flight-tested-latest';
    channel.push({
      label: r.name || tag,
      tag,
      isLatest,
      prerelease: !!r.prerelease,
      publishedAt: r.published_at || '',
      assets
    });
  }
  // Pin the rolling "latest" to the top, then newest-first by publish date.
  const sortFn = (a, b) =>
    a.isLatest ? -1 : b.isLatest ? 1 : b.publishedAt.localeCompare(a.publishedAt);
  flight.sort(sortFn);
  notFlightTested.sort(sortFn);
  return { flight, notFlightTested };
}

// Removable UF2 bootloader drives, identified by INFO_UF2.TXT (label-independent,
// mirrors build_tools/uf2conv.py get_drives()).
function findUf2Drives() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ps = '(Get-WmiObject Win32_LogicalDisk -Filter "FileSystem=\'FAT\'").DeviceID';
      execFile('powershell', ['-NoProfile', '-Command', ps], (err, stdout) => {
        if (err) return resolve([]);
        const drives = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((d) => (d.endsWith('\\') ? d : d + '\\'))
          .filter((d) => fs.existsSync(path.join(d, 'INFO_UF2.TXT')));
        resolve(drives);
      });
      return;
    }
    const user = process.env.USER || process.env.SUDO_USER || '';
    const roots =
      process.platform === 'darwin'
        ? ['/Volumes']
        : ['/media', '/run/media', `/media/${user}`, `/run/media/${user}`];
    const found = [];
    for (const root of roots) {
      try {
        for (const d of fs.readdirSync(root)) {
          const full = path.join(root, d);
          try {
            if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'INFO_UF2.TXT'))) {
              found.push(full);
            }
          } catch {
            /* unreadable entry */
          }
        }
      } catch {
        /* root doesn't exist */
      }
    }
    resolve(found);
  });
}

// Reported bug: after a Bluetooth picker closes (also seen after Disconnect,
// so it's not specific to the picker window itself) the main window's
// rendered content shrinks to roughly half its real width, leaving raw
// background in the rest -- a Chromium GPU-compositor repaint glitch rather
// than a CSS/layout bug (nothing in this app's CSS changes based on window
// size). Setting a window's bounds to its own current value is a no-op
// sizewise but forces a full repaint against the real bounds. Exposed to the
// renderer so it can call this after any UI update heavy enough to have
// triggered the glitch (see sgWindow.nudgeRepaint in preload.js).
ipcMain.handle('window:nudge-repaint', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setBounds(win.getBounds());
});

ipcMain.handle('firmware:board-info', () => ({ displayName: lastBoardDisplayName }));

ipcMain.handle('firmware:list', async () => {
  const res = await fetch(`https://api.github.com/repos/${FIRMWARE_REPO}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SillyGooseTool' }
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return normalizeReleases(await res.json());
});

ipcMain.handle('firmware:download', async (event, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('Invalid firmware URL.');
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SillyGooseTool', Accept: 'application/octet-stream' }
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      event.sender.send('firmware:progress', { phase: 'download', pct: Math.round((received / total) * 100) });
    }
  }
  const buf = Buffer.concat(chunks);
  // UF2 magic: first 32-bit word of the first block is 0x0A324655.
  if (buf.length < 512 || buf.readUInt32LE(0) !== UF2_MAGIC) {
    throw new Error('Downloaded file is not a valid UF2.');
  }
  const dir = path.join(app.getPath('temp'), 'sillygoose-fw');
  fs.mkdirSync(dir, { recursive: true });
  const name = (url.split('/').pop() || 'firmware.uf2').replace(/[^\w.\-]/g, '_');
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf);
  return dest;
});

ipcMain.handle('firmware:choose-local', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose UF2 firmware',
    properties: ['openFile'],
    filters: [{ name: 'UF2 firmware', extensions: ['uf2'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const uf2Path = await validateUf2Path(result.filePaths[0]);
  return { path: uf2Path, name: path.basename(uf2Path) };
});

// Picks a flight log to replay on the Simulation tab. Reads it here (fast, off
// the renderer thread) rather than via a browser FileReader - desktop-only
// like the firmware picker above, for the same reason (no native dialog / fs
// access from a plain browser tab).
ipcMain.handle('simulation:choose-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose flight log to replay',
    properties: ['openFile'],
    filters: [{ name: 'Log files', extensions: ['txt', 'csv', 'log'] }, { name: 'All files', extensions: ['*'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const text = await fs.promises.readFile(filePath, 'utf8');
  return { path: filePath, name: path.basename(filePath), text };
});

ipcMain.handle('firmware:flash', async (event, uf2Path) => {
  uf2Path = await validateUf2Path(uf2Path);
  // Poll for the bootloader drive (it takes a couple seconds to mount after the
  // 1200-baud touch / double-tap).
  const deadline = Date.now() + 15000;
  let drive = null;
  while (Date.now() < deadline) {
    const drives = await findUf2Drives();
    if (drives.length) {
      drive = drives[0];
      break;
    }
    event.sender.send('firmware:progress', { phase: 'waiting' });
    await delay(800);
  }
  if (!drive) return { ok: false, reason: 'no-drive' };

  event.sender.send('firmware:progress', { phase: 'copying', drive });
  try {
    await fs.promises.copyFile(uf2Path, path.join(drive, path.basename(uf2Path)));
  } catch (err) {
    // The bootloader can reboot and yank the drive mid-copy; that's usually a
    // successful flash, so only treat it as an error if the drive is still there.
    if (fs.existsSync(path.join(drive, 'INFO_UF2.TXT'))) {
      return { ok: false, reason: 'copy-failed', detail: String(err) };
    }
  }
  return { ok: true, drive };
});

// ---------------------------------------------------------------------------
// Stream log auto-save (desktop-only)
// ---------------------------------------------------------------------------
// Every row the renderer sees while streaming gets appended here as it
// arrives, so the raw stream survives a crash or a forgotten "Save Stream
// Log" click. Written outside the git repo entirely (Electron's per-user
// `userData` directory, e.g. %APPDATA%/<app name>/stream-logs on Windows) -
// not a path under the project checkout, so there's nothing here that needs
// a .gitignore entry.
let streamLogFile = null; // { fd, path } | null

function streamLogDir() {
  const dir = path.join(app.getPath('userData'), 'stream-logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function closeStreamLogFile() {
  if (!streamLogFile) return;
  try { fs.closeSync(streamLogFile.fd); } catch (e) { /* already closed */ }
  streamLogFile = null;
}

ipcMain.handle('stream-log:start', (_event, meta) => {
  closeStreamLogFile();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const profileId = (meta && meta.profileId) || 'unknown';
  const filePath = path.join(streamLogDir(), `stream-${stamp}-${profileId}.txt`);
  const fd = fs.openSync(filePath, 'a');
  if (meta && meta.header) fs.writeSync(fd, meta.header + '\n');
  streamLogFile = { fd, path: filePath };
  return { path: filePath };
});

ipcMain.handle('stream-log:append', (_event, lines) => {
  if (!streamLogFile || !Array.isArray(lines) || !lines.length) return;
  fs.writeSync(streamLogFile.fd, lines.join('\n') + '\n');
});

ipcMain.handle('stream-log:stop', () => {
  closeStreamLogFile();
});

app.on('before-quit', closeStreamLogFile);

app.whenReady().then(async () => {
  const relaunching = await ensureLinuxAppImageIntegration(path.join(__dirname, '..', 'assets'));
  if (!relaunching) createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
