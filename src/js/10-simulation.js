// ===================== Sensor simulation replay =====================
// window.sgSimulation (electron/preload.js) reads the log via Electron's native file dialog
// + fs, off the renderer thread. In a plain browser it's undefined, so initSimulation() falls
// back to a hidden <input type=file> + the File API instead - see below. Either way the
// streaming itself already runs over Web Serial, which works in both builds, so this is the
// only piece that needed a browser-compatible path.
//
// Replays a recorded flight log back to the board as --sim/--simSize traffic, matching
// scripts/SendSimDataSillyGoose.py's protocol exactly: 8 comma-separated floats per sample
// (pressurePa, tempK, accel x,y,z, gyro x,y,z - see SillyGoose.cpp/SeriousGoose.cpp's
// AVIONICS_ARGUMENT_isSim block), flow-controlled by the firmware's periodic "--simSize N"
// reports (SimulationParser::waitForEntry()) so its 100-slot circular buffer neither
// overflows nor starves - starving it blocks the firmware's whole main loop.

const SIM_STREAM_HZ = 100.0;
const SIM_STREAM_DT_MS = 1000.0 / SIM_STREAM_HZ;
// In-flight samples are ~10ms apart; ground-state samples are ~5s apart (logger.setLogDelay
// on the ground). Anything bigger than this is a ground-state gap, filled by interpolating
// at SIM_STREAM_HZ so the firmware still sees one sample per tick.
const SIM_GAP_THRESHOLD_MS = 30.0;
// Default trim: keep only this many seconds before the ground->flight transition.
const SIM_PREFLIGHT_KEEP_S = 35.0;
// Flow control: out of 100 slots in the firmware's circular buffer, stop sending once its
// reported size hits this; BURST is how many samples go out per --simSize report while below
// it. Same values as the Python reference script - see SimulationParser.h's BUFFER_CAPACITY.
const SIM_HIGH_WATER = 90;
const SIM_BURST = 2;

const sgSimTextEncoder = new TextEncoder();

const Simulation = (() => {
    let running = false;
    let stopRequested = false;
    let latestFwSize = 0;
    let sizeReady = false;
    let sizeWaiters = [];

    // Called from Connection.processLine() whenever a "--simSize N" line arrives.
    function onSizeReport(size) {
        latestFwSize = size;
        sizeReady = true;
        const waiters = sizeWaiters;
        sizeWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    // Resolves on the next onSizeReport(), or after timeoutMs either way - mirrors the Python
    // reference's `threading.Event.wait(timeout=1.0)`, so a dropped report can't hang the loop.
    function waitForSizeReport(timeoutMs) {
        return new Promise((resolve) => {
            const wrapped = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(wrapped, timeoutMs);
            sizeWaiters.push(wrapped);
        });
    }

    // Parses the first 9 tab-separated columns every board's log shares (timestampMs,
    // pressurePa, barometerTemperatureK, accel x,y,z, gyro x,y,z) - true regardless of which
    // altimeter profile logged it, since both put these 9 columns first. Skips any non-data
    // preamble line (CONFIG row, column header, "Logger setup", stray MSG lines, ...) by
    // keeping only lines that start with a digit. Mirrors load_sillygoose().
    function parseLog(text) {
        const rows = [];
        const lines = text.split('\n');
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || !/^\d/.test(line)) continue;
            const parts = line.split('\t');
            if (parts.length < 9) continue;
            const nums = parts.slice(0, 9).map(Number);
            if (nums.some((n) => Number.isNaN(n))) continue;
            rows.push(nums);
        }
        rows.sort((a, b) => a[0] - b[0]);
        return rows;
    }

    // Index of the first sample whose gap from its predecessor drops below the gap threshold -
    // ground logging is sparse, flight logging is dense. -1 if no such transition exists.
    function findLaunchIndex(rows) {
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] - rows[i - 1][0] <= SIM_GAP_THRESHOLD_MS) return i;
        }
        return -1;
    }

    // Drops everything more than keepSeconds before the detected launch transition (or returns
    // rows unchanged if none was found).
    function trimPreflight(rows, keepSeconds) {
        const launchIdx = findLaunchIndex(rows);
        if (launchIdx < 0) return rows;
        const cutoffMs = rows[launchIdx][0] - keepSeconds * 1000.0;
        return rows.filter((r) => r[0] >= cutoffMs);
    }

    // Keeps samples at or after offsetSeconds from the start of the file.
    function trimFromOffset(rows, offsetSeconds) {
        if (!rows.length) return rows;
        const cutoffMs = rows[0][0] + offsetSeconds * 1000.0;
        return rows.filter((r) => r[0] >= cutoffMs);
    }

    // Expands (timestamp, ...) rows into a flat list of 8-float samples (dropping the
    // timestamp - the firmware doesn't need it), interpolating ground-state gaps at
    // SIM_STREAM_HZ so the firmware sees one sample every tick instead of one every ~5s.
    function buildSampleStream(rows) {
        const out = [];
        if (!rows.length) return out;
        out.push(rows[0].slice(1));
        let prev = rows[0];
        for (let i = 1; i < rows.length; i++) {
            const cur = rows[i];
            const dtMs = cur[0] - prev[0];
            if (dtMs > SIM_GAP_THRESHOLD_MS) {
                let t = prev[0] + SIM_STREAM_DT_MS;
                while (t < cur[0]) {
                    const ratio = (t - prev[0]) / dtMs;
                    out.push(prev.map((v, j) => v + (cur[j] - v) * ratio).slice(1));
                    t += SIM_STREAM_DT_MS;
                }
            }
            out.push(cur.slice(1));
            prev = cur;
        }
        return out;
    }

    // Every sample in one burst goes out as a single write() call rather than one call per
    // sample - the encode/write round-trip is the thing that scales with tick rate here, not
    // the string building, so batching it is what actually keeps the loop cheap per tick.
    function sendBurst(writer, list) {
        let text = "";
        for (const s of list) text += "--sim " + s.map((v) => v.toFixed(6)).join(",") + "\n";
        return writer.write(sgSimTextEncoder.encode(text));
    }

    async function run(conn, samples) {
        if (running || !samples.length) return;
        running = true;
        stopRequested = false;
        latestFwSize = 0;
        sizeReady = false;
        conn.simActive = true;
        setSerialEnabled(false); // the writer below holds port.writable locked for the whole run
        simShowRunningUI(true);
        simProgress(0);

        const writer = conn.port.writable.getWriter();
        try {
            // Blind initial fill: waitForEntry() blocks until at least one --sim arrives, so
            // the firmware has nothing to report a size for until this goes out.
            let idx = Math.min(SIM_BURST, samples.length);
            await sendBurst(writer, samples.slice(0, idx));
            updateSimProgress(idx, samples.length);

            // Steady state: each --simSize N report, send min(BURST, HIGH_WATER - N). Below
            // HIGH_WATER that's a full burst every tick (buffer grows); at/above it we only
            // send once the firmware reports it drained some. BURST is bounded and the
            // firmware can't grow the buffer without our sends, so overflow can't happen.
            while (idx < samples.length && !stopRequested) {
                if (!sizeReady) { await waitForSizeReport(1000); continue; }
                sizeReady = false;
                const toSend = Math.max(0, Math.min(SIM_BURST, SIM_HIGH_WATER - latestFwSize, samples.length - idx));
                if (toSend > 0) {
                    await sendBurst(writer, samples.slice(idx, idx + toSend));
                    idx += toSend;
                    updateSimProgress(idx, samples.length);
                }
            }
            simStatus(stopRequested ? `Stopped at ${idx} / ${samples.length}.` : "Streaming complete.", stopRequested ? "#f59e0b" : "#22c55e");
        } catch (e) {
            simStatus("Error: " + e.message, "#ef4444");
        } finally {
            try { writer.releaseLock(); } catch (e) {}
            running = false;
            conn.simActive = false;
            setSerialEnabled(!!conn.port);
            simShowRunningUI(false);
        }
    }

    function stop() {
        stopRequested = true;
    }

    return {
        onSizeReport, parseLog, findLaunchIndex, trimPreflight, trimFromOffset, buildSampleStream,
        run, stop,
        get running() { return running; }
    };
})();

function simStatus(msg, color = '#cbd5e1') {
    const el = document.getElementById('sim-status');
    if (el) { el.textContent = msg; el.style.color = color; }
}

function simProgress(pct) {
    const wrap = document.getElementById('sim-progress-wrap');
    const bar = document.getElementById('sim-progress-bar');
    if (!wrap || !bar) return;
    if (pct == null) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// Throttled to at most once every 25 samples (~4/s at the 100Hz sample rate) - frequent
// enough to look live, far too infrequent for the DOM work to slow down the write loop.
let simLastProgressUpdate = -25;
function updateSimProgress(sent, total) {
    if (sent - simLastProgressUpdate < 25 && sent < total) return;
    simLastProgressUpdate = sent;
    simProgress(total ? (sent / total) * 100 : 0);
    simStatus(`Sending... ${sent} / ${total} samples`);
}

function simShowRunningUI(isRunning) {
    document.getElementById('sim-start-btn').style.display = isRunning ? 'none' : '';
    document.getElementById('sim-stop-btn').style.display = isRunning ? '' : 'none';
    document.getElementById('sim-choose-btn').disabled = isRunning;
    document.getElementById('sim-start-offset').disabled = isRunning;
}

let simLoadedRows = null;

function simDescribeFile(rows) {
    const infoEl = document.getElementById('sim-file-info');
    if (!infoEl) return;
    if (!rows.length) { infoEl.textContent = 'No data rows found in this file.'; return; }
    const durationS = (rows[rows.length - 1][0] - rows[0][0]) / 1000.0;
    const launchIdx = Simulation.findLaunchIndex(rows);
    infoEl.textContent = launchIdx >= 0
        ? `${rows.length} rows, ${durationS.toFixed(0)}s total, launch ~${((rows[launchIdx][0] - rows[0][0]) / 1000.0).toFixed(0)}s in`
        : `${rows.length} rows, ${durationS.toFixed(0)}s total, no launch transition detected`;
}

// Shared by both the desktop (sgSimulation.chooseFile) and browser (<input type=file>) paths.
function simLoadFile(name, text) {
    simLoadedRows = Simulation.parseLog(text);
    document.getElementById('sim-file-name').textContent = name;
    simDescribeFile(simLoadedRows);
    document.getElementById('sim-start-btn').disabled = simLoadedRows.length === 0;
    simStatus('');
}

function initSimulation() {
    document.getElementById('sim-choose-btn').onclick = async () => {
        if (!window.sgSimulation) {
            // Browser build: no native dialog, so drive the hidden <input type=file> instead.
            document.getElementById('sim-file-input').click();
            return;
        }
        try {
            const file = await window.sgSimulation.chooseFile();
            if (!file) return;
            simLoadFile(file.name, file.text);
        } catch (e) {
            simStatus('File error: ' + e.message, '#ef4444');
        }
    };

    document.getElementById('sim-file-input').onchange = async (e) => {
        const file = e.target.files[0];
        e.target.value = ''; // reset so re-choosing the same file still fires 'change'
        if (!file) return;
        try {
            simLoadFile(file.name, await file.text());
        } catch (err) {
            simStatus('File error: ' + err.message, '#ef4444');
        }
    };

    document.getElementById('sim-start-btn').onclick = () => {
        const conn = ConnectionManager.getActive();
        if (!conn.port) { simStatus('Connect to a board first.', '#ef4444'); return; }
        if (!simLoadedRows || !simLoadedRows.length) return;

        const offsetRaw = document.getElementById('sim-start-offset').value.trim();
        let rows;
        if (offsetRaw === '') {
            rows = Simulation.trimPreflight(simLoadedRows, SIM_PREFLIGHT_KEEP_S);
        } else {
            const offset = parseFloat(offsetRaw);
            rows = Number.isNaN(offset) ? simLoadedRows : Simulation.trimFromOffset(simLoadedRows, offset);
        }
        const samples = Simulation.buildSampleStream(rows);
        if (!samples.length) { simStatus('Nothing to send after trimming.', '#ef4444'); return; }
        simLastProgressUpdate = -25;
        Simulation.run(conn, samples);
    };

    document.getElementById('sim-stop-btn').onclick = () => Simulation.stop();
}

// Run as soon as the DOM is ready, same as 08-firmware.js - the tab is always shown, this just
// wires it up (desktop) or grays it out (browser).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSimulation);
else initSimulation();
