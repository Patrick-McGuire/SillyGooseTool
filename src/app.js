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

    const stateNames = {0:"PRE_FLIGHT", 1:"ASCENT", 2:"DESCENT", 3:"POST_FLIGHT"};

    // --- Altimeter profiles -----------------------------------------------------
    // Everything that differs between flight computer variants (log column layout,
    // binary record decoding, config set, firmware asset naming) lives in one of
    // these profile objects. The rest of the app reads through `activeProfile` /
    // `HEADER` / `configs` rather than hardcoding a specific board's layout, so
    // adding a new board should only mean adding a new profile here.
    //
    // SeriousGoose's log struct is SillyGoose's struct with GPS fields appended at
    // the end (verified against the firmware's packed log struct) - it doesn't
    // reorder any existing columns. That means the two profiles' `cols` mappings
    // happen to agree on every column SillyGoose has. Per-flight code should still
    // look values up through a flight's own profile's `cols` (see
    // `profileForFlight()`) rather than assuming today's profiles will always be
    // compatible like this - a future, unrelated board might not be.
    const SILLY_GOOSE_HEADER = [
        "timestampMs", "pressurePa", "tempK", "accelX", "accelY", "accelZ",
        "gyroX", "gyroY", "gyroZ", "imuTemp", "battV", "altitudeM",
        "velocityMS", "accelerationMSS", "unfiltAlt", "flightState",
        "drogueCont", "drogueFired", "mainCont", "mainFired",
        "tiltMagnitudeDeg", "angularVelRadS_x", "angularVelRadS_y", "angularVelRadS_z",
        "quaternion_a", "quaternion_b", "quaternion_c", "quaternion_d"
    ];
    const COMMON_COLS = {
        timestampMs: 0, battV: 10, altitudeM: 11, velocityMS: 12, flightState: 15,
        drogueCont: 16, drogueFired: 17, mainCont: 18, mainFired: 19,
        tiltMagnitudeDeg: 20, angularVelX: 21, angularVelY: 22, angularVelZ: 23,
        quatA: 24, quatB: 25, quatC: 26, quatD: 27
    };
    const SILLY_GOOSE_LOG_HEADER_STR = "timestampMs\tpressurePa\tbarometerTemperatureK\taccelerationMSS_x\taccelerationMSS_y\taccelerationMSS_z\tvelocityRadS_x\tvelocityRadS_y\tvelocityRadS_z\timuTemperatureK\tbatteryVoltageV\taltitudeM\tvelocityMS\taccelerationMSS\tunfilteredAltitudeM\tflightState\tdrogueContinuity\tdrogueFired\tmainContinuity\tmainFired\ttiltMagnitudeDeg\tangularVelRadS_x\tangularVelRadS_y\tangularVelRadS_z\tquaternion_a\tquaternion_b\tquaternion_c\tquaternion_d";

    const SILLY_GOOSE_CONFIGS = [
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
    const RADIO_CONFIGS = [
        { id: "RADIO_FREQUENCY", label: "Radio Frequency (MHz)" },
        { id: "LORA_SPREADING_FACTOR", label: "LoRa Spreading Factor (5-12)" },
        { id: "RADIO_TRANSMIT_INTERVAL", label: "Radio TX Interval (milliseconds)" }
    ];

    // Decodes the 28 fields SillyGoose and SeriousGoose have in common from a
    // DataView positioned at the start of a LOG_DATA record (byte 0 is the record
    // id). Returns the decoded fields plus the byte offset just past them, so a
    // profile with extra trailing fields (e.g. SeriousGoose's GPS columns) can
    // keep decoding from there.
    function decodeCommonFields(dv) {
        let o = 1; // skip the id byte
        const f = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
        const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
        const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
        const b = () => dv.getUint8(o++);
        const fields = [
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
        return { fields, offset: o };
    }

    function formatDecodedRow(fields) {
        return fields.map(v => Number.isInteger(v) ? String(v) : String(+v.toFixed(6))).join('\t');
    }

    // Flight computer profiles - drive Offload / Live Stream / Live Map / System
    // Configuration.
    const ALTIMETER_PROFILES = {
        SillyGoose: {
            id: "SillyGoose",
            displayName: "SillyGoose",
            header: SILLY_GOOSE_HEADER,
            oldMinCols: 20, // pre-orientation-firmware live streams still pass the length check
            binDataSize: 100, // sizeof(SillyGooseLogData), packed
            fwLogHeader: SILLY_GOOSE_LOG_HEADER_STR,
            defaultSeries: [11, 12, 13],
            cols: { ...COMMON_COLS },
            hasGps: false,
            decodeDataRecord(rec) {
                const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
                return formatDecodedRow(decodeCommonFields(dv).fields);
            },
            configs: SILLY_GOOSE_CONFIGS,
            firmwareVariants: [
                { value: "V1", label: "SillyGoose V1" },
                { value: "V2", label: "SillyGoose V2" }
            ],
            usbNameMatch: /^sillygoose/i
        },
        SeriousGoose: {
            id: "SeriousGoose",
            displayName: "SeriousGoose",
            header: [...SILLY_GOOSE_HEADER, "gpsLatitudeDeg", "gpsLongitudeDeg", "gpsAltitudeM", "gpsUnixTimeS", "gpsHdop", "gpsVdop", "gpsFixQuality", "gpsSatellitesTracked"],
            oldMinCols: 36,
            binDataSize: 122, // SillyGoose's 100 bytes + 22 bytes of appended GPS fields, packed
            fwLogHeader: SILLY_GOOSE_LOG_HEADER_STR + "\tgpsLatitudeDeg\tgpsLongitudeDeg\tgpsAltitudeM\tgpsUnixTimeS\tgpsHdop\tgpsVdop\tgpsFixQuality\tgpsSatellitesTracked",
            defaultSeries: [11, 12, 13],
            cols: { ...COMMON_COLS, gpsLat: 28, gpsLon: 29, gpsAlt: 30, gpsUnixTimeS: 31, gpsHdop: 32, gpsVdop: 33, gpsFixQuality: 34, gpsSatellites: 35 },
            hasGps: true,
            decodeDataRecord(rec) {
                const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
                const { fields, offset } = decodeCommonFields(dv);
                let o = offset;
                fields.push(dv.getFloat32(o, true)); o += 4; // gpsLatitudeDeg
                fields.push(dv.getFloat32(o, true)); o += 4; // gpsLongitudeDeg
                fields.push(dv.getFloat32(o, true)); o += 4; // gpsAltitudeM
                fields.push(dv.getUint32(o, true)); o += 4;  // gpsUnixTimeS
                fields.push(dv.getUint16(o, true)); o += 2;  // gpsHdop
                fields.push(dv.getUint16(o, true)); o += 2;  // gpsVdop
                fields.push(dv.getUint8(o)); o += 1;         // gpsFixQuality
                fields.push(dv.getUint8(o)); o += 1;         // gpsSatellitesTracked
                return formatDecodedRow(fields);
            },
            configs: [...SILLY_GOOSE_CONFIGS, ...RADIO_CONFIGS],
            firmwareVariants: [{ value: "V1", label: "SeriousGoose V1" }],
            // Anchored + negative lookahead so "SeriousGooseGroundV1" (a different
            // board family) doesn't also match this regex - it starts with the same
            // "SeriousGoose" substring.
            usbNameMatch: /^seriousgoose(?!ground)/i
        }
    };

    // Board families that don't produce a flight log at all (pure USB/radio bridge) -
    // only relevant to the Firmware tab, never to Offload/Live/Config.
    const NON_LOGGING_BOARD_FAMILIES = {
        SeriousGooseGround: {
            id: "SeriousGooseGround",
            displayName: "SeriousGooseGround",
            firmwareVariants: [{ value: "V1", label: "SeriousGooseGround V1" }],
            usbNameMatch: /seriousgooseground/i
        }
    };
    const ALL_BOARD_FAMILIES = { ...ALTIMETER_PROFILES, ...NON_LOGGING_BOARD_FAMILIES };

    let activeProfile = ALTIMETER_PROFILES.SillyGoose;
    let HEADER = activeProfile.header;
    let activeSeries = [...activeProfile.defaultSeries];
    let configs = activeProfile.configs;

    // Returns the profile a saved flight was captured under (stamped by
    // saveFlight()/the file-upload handler), falling back to the currently active
    // profile for older in-memory flights that predate the stamp.
    function profileForFlight(f) {
        return (f && ALTIMETER_PROFILES[f.profileId]) || activeProfile;
    }

    // Switches the active altimeter profile, refreshing everything derived from it
    // (log column list, series picker, config tab fields, binary CRC fingerprint).
    // Safe to call any time, including mid-session - flightData already captured
    // under a different profile keeps working via profileForFlight().
    function setActiveProfile(id) {
        const profile = ALTIMETER_PROFILES[id];
        if (!profile || profile === activeProfile) return;
        activeProfile = profile;
        HEADER = activeProfile.header;
        activeSeries = [...activeProfile.defaultSeries];
        configs = activeProfile.configs;
        FW_HEADER_CRC = crc16(Array.from(activeProfile.fwLogHeader, c => c.charCodeAt(0)));
        rebuildSeriesPicker();
        rebuildConfigFields();
    }

    // --- Binary offload protocol (mirrors firmware BasicLogger.h) ---
    const BIN_MAGIC = [0x53, 0x47, 0x42]; // 'SGB'
    const LOG_EMPTY = 0xFF, LOG_DATA = 0x01, LOG_NEW_FLIGHT = 0x02, LOG_MESSAGE = 0x03, LOG_MESSAGE_CONTINUATION = 0x04;
    // CRC-16/CCITT (poly 0x1021, init 0xFFFF) — matches firmware src/util/CRC.h crc16().
    function crc16(bytes) {
        let crc = 0xFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc ^= bytes[i] << 8;
            for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
        return crc & 0xFFFF;
    }
    // Recomputed by setActiveProfile() whenever the active profile changes.
    let FW_HEADER_CRC = crc16(Array.from(activeProfile.fwLogHeader, c => c.charCodeAt(0)));
    const td = new TextDecoder();
    let binMsgBytes = [];
    function concatU8(a, b) { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
    function concatChunks(chunks) { let n = 0; for (const c of chunks) n += c.length; const r = new Uint8Array(n); let o = 0; for (const c of chunks) { r.set(c, o); o += c.length; } return r; }
    // A macrotask yield (not just a microtask) so pending rendering/GC/timers actually
    // get a turn. Used to break up long synchronous bursts of buffered record parsing.
    function yieldToEventLoop() { return new Promise(resolve => setTimeout(resolve, 0)); }

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
            // board-aware picker (incl. listing all ports as a fallback), so
            // request unfiltered there. In a plain browser, narrow the native
            // chooser to Adafruit boards — the best a browser allows — falling
            // back to an unfiltered request if nothing matches.
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
            // Bump the browser/OS-side receive buffer well past the 255-byte default. A
            // binary offload streams continuously with no flow control, so a larger
            // buffer gives the host driver much more slack to absorb a burst while the
            // JS thread is briefly busy (GC, rendering, etc.) before the firmware's own
            // USB TX buffer backs up.
            await port.open({ baudRate: 115200, bufferSize: 16384 });
            document.getElementById('connectBtn').style.display = 'none';
            document.getElementById('disconnectBtn').style.display = 'block';
            setSerialEnabled(true);
            keepReading = true;
            readLoop();
            await detectAltimeterOnConnect();
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

    function processBinRecord(id, rec) {
        if (id !== LOG_MESSAGE_CONTINUATION) flushBinMessage();
        if (id === LOG_DATA) {
            if (recording) { currentFlightLines.push(activeProfile.decodeDataRecord(rec)); currentFlightBin.push(rec); }
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
                    let itemsSinceYield = 0;
                    while (progress) {
                        progress = false;

                        // A single buffered chunk can contain thousands of queued records
                        // (e.g. right after a tab-switch or GC pause). Draining all of them
                        // in one synchronous burst is exactly the kind of stall that can let
                        // a USB packet on the device side go undrained - yield periodically
                        // so rendering/GC/other timers get a turn and the drain doesn't
                        // monopolize the event loop.
                        if (++itemsSinceYield >= 256) {
                            itemsSinceYield = 0;
                            await yieldToEventLoop();
                        }

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
                                if (dataSize === activeProfile.binDataSize && headerCrc === FW_HEADER_CRC) {
                                    mode = 'records';
                                } else {
                                    // Doesn't match the active profile - see if it matches a
                                    // DIFFERENT known profile's fingerprint (e.g. the tool still
                                    // has SillyGoose selected but a SeriousGoose is connected) and
                                    // auto-switch, rather than just failing.
                                    const matchId = Object.keys(ALTIMETER_PROFILES).find(id => {
                                        const p = ALTIMETER_PROFILES[id];
                                        return dataSize === p.binDataSize && headerCrc === crc16(Array.from(p.fwLogHeader, c => c.charCodeAt(0)));
                                    });
                                    if (matchId && matchId !== activeProfile.id) {
                                        logTerm(`Detected ${ALTIMETER_PROFILES[matchId].displayName} log format - switching altimeter profile.`, "#38bdf8");
                                        setActiveProfile(matchId);
                                        mode = 'records';
                                    } else {
                                        logTerm(`Binary offload mismatch (size ${dataSize}, crc ${headerCrc}). Update this tool to match firmware; skipping records.`, "red");
                                        mode = 'skip';
                                    }
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

    // Best-effort guess at which profile a loaded text file belongs to, based on
    // how many columns its data rows have. Text files (unlike binary offloads)
    // carry no CRC fingerprint, so this is the best available signal.
    function guessProfileFromColumnCount(n) {
        const matches = Object.values(ALTIMETER_PROFILES).filter(p => p.header.length === n);
        return matches.length === 1 ? matches[0].id : activeProfile.id;
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
            const profileId = guessProfileFromColumnCount(lines[0].split(/[\s\t]+/).length);
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

    function handleLiveLine(line) {
        const parts = line.split(/[\s\t]+/);
        if (parts.length < activeProfile.oldMinCols) return;
        liveDataBuffer.push(parts);
        if (liveDataBuffer.length > maxLivePoints) liveDataBuffer.shift();

        if (document.getElementById('live-tab').classList.contains('active') && !document.hidden) {
            requestAnimationFrame(plotLive);
        }
        updateLiveMapIfActive();
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
        const flight = { id: Date.now(), name: `Flight_${flightNum}`, raw: [...lines], config: configLine || "", profileId: activeProfile.id };
        // Exact byte-for-byte raw records, present only for binary offloads.
        if (binChunks && binChunks.length) flight.bin = concatChunks(binChunks);
        flightData.push(flight);
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
        const cols = profileForFlight(flight).cols;
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

        const states = rows.map(r => parseInt(r[cols.flightState]));
        const shapes = [], annotations = [];
        const addEv = (time, txt, col) => {
            shapes.push({ type:'line', x0:time, x1:time, y0:0, y1:1, yref:'paper', line:{color:col, width:1, dash:'dash'} });
            annotations.push({ x:time, y:1, yref:'paper', text:txt, showarrow:false, textangle:-90, xanchor:'right', font:{color:col, size:9} });
        };

        for (let i = 1; i < states.length; i++) {
            if (states[i] !== states[i-1]) addEv(t[i], `${stateNames[states[i-1]]} → ${stateNames[states[i]]}`, 'green');
            if (rows[i][cols.drogueFired] == "1" && rows[i-1][cols.drogueFired] == "0") addEv(t[i], "DROGUE FIRED", "purple");
            if (rows[i][cols.mainFired] == "1" && rows[i-1][cols.mainFired] == "0") addEv(t[i], "MAIN FIRED", "blue");
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

        document.getElementById('stat-alt').innerText = Math.max(...rows.map(r => parseFloat(r[cols.altitudeM]))).toFixed(1);
        document.getElementById('stat-vel').innerText = Math.max(...rows.map(r => parseFloat(r[cols.velocityMS]))).toFixed(1);
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

    // Rebuilds the graph series-picker checkboxes from the active profile's HEADER.
    // Called at startup and whenever the profile changes.
    function rebuildSeriesPicker() {
        const picker = document.getElementById('series-picker');
        picker.innerHTML = '';
        HEADER.forEach((h, i) => {
            if(i === 0) return;
            picker.innerHTML += `<label class="series-opt"><input type="checkbox" data-idx="${i}" ${activeSeries.includes(i) ? 'checked' : ''}> ${h}</label>`;
        });
    }

    // Rebuilds the System Configuration tab's input fields from the active
    // profile's config list. Called at startup and whenever the profile changes.
    function rebuildConfigFields() {
        const cfgContainer = document.getElementById('config-fields');
        cfgContainer.innerHTML = '';
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

    function initUI() {
        document.getElementById('filter-flightstate').onchange = refreshList;
        rebuildSeriesPicker();
        rebuildConfigFields();
    }

    // Shown when the connected board's altimeter type can't be auto-detected (an
    // unrecognized USB descriptor, or the browser build where Web Serial can't
    // expose the descriptor string at all) - see detectAltimeterOnConnect().
    function showProfileSelectModal(hint) {
        const hintEl = document.getElementById('profile-modal-hint');
        if (hintEl) hintEl.textContent = hint;
        const optionsEl = document.getElementById('profile-modal-options');
        optionsEl.innerHTML = '';
        Object.values(ALTIMETER_PROFILES).forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'btn' + (p.id === activeProfile.id ? '' : ' btn-secondary');
            btn.textContent = p.displayName;
            btn.onclick = () => {
                setActiveProfile(p.id);
                document.getElementById('profile-modal').style.display = 'none';
            };
            optionsEl.appendChild(btn);
        });
        document.getElementById('profile-modal').style.display = 'flex';
    }

    // Ensures the active altimeter profile matches the connected board on every
    // connect, prompting only when it truly can't be determined automatically -
    // never for a normal, recognized connect (the previously-always-visible
    // Altimeter dropdown is gone; this replaces it).
    async function detectAltimeterOnConnect() {
        if (!window.sgFirmware) {
            // Plain browser build: Web Serial never exposes the USB product
            // descriptor string, so there's no signal to auto-detect from here.
            showProfileSelectModal("Auto-detect isn't available in the browser build - pick which altimeter this is.");
            return;
        }
        const familyId = await fwDetectVariant();
        if (!familyId) {
            showProfileSelectModal("Couldn't auto-detect the connected board - pick which altimeter this is.");
        }
        // A detected non-logging family (e.g. SeriousGooseGround) or a detected
        // logging profile both fall through here with nothing left to do -
        // fwDetectVariant() already called setActiveProfile() in the latter case.
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
        if (id === 'live-map-tab') {
            initLiveMap();
            setTimeout(() => { if (liveMap) liveMap.invalidateSize(); }, 0);
        }
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
        const header = profileForFlight(f).header;
        const parts = [];
        if (f.config) parts.push(f.config);
        parts.push(header.join("\t"));
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

    // ===================== Live Map tab =====================
    // Big offline-capable map + small diagnostic widgets, fed by the same live
    // telemetry stream as the Live Stream tab (liveDataBuffer, populated by
    // handleLiveLine() from `--streamLog -b`). Only wired up for a directly
    // connected flight computer for now; a ground station's forwarded GPS/radio
    // serial lines are a natural second data source for this tab later, since
    // they're already tagged/parseable independently of a flight computer's log
    // format (see SeriousGooseGround.cpp in the firmware repo).
    //
    // TILE SOURCES: Esri's ArcGIS World_Street_Map / World_Imagery, both free to
    // embed without an API key at this kind of low-volume/hobby usage. Switched to
    // these from the raw OpenStreetMap tile server (tile.openstreetmap.org) after
    // hitting 403s there - OSM's tile usage policy actively blocks exactly this
    // kind of bulk/scripted access, which offline pre-caching is. Esri's terms are
    // more permissive for embedded display use, but still check them before
    // relying on this at an actual launch - heavy usage may want a real Esri
    // developer key or a self-hosted tile source (e.g. a local MBTiles instance)
    // instead.
    const TILE_LAYERS = {
        street: {
            label: 'Street',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS'
        },
        satellite: {
            label: 'Satellite',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
        }
    };
    const TILE_DB_NAME = 'sillygoose-tiles';
    const TILE_STORE = 'tiles';

    function openTileDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(TILE_DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(TILE_STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    function tileDbGet(db, key) {
        return new Promise((resolve, reject) => {
            const req = db.transaction(TILE_STORE, 'readonly').objectStore(TILE_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    function tileDbPut(db, key, blob) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(TILE_STORE, 'readwrite');
            tx.objectStore(TILE_STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    let tileDbPromise = null;
    function getTileDb() {
        if (!tileDbPromise) tileDbPromise = openTileDb();
        return tileDbPromise;
    }

    // Custom tile layer: serves cached tiles from IndexedDB when present, and
    // opportunistically caches every tile it fetches from the network. Deliberately
    // hand-rolled rather than depending on the `leaflet.offline` package, which
    // requires the `idb` npm package (ships ESM/CJS only, no plain-<script> global
    // build) - would break this app's "single vendored file, no bundler" convention.
    const OfflineTileLayer = (typeof L !== 'undefined') ? L.TileLayer.extend({
        createTile(coords, done) {
            const img = document.createElement('img');
            const url = this.getTileUrl(coords);
            (async () => {
                try {
                    const db = await getTileDb();
                    const cached = await tileDbGet(db, url);
                    if (cached) {
                        img.src = URL.createObjectURL(cached);
                        done(null, img);
                        return;
                    }
                } catch (e) { /* IndexedDB unavailable - fall through to network */ }
                img.onload = () => done(null, img);
                img.onerror = (e) => done(e, img);
                img.src = url;
                // Re-fetch as a blob (separately from the <img> load above) so it can be
                // cached for offline use later - a cache-write failure never blocks
                // rendering the tile.
                fetch(url).then(r => (r.ok ? r.blob() : null)).then(async (blob) => {
                    if (!blob) return;
                    const db = await getTileDb();
                    await tileDbPut(db, url, blob);
                }).catch(() => {});
            })();
            return img;
        }
    }) : null;

    let liveMap = null, liveMapTileLayers = null, liveMapActiveTileKey = 'satellite', liveMapMarker = null, liveMapPath = null;
    const liveMapTrack = [];

    // The tab's initial layout (map center, QR code, elevation graph) is
    // deliberately static - it must look and size the same regardless of whether
    // any telemetry has arrived yet, or which altimeter (if any) is connected, so
    // it's checkable with nothing plugged in. Real position updates simply
    // overwrite this default once actual GPS data streams in.
    const DEFAULT_MAP_CENTER = [0, 0];

    function initLiveMap() {
        if (liveMap || typeof L === 'undefined') return;
        liveMap = L.map('live-map', { attributionControl: true, zoomControl: true }).setView(DEFAULT_MAP_CENTER, 2);

        liveMapTileLayers = {};
        Object.entries(TILE_LAYERS).forEach(([key, cfg]) => {
            liveMapTileLayers[key] = new OfflineTileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution });
        });
        liveMapTileLayers[liveMapActiveTileKey].addTo(liveMap);

        const layerControlInput = {};
        const labelToKey = {};
        Object.entries(TILE_LAYERS).forEach(([key, cfg]) => {
            layerControlInput[cfg.label] = liveMapTileLayers[key];
            labelToKey[cfg.label] = key;
        });
        L.control.layers(layerControlInput, null, { position: 'topright' }).addTo(liveMap);
        // Track whichever base layer (street/satellite) is currently visible, so
        // saveCurrentMapViewOffline() caches the layer the user is actually looking
        // at rather than always the first one.
        liveMap.on('baselayerchange', (e) => { liveMapActiveTileKey = labelToKey[e.name] || liveMapActiveTileKey; });

        liveMapPath = L.polyline([], { color: '#38bdf8', weight: 2 }).addTo(liveMap);
        liveMapMarker = L.marker(DEFAULT_MAP_CENTER, {
            icon: L.divIcon({ className: 'rocket-marker', html: '&#9650;', iconSize: [20, 20], iconAnchor: [10, 10] })
        }).addTo(liveMap);

        liveMap.on('contextmenu', showSaveViewMenu);

        // Render the QR code and elevation graph immediately with their static
        // defaults, rather than waiting for the first telemetry line.
        updateGpsQrCode(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]);
        updateElevationSparkline();
    }

    function showSaveViewMenu(e) {
        const existing = document.getElementById('map-context-menu');
        if (existing) existing.remove();
        const menu = document.createElement('div');
        menu.id = 'map-context-menu';
        menu.className = 'map-context-menu';
        menu.style.left = e.containerPoint.x + 'px';
        menu.style.top = e.containerPoint.y + 'px';
        const layerLabel = TILE_LAYERS[liveMapActiveTileKey].label;
        menu.innerHTML = `<button class="btn btn-secondary">Save this view for offline use (${layerLabel})</button>`;
        menu.querySelector('button').onclick = () => { menu.remove(); saveCurrentMapViewOffline(); };
        document.getElementById('live-map').appendChild(menu);
        setTimeout(() => document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }), 0);
    }

    // Saves tiles for a range of zoom levels around the current view, all the way
    // to the layer's max zoom - not just the exact zoom level on screen -
    // otherwise zooming in further while offline would show blank tiles for
    // anything not already cached. Meant for a "zoom to the launch site, then
    // save" workflow over a small (few-mile) area; tile count grows ~4x per zoom
    // level, so this is confirmed with an estimate before starting.
    const SAVE_ZOOM_OUT = 1;
    // Fetching tiles one at a time (fully sequential) is what made this take
    // "forever" - each tile pays a full network round trip before the next one
    // starts. A bounded worker pool cuts wall-clock time by roughly this factor
    // without firing every request at once. 40 matches the concurrency
    // AerospaceNU's pyqt_groundstation tool uses for the same job (its
    // aiohttp-based tile downloader runs under an asyncio.BoundedSemaphore(50) -
    // kept slightly more conservative here since that's proven against Google's
    // tile servers specifically, not Esri's).
    const SAVE_CONCURRENCY = 40;

    async function saveCurrentMapViewOffline() {
        if (!liveMap) return;
        const statusEl = document.getElementById('map-save-status');
        const layer = liveMapTileLayers[liveMapActiveTileKey];
        const tileSize = layer.getTileSize().x;
        const bounds = liveMap.getBounds();
        const currentZoom = Math.round(liveMap.getZoom());
        const minZoom = Math.max(0, currentZoom - SAVE_ZOOM_OUT);
        const maxZoom = layer.options.maxZoom || 19;

        let db;
        try {
            db = await getTileDb();
        } catch (e) {
            // IndexedDB can legitimately be unavailable (private-browsing modes,
            // storage quota/permission issues) - fail with a clear message rather
            // than an unhandled rejection.
            if (statusEl) statusEl.textContent = "Couldn't open the offline tile cache (IndexedDB unavailable).";
            return;
        }
        // Flatten every (x, y, z) tile coordinate across all zoom levels into one
        // list up front, so progress shows one combined total and the fetch loop
        // below can just pull from a shared queue.
        const tiles = [];
        for (let z = minZoom; z <= maxZoom; z++) {
            const nw = liveMap.project(bounds.getNorthWest(), z).divideBy(tileSize).floor();
            const se = liveMap.project(bounds.getSouthEast(), z).divideBy(tileSize).floor();
            for (let x = nw.x; x <= se.x; x++) {
                for (let y = nw.y; y <= se.y; y++) tiles.push({ x, y, z });
            }
        }
        const total = tiles.length;

        if (total > 2000 && !confirm(
            `This will download ~${total.toLocaleString()} tiles (zoom ${minZoom}-${maxZoom}) for the current view.\n\n` +
            `A smaller area (zoom in more before saving) downloads faster. Continue?`
        )) {
            return;
        }

        let done = 0;
        const label = () => `Saving ${done}/${total} tiles (zoom ${minZoom}-${maxZoom})…`;
        if (statusEl) statusEl.textContent = label();

        let nextIndex = 0;
        async function worker() {
            while (nextIndex < tiles.length) {
                const { x, y, z } = tiles[nextIndex++];
                const url = layer.getTileUrl({ x, y, z });
                try {
                    const existing = await tileDbGet(db, url);
                    if (!existing) {
                        const res = await fetch(url);
                        if (res.ok) await tileDbPut(db, url, await res.blob());
                    }
                } catch (e) { /* best-effort - skip tiles that fail */ }
                done++;
                if (statusEl) statusEl.textContent = label();
            }
        }
        await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, tiles.length) }, worker));

        if (statusEl) statusEl.textContent = `Saved ${total} tiles (zoom ${minZoom}-${maxZoom}) for offline use.`;
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    }

    // --- Diagnostic widgets ---------------------------------------------------

    // Standard quaternion (w,x,y,z) -> Euler angle conversion. There's no
    // magnetometer in this avionics stack, so "yaw" here is relative to whatever
    // the orientation estimator's reference frame was at boot - NOT a true compass
    // heading. Labelled as such in the UI.
    function quatToEuler(w, x, y, z) {
        const sinrCosp = 2 * (w * x + y * z);
        const cosrCosp = 1 - 2 * (x * x + y * y);
        const roll = Math.atan2(sinrCosp, cosrCosp);

        const sinp = 2 * (w * y - z * x);
        const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);

        const sinyCosp = 2 * (w * z + x * y);
        const cosyCosp = 1 - 2 * (y * y + z * z);
        const yaw = Math.atan2(sinyCosp, cosyCosp);

        return { roll: roll * 180 / Math.PI, pitch: pitch * 180 / Math.PI, yaw: yaw * 180 / Math.PI };
    }

    // Navball texture (src/assets/navball.png, from AerospaceNU/pyqt_groundstation)
    // is a 1024x512 equirectangular strip: heading wraps horizontally across the
    // full 360deg width (confirmed by the "18" heading label splitting across the
    // image's left/right seam), and pitch tick marks (30/60deg) run vertically
    // outward from the horizontal centerline at the same angular scale. That
    // makes the native scale 1024px / 360deg on both axes; CSS renders it at
    // NAVBALL_RENDER_H px tall (see .navball-texture's background-size), so the
    // on-screen scale shrinks by that same ratio.
    const NAVBALL_TEXTURE_NATIVE_H = 512;
    const NAVBALL_RENDER_H = 110; // must match .navball-texture's background-size height
    const NAVBALL_PX_PER_DEG = (1024 / 360) * (NAVBALL_RENDER_H / NAVBALL_TEXTURE_NATIVE_H);

    // Roll rotates the whole ball; pitch/yaw pan the texture under a fixed
    // reticle - exactly how a real navball reads (the fixed marker is the
    // vehicle's reference, the ball moves under it). Sign/scale conventions here
    // are a best-effort match to the reference asset - this couldn't be visually
    // rendered/verified in a headless test, so double check it looks right and
    // flip a sign below if pitch/yaw appear to move backwards on real hardware.
    function updateNavball(roll, pitch, yaw) {
        const texture = document.getElementById('navball-texture');
        if (!texture) return;
        const panX = -yaw * NAVBALL_PX_PER_DEG;
        const panY = pitch * NAVBALL_PX_PER_DEG;
        texture.style.backgroundPosition = `${panX}px ${panY}px`;
        texture.style.transform = `rotate(${-roll}deg)`;
    }

    function updateCompass(yawDeg) {
        const needle = document.getElementById('compass-needle');
        if (needle) needle.style.transform = `rotate(${yawDeg}deg)`;
        const label = document.getElementById('compass-heading');
        if (label) label.textContent = `${((yawDeg + 360) % 360).toFixed(0)}°`;
    }

    function setPyroBadge(id, continuity, fired) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = fired ? 'FIRED' : (continuity ? 'READY' : 'OPEN');
        el.className = 'pyro-badge ' + (fired ? 'pyro-fired' : (continuity ? 'pyro-ready' : 'pyro-open'));
    }

    function updateLiveMapPosition(lat, lon) {
        if (!liveMap) return;
        liveMapMarker.setLatLng([lat, lon]);
        liveMapTrack.push([lat, lon]);
        if (liveMapTrack.length > 5000) liveMapTrack.shift();
        liveMapPath.setLatLngs(liveMapTrack);
        if (liveMapTrack.length === 1) liveMap.setView([lat, lon], 15);
        updateGpsQrCode(lat, lon);
    }

    // QR code linking to the latest GPS fix on Google Maps, generated entirely
    // client-side (qrcode-generator, vendored locally) so it works fully offline
    // like the rest of this tab.
    function updateGpsQrCode(lat, lon) {
        const overlay = document.getElementById('qr-overlay');
        const canvas = document.getElementById('qr-canvas');
        if (!overlay || !canvas || typeof qrcode === 'undefined') return;
        const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
        const qr = qrcode(0, 'M'); // typeNumber 0 = auto-size for the data length
        qr.addData(url);
        qr.make();
        canvas.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        overlay.style.display = '';
    }

    function updateLiveMapWidgets(row) {
        const cols = activeProfile.cols;

        const battV = parseFloat(row[cols.battV]);
        const battEl = document.getElementById('widget-battery-val');
        if (battEl) battEl.textContent = isNaN(battV) ? '-' : `${battV.toFixed(2)}V`;

        const quat = { w: parseFloat(row[cols.quatA]), x: parseFloat(row[cols.quatB]), y: parseFloat(row[cols.quatC]), z: parseFloat(row[cols.quatD]) };
        if (![quat.w, quat.x, quat.y, quat.z].some(isNaN)) {
            const { roll, pitch, yaw } = quatToEuler(quat.w, quat.x, quat.y, quat.z);
            updateNavball(roll, pitch, yaw);
            updateCompass(yaw);
        }

        setPyroBadge('pyro-drogue', row[cols.drogueCont] === "1", row[cols.drogueFired] === "1");
        setPyroBadge('pyro-main', row[cols.mainCont] === "1", row[cols.mainFired] === "1");

        const gpsEl = document.getElementById('widget-gps-val');
        if (activeProfile.hasGps && cols.gpsLat !== undefined) {
            const lat = parseFloat(row[cols.gpsLat]), lon = parseFloat(row[cols.gpsLon]);
            const fixQuality = parseInt(row[cols.gpsFixQuality]), sats = parseInt(row[cols.gpsSatellites]);
            if (gpsEl) gpsEl.textContent = isNaN(fixQuality) ? '-' : `fix ${fixQuality} · ${sats} sats`;
            // Leave the map/QR showing whatever they last showed (the static default,
            // or a previous real fix) until an actual non-zero fix comes in.
            if (!isNaN(lat) && !isNaN(lon) && (lat !== 0 || lon !== 0)) updateLiveMapPosition(lat, lon);
        } else if (gpsEl) {
            gpsEl.textContent = 'No GPS on this board';
        }
    }

    // Renders unconditionally, even with an empty buffer - the graph is part of
    // the tab's static layout (see DEFAULT_MAP_CENTER above), not something that
    // only appears once data starts flowing.
    function updateElevationSparkline() {
        if (typeof Plotly === 'undefined') return;
        const cols = activeProfile.cols;
        const t0 = liveDataBuffer.length ? parseFloat(liveDataBuffer[0][cols.timestampMs]) : 0;
        const t = liveDataBuffer.map(r => (parseFloat(r[cols.timestampMs]) - t0) / 1000);
        const alt = liveDataBuffer.map(r => parseFloat(r[cols.altitudeM]));
        Plotly.react('elevation-sparkline', [{ x: t, y: alt, mode: 'lines', line: { color: '#38bdf8', width: 1.5 }, hoverinfo: 'none' }], {
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { t: 4, r: 4, l: 30, b: 20 }, font: { color: '#94a3b8', size: 9 },
            xaxis: { gridcolor: '#334155', showticklabels: false }, yaxis: { gridcolor: '#334155' },
            showlegend: false
        }, { responsive: true, displaylogo: false, staticPlot: true });
    }

    // Called from handleLiveLine() alongside the existing Live Stream tab update.
    // Map rendering is comparatively expensive, so it only runs while the Live Map
    // tab is actually visible.
    function updateLiveMapIfActive() {
        const tabEl = document.getElementById('live-map-tab');
        if (!tabEl || !tabEl.classList.contains('active') || document.hidden) return;
        if (liveDataBuffer.length === 0) return;
        initLiveMap();
        // Leaflet sizes itself from the DOM at creation time; the tab may have been
        // hidden (display:none) then, so nudge it once the container has real size.
        if (liveMap) liveMap.invalidateSize();
        updateLiveMapWidgets(liveDataBuffer[liveDataBuffer.length - 1]);
        updateElevationSparkline();
    }

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
    async function fwDetectVariant() {
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
            if (ALTIMETER_PROFILES[familyId]) setActiveProfile(familyId);
            return familyId;
        } catch (e) { return null; }
    }

    // 1200-baud touch: reset the SAMD21/SAMD51 into its UF2 bootloader using the
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
        const localUf2 = fwLocalUf2;
        const url = localUf2 ? null : fwSelectedAssetUrl();
        if (!localUf2 && !url) { fwStatus('No firmware available for that selection.', '#ef4444'); return; }
        const family = fwCurrentFamily();
        const variant = document.getElementById('fw-variant').value;
        const channel = document.getElementById('fw-channel').value;
        const connected = !!port;

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
    function fwPopulateFamilies() {
        const familySel = document.getElementById('fw-family');
        familySel.innerHTML = Object.values(ALL_BOARD_FAMILIES).map(f => `<option value="${f.id}">${f.displayName}</option>`).join('');
        familySel.value = activeProfile.id;
        fwPopulateVariants();
    }

    async function initFirmware() {
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
        document.getElementById('fw-update-btn').onclick = () => fwDoUpdate(false);
        document.getElementById('fw-retry-btn').onclick = () => { fwShowBtn('fw-retry-btn', false); fwDoUpdate(true); };
        document.getElementById('fw-reconnect-btn').onclick = () => {
            fwReconnectCancel = true;                 // stop any in-flight auto-reconnect
            fwShowBtn('fw-reconnect-btn', false);
            connect();                                // user gesture -> requestPort -> auto-select
        };
        // Re-detect the board whenever the tab is opened (the board may have been
        // connected after the app started).
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

    // Run as soon as the DOM is ready (not on 'load', which waits for the whole
    // multi-megabyte inlined bundle — Plotly, Leaflet, etc. — to finish). The tab is
    // always shown; the desktop app wires it up, the browser build grays it out.
    function fwInit() {
        fwPopulateFamilies();
        if (window.sgFirmware) initFirmware(); else initFirmwareDisabled();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fwInit);
    else fwInit();
