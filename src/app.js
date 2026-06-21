    let port, reader, inputDone, keepReading = true;
    let flightData = [];
    let selectedIdx = -1;
    let termBuffer = "";
    let cmdHistory = [];
    let historyIdx = -1;

    let recording = false;
    let streaming = false;
    let currentFlightLines = [];
    let currentFlightBin = []; // raw record bytes for the current flight when offloaded in binary
    let currentConfigLine = "";
    let liveDataBuffer = [];
    let maxLivePoints = 200;
    let isLiveHovering = false;

    const HEADER = [
        "timestampMs", "pressurePa", "tempK", "accelX", "accelY", "accelZ",
        "gyroX", "gyroY", "gyroZ", "imuTemp", "battV", "altitudeM",
        "velocityMS", "accelerationMSS", "unfiltAlt", "flightState",
        "drogueCont", "drogueFired", "mainCont", "mainFired",
        "tiltMagnitudeDeg", "angularVelRadS_x", "angularVelRadS_y", "angularVelRadS_z",
        "quaternion_a", "quaternion_b", "quaternion_c", "quaternion_d"
    ];
    // Minimum column count for old (pre-orientation) log format. Live-stream parser uses this
    // so old firmware streams still pass the length check; missing trailing columns plot as NaN.
    const OLD_MIN_COLS = 20;

    const stateNames = {0:"PRE_FLIGHT", 1:"ASCENT", 2:"DESCENT", 3:"POST_FLIGHT"};
    let activeSeries = [11, 12, 13];

    // --- Binary offload protocol (mirrors firmware BasicLogger.h) ---
    const BIN_MAGIC = [0x53, 0x47, 0x42]; // 'SGB'
    const BIN_DATA_SIZE = 100; // sizeof(SillyGooseLogData), packed
    const LOG_EMPTY = 0xFF, LOG_DATA = 0x01, LOG_NEW_FLIGHT = 0x02, LOG_MESSAGE = 0x03, LOG_MESSAGE_CONTINUATION = 0x04;
    // Exact firmware LOG_HEADER string, used only to fingerprint the struct layout.
    // MUST match SillyGoose.cpp LOG_HEADER. If the firmware struct/header changes
    // and this isn't updated to match, the CRC check fails loudly (rather than
    // silently misparsing) so offloads can't be quietly corrupted.
    const FW_LOG_HEADER = "timestampMs\tpressurePa\tbarometerTemperatureK\taccelerationMSS_x\taccelerationMSS_y\taccelerationMSS_z\tvelocityRadS_x\tvelocityRadS_y\tvelocityRadS_z\timuTemperatureK\tbatteryVoltageV\taltitudeM\tvelocityMS\taccelerationMSS\tunfilteredAltitudeM\tflightState\tdrogueContinuity\tdrogueFired\tmainContinuity\tmainFired\ttiltMagnitudeDeg\tangularVelRadS_x\tangularVelRadS_y\tangularVelRadS_z\tquaternion_a\tquaternion_b\tquaternion_c\tquaternion_d";
    // CRC-16/CCITT (poly 0x1021, init 0xFFFF) — matches firmware src/util/CRC.h crc16().
    function crc16(bytes) {
        let crc = 0xFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc ^= bytes[i] << 8;
            for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
        return crc & 0xFFFF;
    }
    const FW_HEADER_CRC = crc16(Array.from(FW_LOG_HEADER, c => c.charCodeAt(0)));
    const td = new TextDecoder();
    let binMsgBytes = [];
    function concatU8(a, b) { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
    function concatChunks(chunks) { let n = 0; for (const c of chunks) n += c.length; const r = new Uint8Array(n); let o = 0; for (const c of chunks) { r.set(c, o); o += c.length; } return r; }

    const configs = [
        { id: "DROGUE_DELAY", label: "Drogue Delay (milliseconds)" },
        { id: "MAIN_ELEVATION", label: "Main Elevation (meters)" },
        { id: "BATTERY_VOLTAGE_SENSOR_SCALE_FACTOR", label: "Battery Scale Factor" },
        { id: "GROUND_ELEVATION", label: "Ground Elevation Offset (meters)" },
        { id: "GROUND_TEMPERATURE", label: "Ground Temperature (kelvin)" },
        { id: "PYRO_FIRE_DURATION", label: "Pyro Duration (milliseconds)" },
        { id: "BOARD_NAME", label: "Board Name" },
        { id: "BUZZER_ENABLED", label: "Buzzer Enabled", type: "checkbox" },
        { id: "CONFIGURATION_VERSION", label: "Config Version" },
        { id: "FIRMWARE_VERSION", label: "Firmware Version", readOnly: true }
    ];

    function formatLogTime(seconds) {
        const s = parseInt(seconds);
        if (isNaN(s)) return "-";
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        return `${hrs}h ${mins}m ${secs}s`;
    }

    function setBusy(val) {
        document.getElementById('busy-loader').style.display = val ? 'block' : 'none';
        if (!val && port) setSerialEnabled(true);
    }

    async function connect() {
        try {
            // In the desktop app the Electron main process applies the full
            // SillyGoose-aware picker (incl. listing all ports as a fallback), so
            // request unfiltered there. In a plain browser, narrow the native
            // chooser to Adafruit (SillyGoose) boards — the best a browser allows —
            // falling back to an unfiltered request if nothing matches.
            const isElectron = navigator.userAgent.toLowerCase().includes('electron');
            if (isElectron) {
                port = await navigator.serial.requestPort();
            } else {
                try {
                    port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x239A }] });
                } catch (filterErr) {
                    if (filterErr && filterErr.name === 'NotFoundError') {
                        port = await navigator.serial.requestPort();
                    } else {
                        throw filterErr;
                    }
                }
            }
            await port.open({ baudRate: 115200 });
            document.getElementById('connectBtn').style.display = 'none';
            document.getElementById('disconnectBtn').style.display = 'block';
            setSerialEnabled(true);
            keepReading = true;
            readLoop();
            if (window.sgFirmware) fwDetectVariant();
        } catch (e) { logTerm("Connection Error: " + e.message, "red"); }
    }

    async function disconnect() {
        keepReading = false;
        if (reader) { await reader.cancel().catch(() => {}); reader = null; }
        if (port) { await port.close(); port = null; }
        forceUIDisconnect();
    }

    function forceUIDisconnect() {
        port = null; setBusy(false); recording = false; streaming = false;
        document.getElementById('connectBtn').style.display = 'block';
        document.getElementById('disconnectBtn').style.display = 'none';
        setSerialEnabled(false);
    }

    // Handle one logical text line (from the text stream, or reconstructed from a
    // binary message record). Mirrors the original per-line offload logic.
    function processLine(line) {
        logTerm(line);

        if (line.includes("Entries in log:")) document.getElementById('log-entries').innerText = line.split(':').pop().trim();
        if (line.includes("Remaining log length:")) {
            const rawVal = line.split(':').pop().trim();
            document.getElementById('log-rem').innerText = formatLogTime(rawVal);
        }
        if (line.includes("Logging")) document.getElementById('log-status').innerText = line.includes("enabled") ? "ON" : "OFF";

        if (line.includes("Streaming enabled")) { streaming = true; liveDataBuffer = []; }
        if (line.includes("Streaming disabled")) streaming = false;

        const setMatch = line.match(/MSG:\s+([A-Z_]+)\s+is set to:\s+(.+)/);
        if (setMatch) {
            const inputEl = document.getElementById(`in-${setMatch[1]}`);
            if (inputEl) {
                const v = setMatch[2].trim();
                if (inputEl.type === 'checkbox') inputEl.checked = (v !== '0' && v.toLowerCase() !== 'false');
                else inputEl.value = v;
            }
            setBusy(false);
        }

        if (line.includes("Starting Offload")) { recording = true; currentFlightLines = []; currentFlightBin = []; currentConfigLine = ""; setBusy(true); return; }

        if (streaming && /^\d/.test(line)) handleLiveLine(line);

        if (recording) {
            if (line.includes("Logger setup")) { if (currentFlightLines.length > 5) saveFlight(currentFlightLines, currentConfigLine, currentFlightBin); currentFlightLines = []; currentFlightBin = []; currentConfigLine = ""; return; }
            if (line.includes("Ending Offload")) { if (currentFlightLines.length > 5) saveFlight(currentFlightLines, currentConfigLine, currentFlightBin); recording = false; currentFlightLines = []; currentFlightBin = []; currentConfigLine = ""; setBusy(false); return; }
            if (line.startsWith("CONFIG\t") || line.startsWith("CONFIG ")) { currentConfigLine = line; return; }
            if (/^\d/.test(line)) currentFlightLines.push(line);
        }
        if (line.includes("Erase Complete")) setBusy(false);
    }

    // Flush an accumulated binary message record into the normal line handler
    // (carries "Logger setup" flight boundaries and "CONFIG\t..." rows).
    function flushBinMessage() {
        if (!binMsgBytes.length) return;
        const nul = binMsgBytes.indexOf(0);
        const bytes = nul >= 0 ? binMsgBytes.slice(0, nul) : binMsgBytes;
        const str = td.decode(new Uint8Array(bytes)).trim();
        binMsgBytes = [];
        if (str) processLine(str);
    }

    // Decode one packed LOG_DATA record into a tab-joined row in HEADER order.
    function decodeDataRecord(rec) {
        const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
        let o = 1; // skip the id byte
        const f = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
        const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
        const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
        const b = () => dv.getUint8(o++);
        const c = [
            u32(),                   // timestampMs
            f(), f(),                // pressurePa, barometerTemperatureK
            f(), f(), f(),           // accel x,y,z
            f(), f(), f(),           // gyro x,y,z
            f(),                     // imuTemperatureK
            f(), f(), f(), f(), f(), // battV, altitudeM, velocityMS, accelerationMSS, unfilteredAltitudeM
            i32(),                   // flightState
            b(), b(), b(), b(),      // drogueCont, drogueFired, mainCont, mainFired
            f(), f(), f(), f(),      // tiltMagnitudeDeg, angularVel x,y,z
            f(), f(), f(), f()       // quaternion a,b,c,d
        ];
        return c.map(v => Number.isInteger(v) ? String(v) : String(+v.toFixed(6))).join('\t');
    }

    function processBinRecord(id, rec) {
        if (id !== LOG_MESSAGE_CONTINUATION) flushBinMessage();
        if (id === LOG_DATA) {
            if (recording) { currentFlightLines.push(decodeDataRecord(rec)); currentFlightBin.push(rec); }
        } else if (id === LOG_MESSAGE || id === LOG_MESSAGE_CONTINUATION) {
            for (let i = 1; i < rec.length; i++) binMsgBytes.push(rec[i]);
        }
        // LOG_NEW_FLIGHT: flight splitting is driven by the "Logger setup" message
    }

    async function readLoop() {
        while (port && port.readable && keepReading) {
            reader = port.readable.getReader();
            let buf = new Uint8Array(0);
            let mode = 'text'; // 'text' | 'preamble' | 'records' | 'skip'
            let recordSize = 0;

            try {
                while (keepReading) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf = concatU8(buf, value);

                    let progress = true;
                    while (progress) {
                        progress = false;

                        if (mode === 'text') {
                            // A binary blob begins at a line boundary with the magic bytes.
                            if (buf.length >= 3 && buf[0] === BIN_MAGIC[0] && buf[1] === BIN_MAGIC[1] && buf[2] === BIN_MAGIC[2]) {
                                mode = 'preamble'; progress = true; continue;
                            }
                            const nl = buf.indexOf(10); // '\n'
                            if (nl >= 0) {
                                const line = td.decode(buf.slice(0, nl)).replace(/\r$/, '').trim();
                                buf = buf.slice(nl + 1);
                                if (line) processLine(line);
                                progress = true;
                            }
                        } else if (mode === 'preamble') {
                            if (buf.length >= 7) {
                                const dataSize = buf[3] | (buf[4] << 8);
                                const headerCrc = buf[5] | (buf[6] << 8);
                                buf = buf.slice(7);
                                recordSize = 1 + dataSize;
                                if (dataSize !== BIN_DATA_SIZE || headerCrc !== FW_HEADER_CRC) {
                                    logTerm(`Binary offload mismatch (size ${dataSize}, crc ${headerCrc}). Update this tool to match firmware; skipping records.`, "red");
                                    mode = 'skip';
                                } else {
                                    mode = 'records';
                                }
                                progress = true;
                            }
                        } else { // 'records' or 'skip'
                            if (buf.length >= 1 && buf[0] === LOG_EMPTY) {
                                buf = buf.slice(1);
                                if (mode === 'records') flushBinMessage();
                                mode = 'text';
                                progress = true;
                            } else if (buf.length >= recordSize) {
                                const rec = buf.slice(0, recordSize);
                                const id = buf[0];
                                buf = buf.slice(recordSize);
                                if (mode === 'records') processBinRecord(id, rec);
                                progress = true;
                            }
                        }
                    }
                }
            } catch (e) { break; } finally { if (reader) { reader.releaseLock(); reader = null; } }
        }
    }

    document.getElementById('file-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
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
            const flightNum = flightData.length + 1;
            const newFlight = {
                id: Date.now(),
                name: file.name.replace('.txt', ''),
                raw: lines,
                config: loadedConfig
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

    function handleLiveLine(line) {
        const parts = line.split(/[\s\t]+/);
        if (parts.length < OLD_MIN_COLS) return;
        liveDataBuffer.push(parts);
        if (liveDataBuffer.length > maxLivePoints) liveDataBuffer.shift();

        if (document.getElementById('live-tab').classList.contains('active') && !document.hidden) {
            requestAnimationFrame(plotLive);
        }
    }

    function updateLiveDashboardWithMostRecent() {
        if (liveDataBuffer.length === 0 || isLiveHovering) return;
        const dash = document.getElementById('live-hover-dashboard');
        const last = liveDataBuffer[liveDataBuffer.length - 1];
        const t0 = parseFloat(liveDataBuffer[0][0]);
        const time = (parseFloat(last[0]) - t0) / 1000;

        let html = `<div class="hover-item">Live Time: <span class="hover-val">${time.toFixed(3)}s</span></div>`;
        activeSeries.forEach(idx => {
            html += `<div class="hover-item">${HEADER[idx]}: <span class="hover-val">${parseFloat(last[idx]).toFixed(2)}</span></div>`;
        });
        dash.innerHTML = html;
    }

    function plotLive() {
        if (liveDataBuffer.length === 0) return;

        const t0 = parseFloat(liveDataBuffer[0][0]);
        const t = liveDataBuffer.map(r => (parseFloat(r[0]) - t0) / 1000);

        const traces = activeSeries.map(idx => {
            const vals = liveDataBuffer.map(r => parseFloat(r[idx]));
            return {
                x: t, y: vals, name: HEADER[idx], mode: 'lines',
                hoverinfo: 'none'
            };
        });

        const gd = document.getElementById('live-plot-container');

        Plotly.react(gd, traces, {
            paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
            font:{color:'#f8fafc'}, margin:{t:40, r:20, l:50, b:40},
            hovermode:'x', xaxis:{title:'Time (s)', gridcolor:'#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1},
            yaxis:{gridcolor:'#334155'}, showlegend: true,
            legend: { orientation: 'h', y: 1.1 }
        }, {responsive: true, displaylogo: false}).then(() => {
            setupHoverEvents('live-plot-container', 'live-hover-dashboard', true);
            updateLiveDashboardWithMostRecent();
        });
    }

    async function sendCmd(msg) {
        if (!port || !port.writable) return;
        setBusy(true);
        const writer = port.writable.getWriter();
        await writer.write(new TextEncoder().encode(msg + "\n"));
        writer.releaseLock();
        logTerm(`>> ${msg}`, "#38bdf8");
        if(!msg.includes("offload") && !msg.includes("erase") && !msg.includes("streamLog")) setTimeout(() => setBusy(false), 800);
    }

    function saveFlight(lines, configLine = "", binChunks = null) {
        const flightNum = flightData.length + 1;
        const flight = { id: Date.now(), name: `Flight_${flightNum}`, raw: [...lines], config: configLine || "" };
        // Exact byte-for-byte raw records, present only for binary offloads.
        if (binChunks && binChunks.length) flight.bin = concatChunks(binChunks);
        flightData.push(flight);
        refreshList();
        selectFlight(flightData.length - 1);
    }

    // True if any row in the flight is in ASCENT (1) or DESCENT (2). Cached since raw never changes.
    function flightHasAscentDescent(f) {
        if (f._hasAD === undefined) {
            f._hasAD = f.raw.some(l => { const s = parseInt(l.split(/[\s\t]+/)[15]); return s === 1 || s === 2; });
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
            item.innerHTML = `<span>${f.name}</span><button class="del-btn" onclick="event.stopPropagation(); deleteLog(${i})">×</button>`;
            item.onclick = () => selectFlight(i);
            list.appendChild(item);
        });
        document.getElementById('clearAllBtn').disabled = (flightData.length === 0);
        document.getElementById('downloadZipBtn').disabled = (flightData.length === 0);
    }

    const FLIGHT_STATE_NAMES = {0:"PRE_FLIGHT", 1:"ASCENT", 2:"DESCENT", 3:"POST_FLIGHT", 4:"UNKNOWN_FLIGHT_STATE"};
    const BOARD_ORIENTATION_NAMES = {0:"ERROR_AXIS_DIRECTION", 1:"POS_X", 2:"NEG_X", 3:"POS_Y", 4:"NEG_Y", 5:"POS_Z", 6:"NEG_Z"};
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
        const rows = flight.raw.map(l => l.split(/[\s\t]+/));
        const t0 = parseFloat(rows[0][0]);
        const t = rows.map(r => (parseFloat(r[0]) - t0) / 1000);

        const traces = activeSeries.map(idx => {
            const vals = rows.map(r => parseFloat(r[idx]));
            return {
                x: t, y: vals, name: HEADER[idx], mode: 'lines',
                hoverinfo: 'none'
            };
        });

        const states = rows.map(r => parseInt(r[15]));
        const shapes = [], annotations = [];
        const addEv = (time, txt, col) => {
            shapes.push({ type:'line', x0:time, x1:time, y0:0, y1:1, yref:'paper', line:{color:col, width:1, dash:'dash'} });
            annotations.push({ x:time, y:1, yref:'paper', text:txt, showarrow:false, textangle:-90, xanchor:'right', font:{color:col, size:9} });
        };

        for (let i = 1; i < states.length; i++) {
            if (states[i] !== states[i-1]) addEv(t[i], `${stateNames[states[i-1]]} → ${stateNames[states[i]]}`, 'green');
            if (rows[i][17] == "1" && rows[i-1][17] == "0") addEv(t[i], "DROGUE FIRED", "purple");
            if (rows[i][19] == "1" && rows[i-1][19] == "0") addEv(t[i], "MAIN FIRED", "blue");
        }

        const gd = document.getElementById('plot-container');
        Plotly.newPlot(gd, traces, {
            paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
            font:{color:'#f8fafc'}, margin:{t:60, r:20, l:50, b:40},
            hovermode:'x', xaxis:{title:'Time (s)', gridcolor:'#334155', showspikes: true, spikemode: 'across', spikesnap: 'cursor', spikedash: 'dash', spikecolor: '#94a3b8', spikethickness: 1},
            yaxis:{title:'Data', gridcolor:'#334155'}, shapes, annotations,
            showlegend: true,
            legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1, font: { size: 10, color: '#94a3b8' } }
        }, {responsive: true, displaylogo: false}).then(() => {
            setupHoverEvents('plot-container', 'hover-dashboard', false);
        });

        document.getElementById('stat-alt').innerText = Math.max(...rows.map(r => parseFloat(r[11]))).toFixed(1);
        document.getElementById('stat-vel').innerText = Math.max(...rows.map(r => parseFloat(r[12]))).toFixed(1);
        document.getElementById('stat-state').innerText = stateNames[states[states.length-1]] || '-';
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

    function setSerialEnabled(en) {
        document.querySelectorAll('.ctrl-btn, .cfg-get, .cfg-set, #sendBtn, #offloadBtn, #offloadBinBtn, #getAllBtn, #eraseBtn, #streamStartBtn, #streamStopBtn, #logStartBtn, #logStopBtn, #logHealthBtn').forEach(b => b.disabled = !en);
    }

    function initUI() {
        document.getElementById('filter-flightstate').onchange = refreshList;
        const picker = document.getElementById('series-picker');
        HEADER.forEach((h, i) => {
            if(i === 0) return;
            picker.innerHTML += `<label class="series-opt"><input type="checkbox" data-idx="${i}" ${activeSeries.includes(i) ? 'checked' : ''}> ${h}</label>`;
        });
        const cfgContainer = document.getElementById('config-fields');
        configs.forEach(cfg => {
            const readOnlyAttr = cfg.readOnly ? ' readonly' : '';
            const inputHtml = cfg.type === 'checkbox'
                ? `<input type="checkbox" id="in-${cfg.id}" style="width:20px; height:24px; flex-grow:0; align-self:center; margin-right:auto;"${readOnlyAttr}>`
                : `<input type="text" id="in-${cfg.id}" placeholder="..."${readOnlyAttr}>`;
            const setBtnHtml = cfg.readOnly ? '' : `<button class="btn cfg-set" data-id="${cfg.id}" style="width:50px; padding:2px; height:24px; font-size:0.7rem">Set</button>`;
            cfgContainer.innerHTML += `
                <div class="config-item">
                    <div class="config-label">${cfg.label}</div>
                    <div class="config-input-group">
                        ${inputHtml}
                        <button class="btn btn-secondary cfg-get" data-id="${cfg.id}" style="width:50px; padding:2px; height:24px; font-size:0.7rem">Get</button>
                        ${setBtnHtml}
                    </div>
                </div>`;
        });
    }

    function deleteLog(i) {
        flightData.splice(i, 1);
        if(selectedIdx === i) {
            selectedIdx = -1;
            Plotly.purge('plot-container');
            document.getElementById('saveFileBtn').disabled = true;
            document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
        }
        refreshList();
    }

    function clearAllSession() {
        if(confirm("Clear current session flights?")) {
            flightData = []; selectedIdx = -1;
            Plotly.purge('plot-container');
            document.getElementById('saveFileBtn').disabled = true;
            document.getElementById('hover-dashboard').innerHTML = `<div style="color: #64748b; font-style: italic;">Hover over the chart to see data...</div>`;
            refreshList();
        }
    }

    function openTab(id) {
        document.querySelectorAll('.tab-content, .tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        if (event) event.currentTarget.classList.add('active');
    }

    function openSeriesModal() { document.getElementById('series-modal').style.display = 'flex'; }
    function closeSeriesModal() {
        activeSeries = Array.from(document.querySelectorAll('#series-picker input:checked')).map(i => parseInt(i.dataset.idx));
        document.getElementById('series-modal').style.display = 'none';
        if(selectedIdx !== -1) plotFlight(flightData[selectedIdx]);
        if(streaming) plotLive();
    }

    async function confirmErase() { if(confirm("⚠️ Erase flash?")) await sendCmd("--erase"); }

    const cmdInput = document.getElementById('cmd-input');
    cmdInput.onkeydown = e => {
        if(e.key === 'Enter') {
            const val = cmdInput.value.trim();
            if(val) { sendCmd(val); cmdHistory.push(val); historyIdx = cmdHistory.length; cmdInput.value = ''; }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIdx > 0) { historyIdx--; cmdInput.value = cmdHistory[historyIdx]; }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIdx < cmdHistory.length - 1) { historyIdx++; cmdInput.value = cmdHistory[historyIdx]; } else { historyIdx = cmdHistory.length; cmdInput.value = ''; }
        }
    };

    document.getElementById('history-slider').oninput = function() {
        maxLivePoints = parseInt(this.value);
        document.getElementById('hist-val').innerText = this.value;
    };

    function buildFlightText(f) {
        const parts = [];
        if (f.config) parts.push(f.config);
        parts.push(HEADER.join("\t"));
        parts.push(f.raw.join("\n"));
        return parts.join("\n");
    }

    document.getElementById('saveFileBtn').onclick = () => {
        const f = flightData[selectedIdx];
        const blob = new Blob([buildFlightText(f)], {type: 'text/plain'});
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = f.name + ".txt"; a.click();
    };

    document.getElementById('downloadZipBtn').onclick = async () => {
        const zip = new JSZip();
        flightData.forEach(f => {
            zip.file(`${f.name}.txt`, buildFlightText(f));
            if (f.bin) zip.file(`${f.name}.bin`, f.bin); // exact raw records for binary offloads
        });
        const content = await zip.generateAsync({type:"blob"});
        const a = document.createElement('a'); a.href = URL.createObjectURL(content);
        a.download = "SillyGoose_All_Flights.zip"; a.click();
    };

    document.getElementById('connectBtn').onclick = connect;
    document.getElementById('disconnectBtn').onclick = disconnect;
    document.getElementById('offloadBtn').onclick = () => sendCmd("--offload");
    document.getElementById('offloadBinBtn').onclick = () => sendCmd("--offload -b");
    document.getElementById('clearAllBtn').onclick = clearAllSession;
    document.getElementById('getAllBtn').onclick = () => configs.forEach((c, i) => setTimeout(() => sendCmd(`--${c.id}`), i * 150));

    window.onload = initUI;

    document.addEventListener('click', e => {
        if(e.target.classList.contains('cfg-get')) {
            const id = e.target.dataset.id;
            sendCmd(`--${id}`);
        }
        if(e.target.classList.contains('cfg-set')) {
            const id = e.target.dataset.id;
            const el = document.getElementById(`in-${id}`);
            const val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
            sendCmd(`--${id} -set ${val}`);
        }
        if(e.target.classList.contains('ctrl-btn')) {
            sendCmd(e.target.dataset.cmd);
        }
    });

    // ===================== Firmware update (desktop app only) =====================
    // window.sgFirmware is exposed by electron/preload.js. In a plain browser it is
    // undefined, so the Firmware tab stays hidden and this code never runs.

    const fwSleep = (ms) => new Promise(r => setTimeout(r, ms));
    let fwReleases = null;       // { flight: [...], notFlightTested: [...] }
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

    function fwPopulateVersions() {
        const channel = document.getElementById('fw-channel').value;
        const sel = document.getElementById('fw-version');
        const list = (fwReleases && fwReleases[channel]) || [];
        sel.innerHTML = '';
        if (!list.length) { sel.innerHTML = '<option value="">(none available)</option>'; return; }
        list.forEach((r, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = r.isLatest ? `Latest — ${r.label}` : r.label;
            sel.appendChild(opt);
        });
        sel.value = '0';
    }

    function fwSelectedAssetUrl() {
        const channel = document.getElementById('fw-channel').value;
        const variant = document.getElementById('fw-variant').value;
        const idx = parseInt(document.getElementById('fw-version').value, 10);
        const rel = ((fwReleases && fwReleases[channel]) || [])[idx];
        return rel ? (rel.assets[variant] || null) : null;
    }

    // Auto-detect the V1/V2 firmware variant from the USB product descriptor of
    // the connected board (e.g. "SillyGooseV2"). NOT the user-writable BOARD_NAME.
    // Safe to call repeatedly (on connect / when opening the tab).
    async function fwDetectVariant() {
        if (!window.sgFirmware) return;
        try {
            const info = await window.sgFirmware.boardInfo();
            const name = (info && info.displayName) || '';
            const m = name.match(/V(\d)/i);
            const detEl = document.getElementById('fw-detected');
            if (m) {
                document.getElementById('fw-variant').value = 'V' + m[1];
                if (detEl) detEl.textContent = `detected ${name}`;
            } else if (detEl) {
                detEl.textContent = name ? `connected as "${name}" — pick the variant manually` : '';
            }
        } catch (e) {}
    }

    // 1200-baud touch: reset the SAMD21 into its UF2 bootloader using the
    // currently-connected port, then release it. Mirrors the Arduino touch1200.
    async function fwEnterBootloaderViaTouch() {
        const p = port;
        if (!p) return;
        // Remember the running app's USB productId. The UF2 bootloader enumerates
        // under the same vendor (0x239A) but a DIFFERENT productId, so this lets
        // auto-reconnect skip the bootloader's CDC port and wait for the app.
        try { fwAppPid = (p.getInfo && p.getInfo().usbProductId) || null; } catch (e) { fwAppPid = null; }
        keepReading = false;                                   // stop readLoop re-grabbing the reader
        if (reader) { try { await reader.cancel(); } catch (e) {} }
        // Wait for readLoop's finally to release the reader lock before we close.
        for (let i = 0; i < 25 && p.readable && p.readable.locked; i++) await fwSleep(30);
        try { await p.close(); } catch (e) {}
        forceUIDisconnect();                                   // clears global `port` + UI; `p` still valid
        await fwSleep(250);
        await p.open({ baudRate: 1200 });                      // the touch
        await fwSleep(150);
        try { await p.close(); } catch (e) {}                  // close at 1200 -> board jumps to bootloader
        await fwSleep(400);
    }

    // Open a candidate port and wire up the UI. Returns true on success.
    async function fwAdoptPort(p) {
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
        port = p;
        document.getElementById('connectBtn').style.display = 'none';
        document.getElementById('disconnectBtn').style.display = 'block';
        setSerialEnabled(true);
        keepReading = true;
        readLoop();
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
    async function fwTryAutoReconnect(timeoutMs = 15000) {
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
                    if (await fwAdoptPort(p)) return true;
                }
                // Otherwise try every authorized port (including the old handle).
                let ports = [];
                try { ports = await navigator.serial.getPorts(); } catch (e) {}
                for (const p of ports) {
                    if (fwReconnectCancel) return false;
                    if (await fwAdoptPort(p)) return true;
                }
                await fwSleep(400);
            }
            return false;
        } finally {
            navigator.serial.removeEventListener('connect', onConnect);
        }
    }

    async function fwDoUpdate(isRetry) {
        if (fwBusy) return;
        const url = fwSelectedAssetUrl();
        if (!url) { fwStatus('No firmware available for that selection.', '#ef4444'); return; }
        const variant = document.getElementById('fw-variant').value;
        const channel = document.getElementById('fw-channel').value;
        const connected = !!port;

        if (!isRetry) {
            const how = connected
                ? 'The board will be reset into its bootloader automatically.'
                : 'Your board is not connected — you will need to double-tap the RESET button.';
            const warn = channel === 'notFlightTested' ? '\n\n⚠ This is a NOT-FLIGHT-TESTED build.' : '';
            if (!confirm(`Flash ${variant} firmware?\n\n${how}${warn}`)) return;
        }

        fwBusy = true;
        fwAppPid = null;           // recaptured by the touch below (connected path only)
        document.getElementById('fw-update-btn').disabled = true;
        fwShowBtn('fw-retry-btn', false);
        fwShowBtn('fw-reconnect-btn', false);
        try {
            // 1) Download first — the board stays untouched if this fails.
            fwStatus('Downloading firmware…');
            const uf2Path = await window.sgFirmware.download(url);

            // 2) Enter the bootloader (auto touch when connected, else manual).
            if (connected) {
                fwStatus('Resetting board into bootloader…');
                await fwEnterBootloaderViaTouch();
            } else {
                fwStatus('Double-tap the RESET button on your board now…');
            }

            // 3) Wait for FEATHERBOOT and copy the .uf2.
            const result = await window.sgFirmware.waitAndFlash(uf2Path);
            fwProgress(null);
            if (!result.ok) {
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
            if (await fwTryAutoReconnect()) {
                fwShowBtn('fw-reconnect-btn', false);
                fwStatus('Done — reconnected. Check Firmware Version under System Configuration.', '#22c55e');
            } else if (!fwReconnectCancel) {
                fwStatus('Firmware flashed. Click Reconnect to talk to the board.', '#22c55e');
            }
        } catch (e) {
            fwProgress(null);
            fwStatus('Update error: ' + e.message, '#ef4444');
        } finally {
            fwBusy = false;
            document.getElementById('fw-update-btn').disabled = false;
        }
    }

    async function initFirmware() {
        document.getElementById('fw-tab-btn').style.display = '';   // reveal the tab (hidden in browser)
        document.getElementById('fw-channel').onchange = fwPopulateVersions;
        document.getElementById('fw-update-btn').onclick = () => fwDoUpdate(false);
        document.getElementById('fw-retry-btn').onclick = () => { fwShowBtn('fw-retry-btn', false); fwDoUpdate(true); };
        document.getElementById('fw-reconnect-btn').onclick = () => {
            fwReconnectCancel = true;                 // stop any in-flight auto-reconnect
            fwShowBtn('fw-reconnect-btn', false);
            connect();                                // user gesture -> requestPort -> auto-select
        };
        // Re-detect the board variant whenever the tab is opened (the board may
        // have been connected after the app started).
        document.getElementById('fw-tab-btn').addEventListener('click', fwDetectVariant);
        fwDetectVariant();

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

    window.addEventListener('load', () => { if (window.sgFirmware) initFirmware(); });
