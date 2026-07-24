// --- Offload tab: flight list, plotting, config viewer, export --------------
let flightData = [];
let selectedIdx = -1;

// Progress readout replacing the old per-row terminal spam during an offload
// (see Connection.recordOffloadProgress in 03-connection.js) - shown IN the
// offload buttons themselves (swapping their label for a running count)
// rather than a separate line that would reserve vertical space even when
// empty. Only one offload runs at a time, so updating both buttons the same
// way (rather than tracking which one was actually clicked) is harmless.
const OFFLOAD_BTN_LABELS = { offloadTextBtn: 'Offload (Text)', offloadBinBtn: 'Offload (Binary)' };
Telemetry.subscribe('offloadProgress', n => {
    Object.entries(OFFLOAD_BTN_LABELS).forEach(([id, label]) => {
        const btn = document.getElementById(id);
        if (btn) btn.textContent = (n == null) ? label : `${n.toLocaleString()} rows…`;
    });
});

function saveFlight(conn, lines, configLine = "", binChunks = null, namePrefix = "Flight") {
    const flightNum = flightData.length + 1;
    const flight = {
        id: Date.now(), name: `${namePrefix}_${flightNum}`, raw: [...lines],
        config: configLine || "", profileId: conn.profile.id, connectionId: conn.id
    };
    // Exact byte-for-byte raw records, present only for binary offloads.
    if (binChunks && binChunks.length) flight.bin = concatChunks(binChunks);
    flightData.push(flight);
    DebugLog.info('offload', `saved ${flight.name} (${lines.length} rows, profile ${flight.profileId})`);
    refreshList();
    selectFlight(flightData.length - 1);
}

// True if any row in the flight is in ASCENT (1) or DESCENT (2). Cached since raw never changes.
function flightHasAscentDescent(f) {
    if (f._hasAD === undefined) {
        const col = profileForFlight(f).cols.flightState;
        f._hasAD = f.raw.some(l => { const s = parseInt(l.split(/[\s\t]+/)[col]); return s === 1 || s === 2; });
    }
    return f._hasAD;
}

function refreshList() {
    const list = document.getElementById('flight-list');
    const filterAD = document.getElementById('filter-flightstate')?.checked;
    list.innerHTML = '';
    flightData.forEach((f, i) => {
        if (filterAD && !flightHasAscentDescent(f)) return;
        const item = document.createElement('div');
        item.className = `flight-item ${i === selectedIdx ? 'active' : ''}`;
        item.innerHTML = `<span>${f.name}</span><button class="del-btn" title="Delete" onclick="event.stopPropagation(); deleteLog(${i})">×</button>`;
        item.onclick = () => selectFlight(i);
        item.oncontextmenu = (e) => { e.preventDefault(); showFlightContextMenu(e, i); };
        list.appendChild(item);
    });
    document.getElementById('downloadZipBtn').disabled = (flightData.length === 0);
    document.getElementById('clearAllBtn').disabled = (flightData.length === 0);
}

// Right-click menu on a flight-list row: quick actions without needing to
// select the flight first, or hunting for the (single) "Download Selected"
// button at the bottom of the sidebar.
function showFlightContextMenu(e, i) {
    const existing = document.getElementById('flight-context-menu');
    if (existing) existing.remove();
    const menu = document.createElement('div');
    menu.id = 'flight-context-menu';
    menu.className = 'context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.innerHTML = `
        <button data-act="select">Select & Plot</button>
        <button data-act="download">Download (.txt)</button>
        <button data-act="config">View Config</button>
        <button data-act="delete" class="context-menu-danger">Delete</button>`;
    menu.querySelector('[data-act="select"]').onclick = () => { menu.remove(); selectFlight(i); };
    menu.querySelector('[data-act="download"]').onclick = () => { menu.remove(); downloadFlight(flightData[i]); };
    menu.querySelector('[data-act="config"]').onclick = () => { menu.remove(); selectFlight(i); openConfigModal(); };
    menu.querySelector('[data-act="delete"]').onclick = () => { menu.remove(); deleteLog(i); };
    document.body.appendChild(menu);
    dismissOnOutsideClick(menu);
}

const BOARD_ORIENTATION_NAMES = { 0: "ERROR_AXIS_DIRECTION", 1: "POS_X", 2: "NEG_X", 3: "POS_Y", 4: "NEG_Y", 5: "POS_Z", 6: "NEG_Z" };
const CONFIG_VALUE_FORMATTERS = {
    FLIGHT_STATE: v => `${FLIGHT_STATE_NAMES[parseInt(v)] || '?'} (${v})`,
    BOARD_ORIENTATION: v => `${BOARD_ORIENTATION_NAMES[parseInt(v)] || '?'} (${v})`,
};

function openConfigModal() {
    const contentEl = document.getElementById('config-content');
    const f = (selectedIdx >= 0) ? flightData[selectedIdx] : null;
    if (!f || !f.config) {
        contentEl.innerHTML = '<div style="color:#94a3b8">No configuration available for this flight.</div>';
    } else {
        const body = f.config.replace(/^CONFIG[\s\t]+/, '');
        const pairs = body.split(/[\t]+/).filter(p => p.length);
        contentEl.innerHTML = pairs.map(p => {
            const eq = p.indexOf('=');
            if (eq < 0) return `<div style="padding:4px 0">${p}</div>`;
            const k = p.slice(0, eq), v = p.slice(eq + 1);
            const display = CONFIG_VALUE_FORMATTERS[k] ? CONFIG_VALUE_FORMATTERS[k](v) : v;
            return `<div style="display:flex; justify-content:space-between; padding:4px 2px; border-bottom:1px solid #1e293b"><span style="color:#94a3b8">${k}</span><span style="color:var(--accent); font-family:'Courier New',monospace">${display}</span></div>`;
        }).join('');
    }
    document.getElementById('config-modal').style.display = 'flex';
}
function closeConfigModal() {
    document.getElementById('config-modal').style.display = 'none';
}

function selectFlight(i) {
    selectedIdx = i; refreshList();
    plotFlight(flightData[i]);
    document.getElementById('saveFileBtn').disabled = false;
}

function plotFlight(flight) {
    const cols = profileForFlight(flight).cols;
    const header = profileForFlight(flight).header;
    const activeSeries = ConnectionManager.getActive().activeSeries;
    const rows = flight.raw.map(l => l.split(/[\s\t]+/));
    const t0 = parseFloat(rows[0][0]);
    const t = rows.map(r => (parseFloat(r[0]) - t0) / 1000);

    const traces = activeSeries.map(idx => {
        const vals = rows.map(r => parseFloat(r[idx]));
        return {
            x: t, y: vals, name: header[idx], mode: 'lines',
            hoverinfo: 'none'
        };
    });

    const states = rows.map(r => parseInt(r[cols.flightState]));
    const shapes = [], annotations = [];
    const addEv = (time, txt, col) => {
        shapes.push({ type: 'line', x0: time, x1: time, y0: 0, y1: 1, yref: 'paper', line: { color: col, width: 1, dash: 'dash' } });
        annotations.push({ x: time, y: 1, yref: 'paper', text: txt, showarrow: false, textangle: -90, xanchor: 'right', font: { color: col, size: 9 } });
    };

    // One fired-event marker per pyro channel this flight's board actually has
    // (see ALTIMETER_PROFILES[...].pyros) - a board with more than drogue+main
    // just gets more markers here, nothing hardcoded to those two names.
    const pyros = profileForFlight(flight).pyros;
    const pyroEventColors = ['purple', 'blue', 'teal', 'brown', 'magenta'];
    for (let i = 1; i < states.length; i++) {
        if (states[i] !== states[i - 1]) addEv(t[i], `${FLIGHT_STATE_NAMES[states[i - 1]]} → ${FLIGHT_STATE_NAMES[states[i]]}`, 'green');
        pyros.forEach((p, idx) => {
            if (rows[i][p.firedCol] == "1" && rows[i - 1][p.firedCol] == "0") {
                addEv(t[i], `${p.label.toUpperCase()} FIRED`, pyroEventColors[idx % pyroEventColors.length]);
            }
        });
    }

    const gd = document.getElementById('plot-container');
    Plotly.newPlot(gd, traces, {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#f8fafc' }, margin: { t: 60, r: 20, l: 50, b: 40 },
        hovermode: 'x', xaxis: { title: 'Time (s)', gridcolor: '#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1 },
        yaxis: { title: 'Data', gridcolor: '#334155' }, shapes, annotations,
        showlegend: true,
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1, font: { size: 10, color: '#94a3b8' } }
    }, { responsive: true, displaylogo: false }).then(() => {
        setupHoverEvents('plot-container', 'hover-dashboard', false);
    });

    document.getElementById('stat-alt').innerText = Math.max(...rows.map(r => parseFloat(r[cols.altitudeM]))).toFixed(1);
    document.getElementById('stat-vel').innerText = Math.max(...rows.map(r => parseFloat(r[cols.velocityMS]))).toFixed(1);
    document.getElementById('stat-state').innerText = FLIGHT_STATE_NAMES[states[states.length - 1]] || '-';
}

function setupHoverEvents(plotId, dashId, isLiveTab) {
    const gd = document.getElementById(plotId);
    const dash = document.getElementById(dashId);

    const resetText = () => {
        if (isLiveTab) {
            isLiveHovering = false;
            updateLiveDashboardWithMostRecent();
        } else {
            dash.innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
        }
    };

    gd.removeAllListeners('plotly_hover');
    gd.removeAllListeners('plotly_unhover');

    gd.on('plotly_hover', data => {
        if (!data || !data.points) return;
        if (isLiveTab) isLiveHovering = true;
        let html = `<div class="hover-item">Time: <span class="hover-val">${data.points[0].x.toFixed(3)}s</span></div>`;
        data.points.forEach(pt => {
            html += `<div class="hover-item">${pt.data.name}: <span class="hover-val">${pt.y.toFixed(2)}</span></div>`;
        });
        dash.innerHTML = html;
    });

    gd.on('plotly_unhover', resetText);

    if (!isLiveTab || !isLiveHovering) resetText();
}

function deleteLog(i) {
    flightData.splice(i, 1);
    if (selectedIdx === i) {
        selectedIdx = -1;
        Plotly.purge('plot-container');
        document.getElementById('saveFileBtn').disabled = true;
        document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
    } else if (selectedIdx > i) {
        selectedIdx--;
    }
    refreshList();
}

function clearAllSession() {
    if (confirm("Clear current session flights?")) {
        flightData = []; selectedIdx = -1;
        Plotly.purge('plot-container');
        document.getElementById('saveFileBtn').disabled = true;
        document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
        refreshList();
    }
}

function buildFlightText(f) {
    const header = profileForFlight(f).header;
    const parts = [];
    if (f.config) parts.push(f.config);
    parts.push(header.join("\t"));
    parts.push(f.raw.join("\n"));
    return parts.join("\n");
}

function downloadFlight(f) {
    const blob = new Blob([buildFlightText(f)], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = f.name + ".txt"; a.click();
}

function openSeriesModal() {
    rebuildSeriesPicker(ConnectionManager.getActive());
    document.getElementById('series-modal').style.display = 'flex';
}
function closeSeriesModal() {
    const conn = ConnectionManager.getActive();
    conn.activeSeries = Array.from(document.querySelectorAll('#series-picker input:checked')).map(i => parseInt(i.dataset.idx));
    document.getElementById('series-modal').style.display = 'none';
    if (selectedIdx !== -1) plotFlight(flightData[selectedIdx]);
    if (conn.streaming) plotLive();
}

// Rebuilds the graph series-picker checkboxes from the active profile's header.
// Called at startup and whenever the profile changes.
function rebuildSeriesPicker(conn) {
    const picker = document.getElementById('series-picker');
    if (!picker) return;
    picker.innerHTML = '';
    conn.header.forEach((h, i) => {
        if (i === 0) return;
        picker.innerHTML += `<label class="series-opt"><input type="checkbox" data-idx="${i}" ${conn.activeSeries.includes(i) ? 'checked' : ''}> ${h}</label>`;
    });
}

document.getElementById('file-upload').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const contents = e.target.result;
        const allLines = contents.split('\n').map(line => line.trim()).filter(line => line);

        // Optional first line: CONFIG row (saved by this tool when offloaded from device)
        let loadedConfig = "";
        if (allLines.length > 0 && (allLines[0].startsWith("CONFIG\t") || allLines[0].startsWith("CONFIG "))) {
            loadedConfig = allLines.shift();
        }

        // Keep only data rows. Drops any non-data preamble (column header in either
        // firmware or website format, "Logger setup" boot marker, stray MSG lines, etc.)
        // so older raw serial captures load without modification.
        const lines = allLines.filter(line => /^\d/.test(line));

        if (lines.length === 0) {
            logTerm(`Skipped ${file.name}: no data rows found`, "red");
            document.getElementById('file-upload').value = '';
            return;
        }

        // Create a new flight entry from the loaded data
        const profileId = guessProfileFromColumnCount(lines[0].split(/[\s\t]+/).length, ConnectionManager.getActive().profile.id);
        const newFlight = {
            id: Date.now(),
            name: file.name.replace('.txt', ''),
            raw: lines,
            config: loadedConfig,
            profileId
        };

        flightData.push(newFlight);
        refreshList();
        selectFlight(flightData.length - 1);

        logTerm(`Loaded local file: ${file.name}`, "#22c55e");
        // Reset input so you can load the same file again if needed
        document.getElementById('file-upload').value = '';
    };
    reader.readAsText(file);
});

document.getElementById('saveFileBtn').onclick = () => downloadFlight(flightData[selectedIdx]);

document.getElementById('downloadZipBtn').onclick = async () => {
    const zip = new JSZip();
    flightData.forEach(f => {
        zip.file(`${f.name}.txt`, buildFlightText(f));
        if (f.bin) zip.file(`${f.name}.bin`, f.bin); // exact raw records for binary offloads
    });
    const content = await zip.generateAsync({ type: "blob" });
    const a = document.createElement('a'); a.href = URL.createObjectURL(content);
    a.download = "SillyGoose_All_Flights.zip"; a.click();
};

document.getElementById('clearAllBtn').onclick = clearAllSession;
