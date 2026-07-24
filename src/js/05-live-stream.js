// --- Live Stream tab ----------------------------------------------------
let isLiveHovering = false;

// Stream on/off is controlled from the Control Panel (see 07-config-controls.js)
// like any other device action - this tab just reflects the resulting state,
// plus how long ago the last row arrived (lastMessageAt): a stalled link still
// shows "Streaming" from the board's point of view, but a growing age is the tell.
let streamingOn = false;
let lastMessageAt = null;

function refreshStreamingBadge() {
    const el = document.getElementById('live-streaming-status');
    if (!el) return;
    let label = streamingOn ? 'Streaming' : 'Not streaming';
    if (lastMessageAt != null) {
        const s = Math.round((Date.now() - lastMessageAt) / 1000);
        label += s < 1 ? ' · just now' : ` · ${s}s ago`;
    }
    el.textContent = label;
    el.className = 'streaming-badge ' + (streamingOn ? 'streaming-on' : 'streaming-off');
}
// Ticks the "Ns ago" text even when no new rows are arriving (e.g. the link
// stalled, or streaming stopped) - the badge would otherwise freeze at
// whatever it last said instead of reflecting the growing silence.
setInterval(refreshStreamingBadge, 1000);

Telemetry.subscribe('streaming', on => {
    streamingOn = on;
    if (!on) lastMessageAt = null;
    refreshStreamingBadge();
    if (on) startStreamLogging(ConnectionManager.getActive()); else stopStreamLogging();
});

// --- Auto-log streamed data, same text format an offload produces --------
// Desktop: written incrementally to disk (see electron/main.js's
// stream-log:* IPC handlers + window.sgStreamLog in preload.js) so the raw
// stream survives a crash or a forgotten save. Browser build (no filesystem
// access): conn.streamLogLines accumulates in memory instead, and "Save
// Stream Log" below turns it into a flight via the same buildFlightText()/
// import path as any other - compatible with both builds.
const STREAM_LOG_FLUSH_INTERVAL_MS = 2000;
let streamLogFlushTimer = null;
let streamLogPending = [];

function startStreamLogging(conn) {
    streamLogPending = [];
    if (!window.sgStreamLog) return;
    window.sgStreamLog.start({ header: conn.header.join('\t'), profileId: conn.profile.id })
        .catch(e => DebugLog.error('stream-log', 'start failed: ' + e.message));
    if (streamLogFlushTimer) clearInterval(streamLogFlushTimer);
    streamLogFlushTimer = setInterval(flushStreamLog, STREAM_LOG_FLUSH_INTERVAL_MS);
}
function flushStreamLog() {
    if (!window.sgStreamLog || streamLogPending.length === 0) return;
    const lines = streamLogPending;
    streamLogPending = [];
    window.sgStreamLog.append(lines).catch(e => DebugLog.error('stream-log', 'append failed: ' + e.message));
}
function stopStreamLogging() {
    if (streamLogFlushTimer) { clearInterval(streamLogFlushTimer); streamLogFlushTimer = null; }
    flushStreamLog();
    if (window.sgStreamLog) window.sgStreamLog.stop().catch(() => {});
}

const saveStreamLogBtn = document.getElementById('saveStreamLogBtn');
if (saveStreamLogBtn) saveStreamLogBtn.onclick = () => {
    const conn = ConnectionManager.getActive();
    if (!conn.streamLogLines.length) { alert('No streamed data captured yet this session.'); return; }
    saveFlight(conn, conn.streamLogLines, "", null, "Stream");
};

// Redraws a live Plotly chart at most this often, independent of how fast
// data arrives. Plotly.react is expensive per call - re-running it at
// telemetry's actual rate (50-100Hz) is what made a large history buffer
// "completely break" the Live Graph tab, and a human can't perceive updates
// faster than this anyway. `fn.forceNow(...)` bypasses the gate for one call
// (used to redraw immediately when the tab/window becomes visible again).
const LIVE_REDRAW_MIN_INTERVAL_MS = 100; // ~10Hz
function throttleByTime(fn, minIntervalMs) {
    let last = 0;
    const wrapped = (...args) => {
        const now = Date.now();
        if (now - last < minIntervalMs) return;
        last = now;
        fn(...args);
    };
    wrapped.forceNow = (...args) => { last = Date.now(); fn(...args); };
    return wrapped;
}
const throttledPlotLive = throttleByTime(plotLive, LIVE_REDRAW_MIN_INTERVAL_MS);

// Handle one line of live telemetry (text stream, or reconstructed from a
// binary record) - shared by the Live Stream plot and the Live Map tab.
function handleLiveLine(conn, line) {
    const parts = line.split(/[\s\t]+/);
    if (parts.length < conn.profile.oldMinCols) return;
    conn.liveDataBuffer.push(parts);
    if (conn.liveDataBuffer.length > conn.maxLivePoints) conn.liveDataBuffer.shift();

    conn.streamLogLines.push(line);
    streamLogPending.push(line);
    lastMessageAt = Date.now();
    refreshStreamingBadge();

    if (document.getElementById('live-tab').classList.contains('active') && !document.hidden) {
        throttledPlotLive();
    }
    updateLiveMapIfActive(conn);
}

function updateLiveDashboardWithMostRecent() {
    const conn = ConnectionManager.getActive();
    if (conn.liveDataBuffer.length === 0 || isLiveHovering) return;
    const dash = document.getElementById('live-hover-dashboard');
    const last = conn.liveDataBuffer[conn.liveDataBuffer.length - 1];
    const t0 = parseFloat(conn.liveDataBuffer[0][0]);
    const time = (parseFloat(last[0]) - t0) / 1000;

    let html = `<div class="hover-item">Live Time: <span class="hover-val">${time.toFixed(3)}s</span></div>`;
    conn.activeSeries.forEach(idx => {
        html += `<div class="hover-item">${conn.header[idx]}: <span class="hover-val">${parseFloat(last[idx]).toFixed(2)}</span></div>`;
    });
    dash.innerHTML = html;
}

function plotLive() {
    const conn = ConnectionManager.getActive();
    if (conn.liveDataBuffer.length === 0) return;

    const t0 = parseFloat(conn.liveDataBuffer[0][0]);
    const t = conn.liveDataBuffer.map(r => (parseFloat(r[0]) - t0) / 1000);

    const traces = conn.activeSeries.map(idx => {
        const vals = conn.liveDataBuffer.map(r => parseFloat(r[idx]));
        return {
            x: t, y: vals, name: conn.header[idx], mode: 'lines',
            hoverinfo: 'none'
        };
    });

    const gd = document.getElementById('live-plot-container');

    Plotly.react(gd, traces, {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: '#f8fafc' }, margin: { t: 40, r: 20, l: 50, b: 40 },
        hovermode: 'x', xaxis: { title: 'Time (s)', gridcolor: '#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1 },
        yaxis: { gridcolor: '#334155' }, showlegend: true,
        legend: { orientation: 'h', y: 1.1 }
    }, { responsive: true, displaylogo: false }).then(() => {
        setupHoverEvents('live-plot-container', 'live-hover-dashboard', true);
        updateLiveDashboardWithMostRecent();
    });
}

document.getElementById('history-slider').oninput = function () {
    ConnectionManager.getActive().maxLivePoints = parseInt(this.value);
    document.getElementById('hist-val').innerText = this.value;
};
