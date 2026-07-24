// --- System Configuration tab: Control Panel + config table -----------------
// All device-facing action buttons (start/stop stream, log enable/disable,
// reset, fire pyro, erase) live in one Control Panel here, rather than being
// scattered across the Live Stream / System Configuration tabs as separate
// stat-cards. Config values themselves render as a real table instead of a
// grid of visually-identical boxes.

function setSerialEnabled(en) {
    document.querySelectorAll('.ctrl-btn, .cfg-get, .cfg-set, #sendBtn, #getAllBtn, #eraseBtn').forEach(b => b.disabled = !en);
}

// Rebuilds the Control Panel's Fire buttons from the active profile's `pyros`
// list - a board's Fire buttons are exactly as many as it has pyro channels,
// nothing hardcoded to "drogue"/"main"/"aux". Called at startup and whenever
// the profile changes (see Connection.setActiveProfile).
function rebuildPyroFireButtons(conn) {
    const container = document.getElementById('pyro-fire-buttons');
    if (!container) return;
    container.innerHTML = conn.profile.pyros.map(p =>
        `<button class="btn btn-warn ctrl-btn" data-cmd="${p.fireCmd}" data-confirm="Fire ${p.label} pyro?" disabled>Fire ${p.label}</button>`
    ).join('');
    setSerialEnabled(!!conn.port); // newly-created buttons start disabled - sync them to the real state
}

// Control Panel's log-health readout (see Connection.processLine, which
// publishes these three keys from the "Entries in log:" / "Remaining log
// length:" / "Logging enabled/disabled" status lines).
Telemetry.subscribe('logEntries', v => { const el = document.getElementById('log-entries'); if (el) el.textContent = v; });
Telemetry.subscribe('logRemaining', v => { const el = document.getElementById('log-rem'); if (el) el.textContent = v; });
Telemetry.subscribe('logStatus', v => { const el = document.getElementById('log-status'); if (el) el.textContent = v; });

// Live-updates an already-rendered config table row whenever the board
// reports that config's value (a "MSG: X is set to: Y" line, published as
// Telemetry key `cfg.X` by Connection.processLine). Tracked so a profile
// switch can clear out the previous table's subscriptions instead of piling
// up stale ones.
let cfgTelemetryUnsubs = [];

// Rebuilds the System Configuration tab's table from the active profile's
// config list. Called at startup and whenever the profile changes.
function rebuildConfigFields(conn) {
    const cfgContainer = document.getElementById('config-fields');
    if (!cfgContainer) return;
    cfgTelemetryUnsubs.forEach(fn => fn());
    cfgTelemetryUnsubs = [];

    const rows = conn.configs.map(cfg => {
        const readOnlyAttr = cfg.readOnly ? ' readonly' : '';
        const inputHtml = cfg.type === 'checkbox'
            ? `<input type="checkbox" id="in-${cfg.id}"${readOnlyAttr}>`
            : `<input type="text" id="in-${cfg.id}" placeholder="…"${readOnlyAttr}>`;
        const setBtnHtml = cfg.readOnly ? '' : `<button class="btn btn-secondary cfg-set" data-id="${cfg.id}">Set</button>`;
        return `<tr>
            <td class="config-table-label">${cfg.label}</td>
            <td class="config-table-input">${inputHtml}</td>
            <td class="config-table-actions">
                <button class="btn btn-secondary cfg-get" data-id="${cfg.id}">Get</button>
                ${setBtnHtml}
            </td>
        </tr>`;
    }).join('');

    cfgContainer.innerHTML = `<table class="config-table">
        <thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;

    conn.configs.forEach(cfg => {
        cfgTelemetryUnsubs.push(Telemetry.subscribe(`cfg.${cfg.id}`, v => {
            const inputEl = document.getElementById(`in-${cfg.id}`);
            if (!inputEl) return;
            if (inputEl.type === 'checkbox') inputEl.checked = (v !== '0' && v.toLowerCase() !== 'false');
            else inputEl.value = v;
        }));
    });

    setSerialEnabled(!!conn.port);
}

async function confirmErase() {
    if (confirm("⚠️ Erase flash?")) await ConnectionManager.getActive().sendCmd("--erase");
}

document.getElementById('getAllBtn').onclick = () => {
    const conn = ConnectionManager.getActive();
    conn.configs.forEach((c, i) => setTimeout(() => conn.sendCmd(`--${c.id}`), i * 150));
};

// Single delegated listener for every device-facing action button: config
// Get/Set and the Control Panel's generic `.ctrl-btn` (data-cmd) buttons -
// covers stream/log/reset/fire/offload, all of which just send a fixed
// command string.
document.addEventListener('click', e => {
    const conn = ConnectionManager.getActive();
    if (e.target.classList.contains('cfg-get')) {
        conn.sendCmd(`--${e.target.dataset.id}`);
    }
    if (e.target.classList.contains('cfg-set')) {
        const id = e.target.dataset.id;
        const el = document.getElementById(`in-${id}`);
        const val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
        conn.sendCmd(`--${id} -set ${val}`);
    }
    if (e.target.classList.contains('ctrl-btn')) {
        const confirmMsg = e.target.dataset.confirm;
        if (confirmMsg && !confirm(confirmMsg)) return;
        conn.sendCmd(e.target.dataset.cmd);
    }
});
