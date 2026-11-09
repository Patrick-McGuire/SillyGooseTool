// --- Terminal, busy indicator, tab switching, top-level wiring --------------

// Removes a floating popup menu on the next outside click. Shared by every
// ad-hoc menu (flight-list context menu, live map's "save view" menu) instead
// of each reimplementing the same listen-once-and-remove pattern.
function dismissOnOutsideClick(menu) {
    setTimeout(() => document.addEventListener('click', function closeMenu() {
        menu.remove();
        document.removeEventListener('click', closeMenu);
    }), 0);
}

// Esc or a click on the dimmed backdrop closes the series picker (applying it, its only way out)
// and the config viewer. Not the altimeter picker - that one needs an answer. The press has to
// start on the backdrop too, so a text selection dragged out of the box doesn't close it.
const DISMISSABLE_MODALS = { 'series-modal': () => closeSeriesModal(), 'config-modal': () => closeConfigModal() };
Object.entries(DISMISSABLE_MODALS).forEach(([id, close]) => {
    const modal = document.getElementById(id);
    let pressedBackdrop = false;
    modal.addEventListener('mousedown', e => { pressedBackdrop = e.target === modal; });
    modal.addEventListener('click', e => { if (pressedBackdrop && e.target === modal) close(); });
});
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    Object.entries(DISMISSABLE_MODALS).forEach(([id, close]) => {
        if (document.getElementById(id).style.display === 'flex') close();
    });
});

let termBuffer = "";
let cmdHistory = [];
let historyIdx = -1;

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// msg is arbitrary logged text (device output, error strings, CONFIG lines...) - escaped before
// building the HTML string, since insertAdjacentHTML below renders it as real markup. Without
// this, any logged text containing '<'/'>' (e.g. a literal "<unable to decode: ...>" fallback
// message) corrupts the terminal's DOM instead of just printing oddly.
function logTerm(msg, color = "#00ff41") {
    termBuffer += `<div style="color:${color}">[${new Date().toLocaleTimeString()}] ${escapeHtml(msg)}</div>`;
}

function clearTerm() {
    document.getElementById('terminal').innerHTML = '';
}

const radioForwardBtn = document.getElementById('radioForwardBtn');
const radioForwardNotice = document.getElementById('radioForwardNotice');
// Also called by Connection.beginSession(), which turns forwarding off for each new connection.
function syncRadioForwardButton(conn) {
    radioForwardBtn.textContent = `To Radio: ${conn.forwardToRadio ? 'ON' : 'OFF'}`;
    radioForwardBtn.classList.toggle('active', conn.forwardToRadio);
}
radioForwardBtn.onclick = () => {
    const conn = ConnectionManager.getActive();
    conn.forwardToRadio = !conn.forwardToRadio;
    syncRadioForwardButton(conn);
    // The armed status shown is for whichever board commands now reach - re-ask that one.
    Telemetry.set('cfg.ARMED', null);
    conn.requestArmState();
};

setInterval(() => {
    if (termBuffer) {
        const t = document.getElementById('terminal');
        t.insertAdjacentHTML('beforeend', termBuffer);
        termBuffer = ""; t.scrollTop = t.scrollHeight;
        while (t.childNodes.length > 80) t.removeChild(t.firstChild);
    }
    // Only meaningful (and only shown) once the connected board has actually revealed itself as
    // a ground station (conn.isGroundStation flips reactively - see 03-connection.js) - there's
    // no separate event for that, so this just polls it on the same cadence as the flush above.
    const conn = ConnectionManager.getActive();
    radioForwardBtn.style.display = conn.isGroundStation ? '' : 'none';
    radioForwardNotice.style.display = conn.isGroundStation && conn.forwardToRadio ? '' : 'none';
}, 100);

function setBusy(val) {
    document.getElementById('busy-loader').style.display = val ? 'block' : 'none';
    if (!val && controlsUsable(ConnectionManager.getActive())) setSerialEnabled(true);
}

// Redraws are already skipped entirely while hidden (see the `!document.hidden`
// / tab-active checks in handleLiveLine/updateLiveMapIfActive), so there's no
// backlog to catch up on - but whatever was last drawn is now stale. Force one
// redraw on return instead of waiting up to 100ms for the next throttled row.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const conn = ConnectionManager.getActive();
    if (document.getElementById('live-tab').classList.contains('active')) throttledPlotLive.forceNow();
    if (document.getElementById('live-map-tab').classList.contains('active')) throttledElevationSparkline.forceNow(conn);
});

function openTab(id) {
    document.querySelectorAll('.tab-content, .tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if (event) event.currentTarget.classList.add('active');
    if (id === 'live-map-tab') {
        initLiveMap();
        setTimeout(() => { if (liveMap) { liveMap.invalidateSize(); showLiveTrack(); } }, 0);
    }
    // A flight plotted while this tab was hidden (an offload finishing on another tab) was sized
    // against a zero-size box - fit it to the real one now
    if (id === 'offload-tab') {
        const gd = document.getElementById('plot-container');
        if (gd._fullLayout) Plotly.Plots.resize(gd);
    }
}

function initUI() {
    const conn = ConnectionManager.getActive();
    document.getElementById('filter-flightstate').onchange = refreshList;
    initTelemetryWidgets();
    rebuildSeriesPicker(conn);
    rebuildConfigFields(conn);
    rebuildPyroWidgets(conn);
    rebuildPyroFireButtons(conn);
}

const cmdInput = document.getElementById('cmd-input');
function sendCmdFromInput() {
    const val = cmdInput.value.trim();
    if (!val) return;
    ConnectionManager.getActive().sendCmd(val);
    cmdHistory.push(val); historyIdx = cmdHistory.length; cmdInput.value = '';
}
cmdInput.onkeydown = e => {
    if (e.key === 'Enter') {
        sendCmdFromInput();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (historyIdx > 0) { historyIdx--; cmdInput.value = cmdHistory[historyIdx]; }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIdx < cmdHistory.length - 1) { historyIdx++; cmdInput.value = cmdHistory[historyIdx]; } else { historyIdx = cmdHistory.length; cmdInput.value = ''; }
    }
};
// The Enter-key path above always worked; the visible Send button next to it
// never had a click handler wired up. Fixed here rather than left as a
// dead-looking-but-functional button.
document.getElementById('sendBtn').onclick = sendCmdFromInput;

document.getElementById('connectBtn').onclick = () => ConnectionManager.getActive().connect();
document.getElementById('connectBluetoothBtn').onclick = () => ConnectionManager.getActive().connectBluetooth();
document.getElementById('disconnectBtn').onclick = () => ConnectionManager.getActive().disconnect();

// Hides whichever of Connect/Connect via Bluetooth its API doesn't support.
// Browser extensions that polyfill navigator.bluetooth (e.g. beacio on iOS
// Safari) can inject it slightly after this script runs, so recheck for a
// few seconds instead of locking in a possibly-stale verdict from one read.
(function () {
    let checks = 0;
    const timer = setInterval(() => {
        // Checked via the DOM (not ConnectionManager.getActive(), which lazily
        // creates a Connection as a side effect) so this can't stomp on a
        // connection that succeeds partway through the recheck window.
        if (document.getElementById('disconnectBtn').style.display !== 'block') {
            setConnectedUI(false);
        }
        if (++checks >= 15) clearInterval(timer);
    }, 200);
    setConnectedUI(false);
})();

// Browser build only - see stay-active-note in body.html. Electron windows aren't throttled
// like a backgrounded browser tab, so the warning would just be noise there.
if (!window.sgFirmware) {
    const stayActiveNote = document.getElementById('stay-active-note');
    if (stayActiveNote) stayActiveNote.style.display = '';
}

// Exports the full DebugLog ring buffer (see 00-logger.js) as a plain-text
// file, so a user hitting a bug can send it back rather than trying to
// describe/reproduce what happened.
const exportLogBtn = document.getElementById('exportLogBtn');
if (exportLogBtn) exportLogBtn.onclick = () => {
    const conn = ConnectionManager.getActive();
    DebugLog.download({
        'Active profile': conn.profile.id,
        'Log format': conn.logFormat ? `${conn.logFormat.structName} (${conn.logFormat.fields.length} fields, ${conn.logFormat.size} bytes)` : (conn.header.length ? 'names line only' : 'none'),
        'Connected': isConnected(conn),
        'Streaming': conn.streaming,
        'Flights this session': flightData.length
    });
};

window.onload = initUI;

// Top-level `let`/`const`/`class` (classic-script scope) don't attach to
// `window` the way `var`/`function` do. Bridge the handful of things worth
// reaching from outside (devtools console, this app's test harness) through
// one intentional namespace instead of leaving no way in at all.
window.SG = { ConnectionManager, Telemetry, DebugLog, getFlightData: () => flightData };
