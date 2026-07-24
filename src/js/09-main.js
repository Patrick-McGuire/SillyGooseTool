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

let termBuffer = "";
let cmdHistory = [];
let historyIdx = -1;

function logTerm(msg, color = "#00ff41") {
    termBuffer += `<div style="color:${color}">[${new Date().toLocaleTimeString()}] ${msg}</div>`;
}

setInterval(() => {
    if (termBuffer) {
        const t = document.getElementById('terminal');
        t.insertAdjacentHTML('beforeend', termBuffer);
        termBuffer = ""; t.scrollTop = t.scrollHeight;
        while (t.childNodes.length > 80) t.removeChild(t.firstChild);
    }
}, 100);

function setBusy(val) {
    document.getElementById('busy-loader').style.display = val ? 'block' : 'none';
    if (!val && ConnectionManager.getActive().port) setSerialEnabled(true);
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
        setTimeout(() => { if (liveMap) liveMap.invalidateSize(); }, 0);
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
document.getElementById('disconnectBtn').onclick = () => ConnectionManager.getActive().disconnect();

// Exports the full DebugLog ring buffer (see 00-logger.js) as a plain-text
// file, so a user hitting a bug can send it back rather than trying to
// describe/reproduce what happened.
const exportLogBtn = document.getElementById('exportLogBtn');
if (exportLogBtn) exportLogBtn.onclick = () => {
    const conn = ConnectionManager.getActive();
    DebugLog.download({
        'Active profile': conn.profile.id,
        'Connected': !!conn.port,
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
