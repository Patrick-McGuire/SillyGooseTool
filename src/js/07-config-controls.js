// --- System Configuration tab: Control Panel + config table -----------------
// All device-facing action buttons (start/stop stream, log enable/disable,
// reset, fire pyro, erase) live in one Control Panel here, rather than being
// scattered across the Live Stream / System Configuration tabs as separate
// stat-cards. Config values themselves render as a real table instead of a
// grid of visually-identical boxes.

function setSerialEnabled(en) {
    document.querySelectorAll('.ctrl-btn, .cfg-get, .cfg-set, #sendBtn, #getAllBtn, #eraseBtn').forEach(b => b.disabled = !en);
}

// Rebuilds the Control Panel's pyro buttons: Arm/Disarm (--arm/--disarm, saved on the board;
// a disarmed board never detects launch, so never deploys), then a Fire (timed) and a Turn on
// (held on until reboot, for a channel used as a power switch) button for every channel in
// PYRO_FIRE_FLAGS. Buttons the active profile doesn't support (armable, pyroChannels) stay
// greyed out - no ctrl-btn class, so setSerialEnabled() never enables them.
function rebuildPyroFireButtons(conn) {
    const container = document.getElementById('pyro-fire-buttons');
    if (!container) return;
    const armAttrs = conn.profile.armable ? 'class="btn btn-warn ctrl-btn"' : `class="btn btn-warn" title="${conn.profile.displayName} can't be armed or disarmed"`;
    const armStatus = conn.profile.armable
        ? `<button id="arm-status" class="btn btn-secondary ctrl-btn arm-status" data-cmd="--armed" title="Click to re-check" disabled>Armed: ?</button>`
        : `<button id="arm-status" class="btn btn-secondary arm-status" disabled>${conn.profile.displayName}: always armed</button>`;
    const armRow = armStatus + `<div class="pyro-fire-row">
        <button ${armAttrs} data-cmd="--arm" data-confirm="Arm the board? It will detect launch and deploy pyros in flight." disabled>Arm</button>
        <button ${armAttrs} data-cmd="--disarm" data-confirm="Disarm the board? It won't detect launch or deploy anything until armed again." disabled>Disarm</button>
    </div>`;
    container.innerHTML = armRow + Object.entries(PYRO_FIRE_FLAGS).map(([id, flag]) => {
        const label = id.charAt(0).toUpperCase() + id.slice(1);
        const applies = conn.profile.pyroChannels.includes(id);
        const attrs = applies ? 'class="btn btn-warn ctrl-btn"' : `class="btn btn-warn" title="${conn.profile.displayName} has no ${label} channel"`;
        return `<div class="pyro-fire-row">
            <button ${attrs} data-cmd="--fire ${flag}" data-confirm="Fire ${label} pyro?" disabled>Fire ${label}</button>
            <button ${attrs} data-cmd="--fire ${flag} --on" data-confirm="Turn on ${label} and hold it on until the board reboots?" disabled>Turn on ${label}</button>
        </div>`;
    }).join('');
    setSerialEnabled(controlsUsable(conn)); // newly-created buttons start disabled - sync them to the real state
    renderArmStatus(Telemetry.get('cfg.ARMED'));
}

// Shows the board's armed state ("ARMED is set to: 1/0" -> Telemetry cfg.ARMED) on the arm status
// button above Arm/Disarm. null/undefined = not known yet (new connection, or not asked yet).
function renderArmStatus(value) {
    const el = document.getElementById('arm-status');
    const conn = ConnectionManager.getActive();
    if (!el || !conn || !conn.profile.armable) return;
    const known = value === '1' || value === '0';
    el.textContent = known ? (value === '1' ? 'ARMED' : 'DISARMED') : 'Armed: ?';
    el.classList.toggle('arm-armed', value === '1');
    el.classList.toggle('arm-disarmed', value === '0');
}
Telemetry.subscribe('cfg.ARMED', renderArmStatus);

// Control Panel's log-health readout (see Connection.processLine, which
// publishes these three keys from the "Entries in log:" / "Remaining log
// length:" / "Logging enabled/disabled" status lines).
Telemetry.subscribe('logEntries', v => { const el = document.getElementById('log-entries'); if (el) el.textContent = v; });
Telemetry.subscribe('logRemaining', v => { const el = document.getElementById('log-rem'); if (el) el.textContent = v; });
Telemetry.subscribe('logStatus', v => { const el = document.getElementById('log-status'); if (el) el.textContent = v; });

// Live-updates an already-rendered config row when the board reports that
// config's value ("MSG: X is set to: Y", published as Telemetry key `cfg.X`
// by Connection.processLine). Tracked so a profile switch can clear the
// previous table's subscriptions instead of piling up stale ones.
let cfgTelemetryUnsubs = [];

// Rebuilds the System Configuration tab's table from the active profile's config list.
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
            <td>
                <div class="config-table-actions">
                    <button class="btn btn-secondary cfg-get" data-id="${cfg.id}">Get</button>
                    ${setBtnHtml}
                </div>
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

    setSerialEnabled(controlsUsable(conn));
}

async function confirmErase() {
    if (confirm("⚠️ Erase flash?")) await ConnectionManager.getActive().sendCmd("--erase");
}

document.getElementById('getAllBtn').onclick = () => {
    const conn = ConnectionManager.getActive();
    // Forwarded over radio, each request only actually transmits once GroundStationRelay's
    // single-slot uplink queue reaches a predicted safe window (roughly one radio cadence apart)
    // and its response can take several more cadences to fully drain - firing every 150ms (fine
    // for a direct connection) would overwrite most requests before they ever go out, and the
    // firmware's own serial-echo of a freshly-typed command can glue onto a still-in-flight
    // response with no separator. Space these out to give each one time to fully round-trip.
    const delayMs = conn.forwardToRadio ? 2500 : 150;
    conn.configs.forEach((c, i) => setTimeout(() => conn.sendCmd(`--${c.id}`), i * delayMs));
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
