// ===================== Firmware update (desktop app only) =====================
// window.sgFirmware is exposed by electron/preload.js. In a plain browser it is
// undefined, so the Firmware tab stays hidden and this code never runs.

const fwSleep = (ms) => new Promise(r => setTimeout(r, ms));
let fwReleases = null;       // { flight: [...], notFlightTested: [...] }
let fwLocalUf2 = null;       // { path, name } when flashing a user-selected local file
let fwBusy = false;
let fwReconnectCancel = false; // set when the user clicks Reconnect manually
let fwAppPid = null;           // USB productId of the app firmware (captured pre-flash);
                               // lets auto-reconnect tell the app apart from the bootloader

function fwStatus(msg, color = '#cbd5e1') {
    const el = document.getElementById('fw-status');
    if (el) { el.textContent = msg; el.style.color = color; }
}
function fwProgress(pct) {
    const wrap = document.getElementById('fw-progress-wrap');
    const bar = document.getElementById('fw-progress-bar');
    if (!wrap || !bar) return;
    if (pct == null) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function fwShowBtn(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
}

function fwCurrentFamily() {
    return ALL_BOARD_FAMILIES[document.getElementById('fw-family').value] || ALL_BOARD_FAMILIES.SillyGoose;
}

// Repopulates the Variant dropdown for whichever board family is selected.
function fwPopulateVariants() {
    const family = fwCurrentFamily();
    const sel = document.getElementById('fw-variant');
    sel.innerHTML = family.firmwareVariants.map(v => `<option value="${v.value}">${v.label}</option>`).join('');
}

function fwPopulateVersions() {
    const channel = document.getElementById('fw-channel').value;
    const sel = document.getElementById('fw-version');
    const list = (fwReleases && fwReleases[channel]) || [];
    sel.innerHTML = '';
    if (!list.length) {
        sel.innerHTML = '<option value="">(none available)</option>';
        sel.disabled = true;
        return;
    }
    list.forEach((r, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = r.isLatest ? `Latest — ${r.label}` : r.label;
        sel.appendChild(opt);
    });
    sel.value = '0';
    sel.disabled = !!fwLocalUf2 || list.length <= 1;
}

function fwSetLocalUf2(file) {
    fwLocalUf2 = file || null;
    const usingLocal = !!fwLocalUf2;
    const nameEl = document.getElementById('fw-local-name');
    const clearBtn = document.getElementById('fw-local-clear-btn');
    const channelEl = document.getElementById('fw-channel');
    const familyEl = document.getElementById('fw-family');
    const variantEl = document.getElementById('fw-variant');

    if (nameEl) nameEl.textContent = usingLocal ? fwLocalUf2.name : '';
    fwShowBtn('fw-local-clear-btn', usingLocal);
    if (clearBtn) clearBtn.disabled = false;
    if (channelEl) channelEl.disabled = usingLocal;
    if (familyEl) familyEl.disabled = usingLocal;
    if (variantEl) variantEl.disabled = usingLocal;
    fwPopulateVersions();
}

function fwSelectedAssetUrl() {
    const channel = document.getElementById('fw-channel').value;
    const familyId = document.getElementById('fw-family').value;
    const variant = document.getElementById('fw-variant').value;
    const idx = parseInt(document.getElementById('fw-version').value, 10);
    const rel = ((fwReleases && fwReleases[channel]) || [])[idx];
    return rel ? ((rel.assets[familyId] && rel.assets[familyId][variant]) || null) : null;
}

// Auto-detect the board family + variant (e.g. "SeriousGooseV1") from the USB
// product descriptor of the connected board. NOT the user-writable BOARD_NAME.
// Safe to call repeatedly (on connect / when opening the tab). Also switches the
// active altimeter profile to match, for boards that log flight data.
// Returns the detected family id, or null if nothing matched (Electron-only -
// Web Serial never exposes this string in a plain browser).
async function fwDetectVariant(conn) {
    if (!window.sgFirmware) return null;
    try {
        const info = await window.sgFirmware.boardInfo();
        const name = (info && info.displayName) || '';
        const detEl = document.getElementById('fw-detected');

        const familyId = Object.keys(ALL_BOARD_FAMILIES).find(id => ALL_BOARD_FAMILIES[id].usbNameMatch.test(name));
        if (!familyId) {
            if (detEl) detEl.textContent = name ? `connected as "${name}" — pick the board manually` : '';
            return null;
        }

        document.getElementById('fw-family').value = familyId;
        fwPopulateVariants();
        const m = name.match(/V(\d)/i);
        if (m) {
            const variantSel = document.getElementById('fw-variant');
            if ([...variantSel.options].some(o => o.value === 'V' + m[1])) variantSel.value = 'V' + m[1];
        }
        if (detEl) detEl.textContent = `detected ${name}`;
        if (ALTIMETER_PROFILES[familyId]) conn.setActiveProfile(familyId);
        return familyId;
    } catch (e) { return null; }
}

// 1200-baud touch: reset the SAMD21/SAMD51 into its UF2 bootloader using the
// currently-connected port, then release it. Mirrors the Arduino touch1200.
async function fwEnterBootloaderViaTouch(conn) {
    const p = conn.port;
    if (!p) return;
    // Remember the running app's USB productId. The UF2 bootloader enumerates
    // under the same vendor (0x239A) but a DIFFERENT productId, so this lets
    // auto-reconnect skip the bootloader's CDC port and wait for the app.
    try { fwAppPid = (p.getInfo && p.getInfo().usbProductId) || null; } catch (e) { fwAppPid = null; }
    conn.keepReading = false;                                   // stop readLoop re-grabbing the reader
    if (conn.reader) { try { await conn.reader.cancel(); } catch (e) {} }
    // Wait for readLoop's finally to release the reader lock before we close.
    for (let i = 0; i < 25 && p.readable && p.readable.locked; i++) await fwSleep(30);
    try { await p.close(); } catch (e) {}
    conn.forceUIDisconnect();                                   // clears conn.port + UI; `p` still valid
    await fwSleep(250);
    await p.open({ baudRate: 1200 });                      // the touch
    await fwSleep(150);
    try { await p.close(); } catch (e) {}                  // close at 1200 -> board jumps to bootloader
    await fwSleep(400);
}

// Open a candidate port and wire up the UI. Returns true on success.
async function fwAdoptPort(conn, p) {
    if (!p) return false;
    const info = (p.getInfo && p.getInfo()) || {};
    if (info.usbVendorId && info.usbVendorId !== 0x239A) return false; // skip only clearly non-Adafruit
    // Reject the UF2 bootloader: it shares the vendor id but reports a
    // different productId than the app we captured before flashing. Without
    // this we grab the bootloader's CDC port, then the board resets into the
    // app and the connection dies. If we never captured a PID (e.g. the board
    // was flashed via double-tap while disconnected), fall through and try.
    if (fwAppPid && info.usbProductId && info.usbProductId !== fwAppPid) return false;
    try {
        await p.open({ baudRate: 115200 });
    } catch (e) { return false; }                          // not ready / wrong device — caller keeps trying
    conn.port = p;
    document.getElementById('connectBtn').style.display = 'none';
    document.getElementById('disconnectBtn').style.display = 'block';
    setSerialEnabled(true);
    conn.keepReading = true;
    conn.readLoop();
    return true;
}

// Aggressive best-effort auto-reconnect after flashing. getPorts() needs no
// user gesture (unlike requestPort), so we poll it hard. Two things matter:
//   1) We do NOT skip the pre-flash handle. After re-enumeration Chromium
//      usually hands back the SAME SerialPort object, so skipping it was why
//      auto-reconnect always failed. A genuinely dead handle just fails to
//      open and we retry.
//   2) We also listen for Web Serial's 'connect' event, which fires the moment
//      the re-enumerated (auto-authorized) board appears, and grab it directly.
// fwAdoptPort() rejects the UF2 bootloader (same vendor, different productId)
// so we wait for the app rather than grabbing the bootloader mid-reset.
// If everything fails, the caller falls back to the manual Reconnect button.
async function fwTryAutoReconnect(conn, timeoutMs = 15000) {
    fwReconnectCancel = false;

    // Give the bootloader a moment to finish writing, reset, and let the app
    // re-enumerate before we start grabbing ports — avoids racing the reset.
    await fwSleep(1200);

    let freshPort = null;
    const onConnect = (e) => { freshPort = e.port || (e.target && e.target.port) || freshPort; };
    navigator.serial.addEventListener('connect', onConnect);
    try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !fwReconnectCancel) {
            // The board just announced itself — try that handle first.
            if (freshPort) {
                const p = freshPort; freshPort = null;
                if (await fwAdoptPort(conn, p)) return true;
            }
            // Otherwise try every authorized port (including the old handle).
            let ports = [];
            try { ports = await navigator.serial.getPorts(); } catch (e) {}
            for (const p of ports) {
                if (fwReconnectCancel) return false;
                if (await fwAdoptPort(conn, p)) return true;
            }
            await fwSleep(400);
        }
        return false;
    } finally {
        navigator.serial.removeEventListener('connect', onConnect);
    }
}

async function fwDoUpdate(conn, isRetry) {
    if (fwBusy) return;
    const localUf2 = fwLocalUf2;
    const url = localUf2 ? null : fwSelectedAssetUrl();
    if (!localUf2 && !url) { fwStatus('No firmware available for that selection.', '#ef4444'); return; }
    const family = fwCurrentFamily();
    const variant = document.getElementById('fw-variant').value;
    const channel = document.getElementById('fw-channel').value;
    const connected = !!conn.port;

    if (!isRetry) {
        const how = connected
            ? 'The board will be reset into its bootloader automatically.'
            : 'Your board is not connected — you will need to double-tap the RESET button.';
        const warn = channel === 'notFlightTested' ? '\n\n⚠ This is a NOT-FLIGHT-TESTED build.' : '';
        const source = localUf2 ? `local UF2 "${localUf2.name}"` : `${family.displayName} ${variant} firmware`;
        if (!confirm(`Flash ${source}?\n\n${how}${localUf2 ? '' : warn}`)) return;
    }

    fwBusy = true;
    fwAppPid = null;           // recaptured by the touch below (connected path only)
    document.getElementById('fw-update-btn').disabled = true;
    fwShowBtn('fw-retry-btn', false);
    fwShowBtn('fw-reconnect-btn', false);
    DebugLog.info('firmware', `flashing ${localUf2 ? 'local UF2 ' + localUf2.name : family.displayName + ' ' + variant + ' (' + channel + ')'}`);
    try {
        let uf2Path;
        if (localUf2) {
            fwProgress(null);
            fwStatus(`Using local firmware ${localUf2.name}...`);
            uf2Path = localUf2.path;
        } else {
        // 1) Download first — the board stays untouched if this fails.
        fwStatus('Downloading firmware…');
        uf2Path = await window.sgFirmware.download(url);
        }

        // 2) Enter the bootloader (auto touch when connected, else manual).
        if (connected) {
            fwStatus('Resetting board into bootloader…');
            await fwEnterBootloaderViaTouch(conn);
        } else {
            fwStatus('Double-tap the RESET button on your board now…');
        }

        // 3) Wait for FEATHERBOOT and copy the .uf2.
        const result = await window.sgFirmware.waitAndFlash(uf2Path);
        fwProgress(null);
        if (!result.ok) {
            DebugLog.error('firmware', `flash failed: ${result.reason} ${result.detail || ''}`);
            if (result.reason === 'no-drive') {
                fwStatus('Bootloader drive not found. Double-tap RESET on the board, then click Retry.', '#f59e0b');
                fwShowBtn('fw-retry-btn', true);
            } else {
                fwStatus('Flash failed: ' + (result.detail || result.reason), '#ef4444');
            }
            return;
        }

        // 4) Success — board reboots on the new firmware. Offer the manual
        // Reconnect button right away while we also try to auto-reconnect.
        fwStatus('Firmware copied. Board is rebooting — reconnecting…', '#22c55e');
        fwShowBtn('fw-reconnect-btn', true);
        if (await fwTryAutoReconnect(conn)) {
            fwShowBtn('fw-reconnect-btn', false);
            fwStatus('Done — reconnected. Check Firmware Version under System Configuration.', '#22c55e');
            DebugLog.info('firmware', 'flash + auto-reconnect succeeded');
        } else if (!fwReconnectCancel) {
            fwStatus('Firmware flashed. Click Reconnect to talk to the board.', '#22c55e');
        }
    } catch (e) {
        fwProgress(null);
        DebugLog.error('firmware', 'update error: ' + e.message);
        fwStatus('Update error: ' + e.message, '#ef4444');
    } finally {
        fwBusy = false;
        document.getElementById('fw-update-btn').disabled = false;
    }
}

// Browser build: the Firmware tab is visible but USB flashing isn't possible
// (no window.sgFirmware). Gray the panel out and explain it's desktop-only.
function initFirmwareDisabled() {
    const notice = document.getElementById('fw-desktop-only');
    if (notice) notice.style.display = '';
    ['fw-channel', 'fw-version', 'fw-family', 'fw-variant', 'fw-local-btn', 'fw-local-clear-btn', 'fw-update-btn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
    });
    const panel = document.querySelector('#firmware-tab .fw-panel');
    if (panel) panel.style.opacity = '0.6';
}

// Populates the Board dropdown from ALL_BOARD_FAMILIES and the Variant dropdown
// to match. Done unconditionally (desktop and browser builds alike) so the
// browser build's grayed-out Firmware tab still shows real options rather than
// empty selects.
function fwPopulateFamilies(conn) {
    const familySel = document.getElementById('fw-family');
    familySel.innerHTML = Object.values(ALL_BOARD_FAMILIES).map(f => `<option value="${f.id}">${f.displayName}</option>`).join('');
    familySel.value = conn.profile.id;
    fwPopulateVariants();
}

async function initFirmware(conn) {
    const familySel = document.getElementById('fw-family');
    familySel.onchange = () => { fwPopulateVariants(); fwPopulateVersions(); };

    document.getElementById('fw-channel').onchange = fwPopulateVersions;
    document.getElementById('fw-local-btn').onclick = async () => {
        try {
            const file = await window.sgFirmware.chooseLocalUf2();
            if (!file) return;
            fwSetLocalUf2(file);
            fwStatus(`Selected local firmware ${file.name}.`, '#22c55e');
        } catch (e) {
            fwStatus('Local UF2 error: ' + e.message, '#ef4444');
        }
    };
    document.getElementById('fw-local-clear-btn').onclick = () => {
        fwSetLocalUf2(null);
        fwStatus('');
    };
    document.getElementById('fw-update-btn').onclick = () => fwDoUpdate(conn, false);
    document.getElementById('fw-retry-btn').onclick = () => { fwShowBtn('fw-retry-btn', false); fwDoUpdate(conn, true); };
    document.getElementById('fw-reconnect-btn').onclick = () => {
        fwReconnectCancel = true;                 // stop any in-flight auto-reconnect
        fwShowBtn('fw-reconnect-btn', false);
        conn.connect();                           // user gesture -> requestPort -> auto-select
    };
    // Re-detect the board whenever the tab is opened (the board may have been
    // connected after the app started).
    document.getElementById('fw-tab-btn').addEventListener('click', () => fwDetectVariant(conn));
    fwDetectVariant(conn);

    // Download / copy progress streamed from the main process.
    window.sgFirmware.onProgress((p) => {
        if (p.phase === 'download') { fwProgress(p.pct); fwStatus(`Downloading firmware… ${p.pct}%`); }
        else if (p.phase === 'waiting') { fwStatus('Waiting for the bootloader drive (FEATHERBOOT)…'); }
        else if (p.phase === 'copying') { fwProgress(null); fwStatus(`Copying firmware to ${p.drive}…`); }
    });

    try {
        fwStatus('Loading available firmware…');
        fwReleases = await window.sgFirmware.listReleases();
        fwPopulateVersions();
        fwStatus('');
    } catch (e) {
        fwStatus('Could not load firmware list: ' + e.message, '#ef4444');
    }
}

// Run as soon as the DOM is ready (not on 'load', which waits for the whole
// multi-megabyte inlined bundle — Plotly, Leaflet, etc. — to finish). The tab is
// always shown; the desktop app wires it up, the browser build grays it out.
function fwInit() {
    const conn = ConnectionManager.getActive();
    fwPopulateFamilies(conn);
    if (window.sgFirmware) initFirmware(conn); else initFirmwareDisabled();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fwInit);
else fwInit();
