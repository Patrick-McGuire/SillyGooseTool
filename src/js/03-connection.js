// --- Connection -------------------------------------------------------------
// Everything about one serial link to a board: the Web Serial port/reader,
// the binary/text parser state machine, which altimeter profile is active,
// and the current recording/streaming buffers. This used to be a pile of
// top-level `let` globals (port, reader, activeProfile, recording, ...) -
// pulling them into a class means a second, independent board connection
// (a second USB device, or a ground-station radio link forwarding a second
// altimeter's telemetry) is just `new Connection()` + adding it to
// ConnectionManager, not a rewrite of this file. Multi-device UI is
// deliberately NOT built yet (nothing iterates more than the one active
// connection today) - this is purely so that work has somewhere to land.
class Connection {
    constructor(id) {
        this.id = id;
        this.port = null;
        this.reader = null;
        this.keepReading = true;

        this.profile = ALTIMETER_PROFILES.SillyGoose;
        this.header = this.profile.header;
        this.activeSeries = [...this.profile.defaultSeries];
        this.configs = this.profile.configs;
        this.fwHeaderCrc = headerCrcFor(this.profile);

        this.recording = false;
        this.streaming = false;
        this.currentFlightLines = [];
        this.currentFlightBin = [];
        this.currentConfigLine = "";

        this.liveDataBuffer = [];
        this.maxLivePoints = 200;

        // Every row seen while streaming, uncapped (unlike liveDataBuffer,
        // which is a rolling window sized for the live plot) - one row per
        // radio/serial packet, same text format an offload produces. Reset
        // whenever streaming (re)starts - see 05-live-stream.js.
        this.streamLogLines = [];

        this.binMsgBytes = [];
    }

    // Switches the active altimeter profile, refreshing everything derived from
    // it (log column list, series picker, config tab fields, binary CRC
    // fingerprint). Safe to call any time, including mid-session - flightData
    // already captured under a different profile keeps working via
    // profileForFlight().
    setActiveProfile(id) {
        const profile = ALTIMETER_PROFILES[id];
        if (!profile || profile === this.profile) return;
        this.profile = profile;
        this.header = profile.header;
        this.activeSeries = [...profile.defaultSeries];
        this.configs = profile.configs;
        this.fwHeaderCrc = headerCrcFor(profile);
        DebugLog.info('connection', `active profile -> ${profile.id}`);
        rebuildSeriesPicker(this);
        rebuildConfigFields(this);
        rebuildPyroWidgets(this);
        rebuildPyroFireButtons(this);
    }

    async connect() {
        try {
            // In the desktop app the Electron main process applies the full
            // board-aware picker (incl. listing all ports as a fallback), so
            // request unfiltered there. In a plain browser, narrow the native
            // chooser to Adafruit boards — the best a browser allows — falling
            // back to an unfiltered request if nothing matches.
            const isElectron = navigator.userAgent.toLowerCase().includes('electron');
            if (isElectron) {
                this.port = await navigator.serial.requestPort();
            } else {
                try {
                    this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x239A }] });
                } catch (filterErr) {
                    if (filterErr && filterErr.name === 'NotFoundError') {
                        this.port = await navigator.serial.requestPort();
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
            await this.port.open({ baudRate: 115200, bufferSize: 16384 });
            DebugLog.info('connection', 'port opened');
            document.getElementById('connectBtn').style.display = 'none';
            document.getElementById('disconnectBtn').style.display = 'block';
            setSerialEnabled(true);
            this.keepReading = true;
            this.readLoop();
            await detectAltimeterOnConnect(this);
        } catch (e) {
            DebugLog.error('connection', 'connect failed: ' + e.message);
            logTerm("Connection Error: " + e.message, "red");
        }
    }

    async disconnect() {
        this.keepReading = false;
        if (this.reader) { await this.reader.cancel().catch(() => {}); this.reader = null; }
        if (this.port) { await this.port.close(); this.port = null; }
        DebugLog.info('connection', 'disconnected');
        this.forceUIDisconnect();
    }

    forceUIDisconnect() {
        this.port = null; setBusy(false); this.recording = false; this.streaming = false;
        document.getElementById('connectBtn').style.display = 'block';
        document.getElementById('disconnectBtn').style.display = 'none';
        setSerialEnabled(false);
    }

    async sendCmd(msg) {
        if (!this.port || !this.port.writable) return;
        setBusy(true);
        const writer = this.port.writable.getWriter();
        await writer.write(new TextEncoder().encode(msg + "\n"));
        writer.releaseLock();
        DebugLog.tx('serial', msg);
        logTerm(`>> ${msg}`, "#38bdf8");
        if (!msg.includes("offload") && !msg.includes("erase") && !msg.includes("streamLog")) setTimeout(() => setBusy(false), 800);
    }

    // Handle one logical text line (from the text stream, or reconstructed from a
    // binary message record). Mirrors the original per-line offload logic.
    //
    // IMPORTANT (perf): while `recording` (an offload) or `streaming` (a live
    // stream), the vast majority of lines are decoded data rows, arriving as
    // fast as the radio/serial link can carry them - easily 50-100Hz while
    // streaming, thousands of rows total for an offload. Echoing every one of
    // them to the terminal builds more timestamped HTML onto a growing string
    // faster than the terminal's 100ms flush can drain it, which is what made
    // offload visibly lag, and is also part of why alt-tabbing away and back
    // mid-stream used to hang: `setInterval`-based timers (including that
    // flush) get throttled hard while the window is occluded, so termBuffer
    // could grow large before the next flush actually runs. Data rows are
    // already captured into currentFlightLines/streamLogLines below;
    // there's nothing useful about also echoing them to a scrollback nobody
    // is reading in real time. A periodic progress count (recordOffloadProgress)
    // and the Live Graph tab's "last message age" cover the same need instead.
    processLine(line) {
        const isDataRow = /^\d/.test(line);
        if (!((this.recording || this.streaming) && isDataRow)) logTerm(line);

        if (line.includes("Entries in log:")) Telemetry.set('logEntries', line.split(':').pop().trim());
        if (line.includes("Remaining log length:")) Telemetry.set('logRemaining', formatLogTime(line.split(':').pop().trim()));
        if (line.includes("Logging")) Telemetry.set('logStatus', line.includes("enabled") ? "ON" : "OFF");

        if (line.includes("Streaming enabled")) { this.streaming = true; this.liveDataBuffer = []; this.streamLogLines = []; Telemetry.set('streaming', true); }
        if (line.includes("Streaming disabled")) { this.streaming = false; Telemetry.set('streaming', false); }

        const setMatch = line.match(/MSG:\s+([A-Z_]+)\s+is set to:\s+(.+)/);
        if (setMatch) {
            Telemetry.set(`cfg.${setMatch[1]}`, setMatch[2].trim());
            setBusy(false);
        }

        if (line.includes("Starting Offload")) {
            this.recording = true; this.currentFlightLines = []; this.currentFlightBin = []; this.currentConfigLine = "";
            Telemetry.set('offloadProgress', 0);
            setBusy(true);
            return;
        }

        if (this.streaming && isDataRow) handleLiveLine(this, line);

        if (this.recording) {
            if (line.includes("Logger setup")) { this.flushRecordedFlight(); return; }
            if (line.includes("Ending Offload")) { this.flushRecordedFlight(); this.recording = false; Telemetry.set('offloadProgress', null); setBusy(false); return; }
            if (line.startsWith("CONFIG\t") || line.startsWith("CONFIG ")) { this.currentConfigLine = line; return; }
            if (isDataRow) { this.currentFlightLines.push(line); this.recordOffloadProgress(); }
        }
        if (line.includes("Erase Complete")) setBusy(false);
    }

    // Publishes the running row count every 250 rows rather than every row -
    // frequent enough to look live, far too infrequent to be a perf concern.
    recordOffloadProgress() {
        if (this.currentFlightLines.length % 250 === 0) Telemetry.set('offloadProgress', this.currentFlightLines.length);
    }

    flushRecordedFlight() {
        if (this.currentFlightLines.length > 5) saveFlight(this, this.currentFlightLines, this.currentConfigLine, this.currentFlightBin);
        this.currentFlightLines = []; this.currentFlightBin = []; this.currentConfigLine = "";
    }

    // Flush an accumulated binary message record into the normal line handler
    // (carries "Logger setup" flight boundaries and "CONFIG\t..." rows).
    flushBinMessage() {
        if (!this.binMsgBytes.length) return;
        const nul = this.binMsgBytes.indexOf(0);
        const bytes = nul >= 0 ? this.binMsgBytes.slice(0, nul) : this.binMsgBytes;
        const str = td.decode(new Uint8Array(bytes)).trim();
        this.binMsgBytes = [];
        if (str) this.processLine(str);
    }

    processBinRecord(id, rec) {
        if (id !== LOG_MESSAGE_CONTINUATION) this.flushBinMessage();
        if (id === LOG_DATA) {
            if (this.recording) {
                this.currentFlightLines.push(this.profile.decodeDataRecord(rec));
                this.currentFlightBin.push(rec);
                this.recordOffloadProgress();
            }
        } else if (id === LOG_MESSAGE || id === LOG_MESSAGE_CONTINUATION) {
            for (let i = 1; i < rec.length; i++) this.binMsgBytes.push(rec[i]);
        }
        // LOG_NEW_FLIGHT: flight splitting is driven by the "Logger setup" message
    }

    async readLoop() {
        while (this.port && this.port.readable && this.keepReading) {
            this.reader = this.port.readable.getReader();
            let buf = new Uint8Array(0);
            let mode = 'text'; // 'text' | 'preamble' | 'records' | 'skip'
            let recordSize = 0;

            try {
                while (this.keepReading) {
                    const { value, done } = await this.reader.read();
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
                                if (line) this.processLine(line);
                                progress = true;
                            }
                        } else if (mode === 'preamble') {
                            if (buf.length >= 7) {
                                const dataSize = buf[3] | (buf[4] << 8);
                                const headerCrc = buf[5] | (buf[6] << 8);
                                buf = buf.slice(7);
                                recordSize = 1 + dataSize;
                                if (dataSize === this.profile.binDataSize && headerCrc === this.fwHeaderCrc) {
                                    mode = 'records';
                                } else {
                                    // Doesn't match the active profile - see if it matches a
                                    // DIFFERENT known profile's fingerprint (e.g. the tool still
                                    // has SillyGoose selected but a SeriousGoose is connected) and
                                    // auto-switch, rather than just failing.
                                    const matchId = Object.keys(ALTIMETER_PROFILES).find(id => {
                                        const p = ALTIMETER_PROFILES[id];
                                        return dataSize === p.binDataSize && headerCrc === headerCrcFor(p);
                                    });
                                    if (matchId && matchId !== this.profile.id) {
                                        logTerm(`Detected ${ALTIMETER_PROFILES[matchId].displayName} log format - switching altimeter profile.`, "#38bdf8");
                                        this.setActiveProfile(matchId);
                                        mode = 'records';
                                    } else {
                                        logTerm(`Binary offload mismatch (size ${dataSize}, crc ${headerCrc}). Update this tool to match firmware; skipping records.`, "red");
                                        DebugLog.warn('protocol', `binary mismatch: size=${dataSize} crc=${headerCrc}`);
                                        mode = 'skip';
                                    }
                                }
                                progress = true;
                            }
                        } else { // 'records' or 'skip'
                            if (buf.length >= 1 && buf[0] === LOG_EMPTY) {
                                buf = buf.slice(1);
                                if (mode === 'records') this.flushBinMessage();
                                mode = 'text';
                                progress = true;
                            } else if (buf.length >= recordSize) {
                                const rec = buf.slice(0, recordSize);
                                const id = buf[0];
                                buf = buf.slice(recordSize);
                                if (mode === 'records') this.processBinRecord(id, rec);
                                progress = true;
                            }
                        }
                    }
                }
            } catch (e) {
                DebugLog.error('connection', 'read loop error: ' + e.message);
                break;
            } finally { if (this.reader) { this.reader.releaseLock(); this.reader = null; } }
        }
    }
}

// Returns the profile a saved flight was captured under (stamped by
// saveFlight()/the file-upload handler), falling back to the currently active
// profile for older in-memory flights that predate the stamp.
function profileForFlight(f) {
    return (f && ALTIMETER_PROFILES[f.profileId]) || ConnectionManager.getActive().profile;
}

// A macrotask yield (not just a microtask) so pending rendering/GC/timers actually
// get a turn. Used to break up long synchronous bursts of buffered record parsing.
//
// IMPORTANT: this used to be `setTimeout(resolve, 0)`. Chromium (and therefore
// Electron) throttles timers heavily once a window is occluded/backgrounded -
// alt-tabbing away is enough to trigger this even without minimizing. While
// occluded, each of these "yields" could take up to ~1 second instead of
// ~0ms, so the read loop fell further and further behind real-time for as
// long as the window stayed unfocused; on refocus it had to burn through a
// large backlog all at once, which showed up as a multi-second hang right
// when you tabbed back in. A MessageChannel round-trip schedules a real
// macrotask the same way, but isn't subject to that same background timer
// clamp, so the read loop keeps pace with incoming data regardless of focus.
function yieldToEventLoop() {
    if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
    // A fresh channel per call (rather than one shared/reused channel) so
    // overlapping calls - e.g. two Connections' read loops yielding around the
    // same time, once multi-device support exists - can never have one call's
    // message wake up a different call's promise.
    return new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port2.onmessage = () => resolve();
        ch.port1.postMessage(0);
    });
}

function formatLogTime(seconds) {
    const s = parseInt(seconds);
    if (isNaN(s)) return "-";
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${hrs}h ${mins}m ${secs}s`;
}

const td = new TextDecoder();
function concatU8(a, b) { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
function concatChunks(chunks) { let n = 0; for (const c of chunks) n += c.length; const r = new Uint8Array(n); let o = 0; for (const c of chunks) { r.set(c, o); o += c.length; } return r; }

// --- ConnectionManager -------------------------------------------------------
// Holds every live Connection. Exactly one is ever created/active today - the
// array + active-id indirection exists so a second connection (a second USB
// port, or a future ground-station radio link) is additive later: push another
// Connection, point UI that should show it at its id, done. Nothing today
// iterates `connections` expecting more than one.
const ConnectionManager = (() => {
    const connections = [];
    let activeId = null;

    function create() {
        const conn = new Connection(connections.length + 1);
        connections.push(conn);
        activeId = conn.id;
        return conn;
    }
    function getActive() {
        return connections.find(c => c.id === activeId) || create();
    }
    function all() { return connections.slice(); }

    return { create, getActive, all };
})();

// Shown when the connected board's altimeter type can't be auto-detected (an
// unrecognized USB descriptor, or the browser build where Web Serial can't
// expose the descriptor string at all) - see detectAltimeterOnConnect().
function showProfileSelectModal(conn, hint) {
    const hintEl = document.getElementById('profile-modal-hint');
    if (hintEl) hintEl.textContent = hint;
    const optionsEl = document.getElementById('profile-modal-options');
    optionsEl.innerHTML = '';
    Object.values(ALTIMETER_PROFILES).forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'btn' + (p.id === conn.profile.id ? '' : ' btn-secondary');
        btn.textContent = p.displayName;
        btn.onclick = () => {
            conn.setActiveProfile(p.id);
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
async function detectAltimeterOnConnect(conn) {
    if (!window.sgFirmware) {
        // Plain browser build: Web Serial never exposes the USB product
        // descriptor string, so there's no signal to auto-detect from here.
        showProfileSelectModal(conn, "Auto-detect isn't available in the browser build - pick which altimeter this is.");
        return;
    }
    const familyId = await fwDetectVariant(conn);
    if (!familyId) {
        showProfileSelectModal(conn, "Couldn't auto-detect the connected board - pick which altimeter this is.");
    }
    // A detected non-logging family (e.g. SeriousGooseGround) or a detected
    // logging profile both fall through here with nothing left to do -
    // fwDetectVariant() already called setActiveProfile() in the latter case.
}
