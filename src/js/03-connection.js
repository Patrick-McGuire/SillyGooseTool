// --- Bluetooth (BLE) transport -----------------------------------------
// Alternate transport alongside Web Serial (mirrors the same setup in the
// sibling "ars" tool's app.js) for a board wired to a BLE UART-bridge module
// (Ebyte E104-BT5005A in ars's case). One GATT service with two
// characteristics: FFF1 notifies device -> browser, FFF2 is written
// browser -> device. Swap these constants if a different board/module pairs
// with a different profile.
const BLE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_CHUNK_SIZE = 20;

// Adapts a BLE notify characteristic to the ReadableStreamDefaultReader
// shape ({read, cancel, releaseLock}) so Connection.readLoop() doesn't need
// to know which transport it's reading from.
class BleReader {
    constructor() {
        this._queue = [];
        this._waiting = null;
        this._closed = false;
    }
    push(chunk) {
        if (this._waiting) {
            const resolve = this._waiting;
            this._waiting = null;
            resolve({ value: chunk, done: false });
        } else {
            this._queue.push(chunk);
        }
    }
    read() {
        if (this._queue.length) return Promise.resolve({ value: this._queue.shift(), done: false });
        if (this._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this._waiting = resolve; });
    }
    cancel() {
        this._closed = true;
        if (this._waiting) {
            const resolve = this._waiting;
            this._waiting = null;
            resolve({ value: undefined, done: true });
        }
        // Real ReadableStreamDefaultReader.cancel() returns a Promise; this
        // adapter needs to match that contract, not just resolve internally -
        // disconnect() calls `.catch()` directly on the return value, which
        // threw (aborting disconnect entirely, before ever reaching the
        // actual gatt.disconnect() call below it) when this returned
        // undefined instead.
        return Promise.resolve();
    }
    releaseLock() {}
}

// Adapts a BLE write characteristic to a {write(data)} shape used by
// Connection.sendCmd(). Chunked to BLE_WRITE_CHUNK_SIZE since a single GATT
// write is limited to the negotiated ATT MTU, and serialized through a
// promise chain since Web Bluetooth allows only one in-flight GATT
// operation per device at a time.
class BleWriter {
    constructor(characteristic) {
        this._char = characteristic;
        this._chain = Promise.resolve();
    }
    write(data) {
        const run = () => this._writeChunks(data);
        this._chain = this._chain.then(run, run);
        return this._chain;
    }
    async _writeChunks(data) {
        // writeValueWithoutResponse() exists on every characteristic per spec
        // regardless of whether the peripheral actually supports it - the
        // real answer is the characteristic's declared properties.
        const preferWithoutResponse = !!(this._char.properties && this._char.properties.writeWithoutResponse);
        for (let offset = 0; offset < data.length; offset += BLE_WRITE_CHUNK_SIZE) {
            const chunk = data.slice(offset, offset + BLE_WRITE_CHUNK_SIZE);
            if (preferWithoutResponse) {
                await this._char.writeValueWithoutResponse(chunk);
            } else {
                await this._char.writeValue(chunk);
            }
        }
    }
}

// --- Connection -------------------------------------------------------------
// Everything about one serial link to a board: the Web Serial port/reader,
// the binary/text parser state machine, the active altimeter profile, and the
// current recording/streaming buffers. This used to be a pile of top-level
// `let` globals (port, reader, activeProfile, recording, ...) - as a class, a
// second independent connection (a second USB device, or a ground-station
// radio link) is just `new Connection()` + registering it with
// ConnectionManager, not a rewrite. Multi-device UI isn't built yet (nothing
// iterates more than the one active connection today); this shape just gives
// that work somewhere to land.
class Connection {
    constructor(id) {
        this.id = id;
        this.port = null;
        this.reader = null;
        this.keepReading = true;

        // Bluetooth transport state (see BleReader/BleWriter above) -- null
        // unless connectBluetooth() is the active connection path.
        this.transport = null; // 'usb' | 'bluetooth' | null
        this.bleDevice = null;
        this.bleWriter = null;
        // Bound once so add/removeEventListener('gattserverdisconnected', ...)
        // can match the same reference across reconnects on the same device.
        this._onBleDisconnected = () => this.handleBleDisconnected();

        this.profile = ALTIMETER_PROFILES.SillyGoose;
        this.header = this.profile.header;
        this.activeSeries = [...this.profile.defaultSeries];
        this.configs = this.profile.configs;
        this.fwHeaderCrc = headerCrcFor(this.profile);
        // True when the connected board is acting as a ground station (GROUND_STATION_MODE_c),
        // relaying another board's telemetry over radio rather than producing its own flight log.
        // There's no way to ask for this up front - it's set reactively the first time processLine()
        // sees a "RADIO_RX"/"GPS" line (see handleGroundRadioRx/handleGroundGps below), since a
        // SeriousGoose board can be in either mode and only its actual output reveals which.
        this.isGroundStation = false;

        this.recording = false;
        this.streaming = false;
        this.simActive = false; // true while the Simulation tab holds the writable stream locked
        this.currentFlightLines = [];
        this.currentFlightBin = [];
        // Firmware now logs a CONFIG snapshot twice per flight - once at boot, once at ASCENT
        // (launch) - since config can change between the two (CLI edits on the pad). First
        // "CONFIG\t..." line/record seen this flight -> boot, second -> launch.
        this.currentBootConfig = "";
        this.currentLaunchConfig = "";
        // Arbitrary logMessage() text seen mid-offload (anything beyond the "Logger setup" /
        // "Ending Offload" / "CONFIG" control lines handled inline below) - e.g. the watchdog-reset
        // notice. Kept out of currentFlightLines so it can never reach plotFlight()'s numeric
        // parsing; conserved here instead so it survives into the saved flight (see saveFlight()).
        this.currentFlightMessages = [];

        this.liveDataBuffer = [];
        this.maxLivePoints = 200;

        // Every row seen while streaming, uncapped (unlike liveDataBuffer,
        // which is a rolling window sized for the live plot) - one row per
        // radio/serial packet, same text format an offload produces. Reset
        // whenever streaming (re)starts - see 05-live-stream.js.
        this.streamLogLines = [];
        // Arbitrary text (m_debug->message()/warn()/error()/debug() calls firing mid-flight)
        // seen while streaming - same conservation as currentFlightMessages, for the streaming
        // path. logMessage()-sourced text can never appear here since it only ever writes to
        // flash, with no live echo. Reset alongside streamLogLines.
        this.currentStreamMessages = [];

        this.binMsgBytes = [];
        this.binConfigBytes = [];
    }

    // Switches the active altimeter profile, refreshing everything derived from
    // it: log column list, binary CRC fingerprint, and every profile-driven UI
    // piece (series picker, config table, pyro widgets/fire buttons - each
    // rebuild* function documents only what it builds, not this lifecycle).
    // Safe to call any time, including mid-session - flightData already
    // captured under a different profile keeps working via profileForFlight().
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
        // Neither button gets disabled while a connect attempt is in flight
        // otherwise -- clicking "Connect via Bluetooth" again while a scan/
        // picker from an earlier click is still open starts a second,
        // overlapping navigator.bluetooth.requestDevice() call feeding the
        // same shared picker-window state in main.js, which is exactly what
        // produced the reported repeated picker open/close loop.
        setConnectButtonsDisabled(true);
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
            this.transport = 'usb';
            setConnectedUI(true);
            this.keepReading = true;
            this.readLoop();
            await detectAltimeterOnConnect(this);
        } catch (e) {
            DebugLog.error('connection', 'connect failed: ' + e.message);
            logTerm("Connection Error: " + e.message, "red");
        } finally {
            // Unconditional, not just on failure: on success setConnectedUI(true)
            // hides these buttons, but they must already be re-enabled by the time
            // a later disconnect makes them visible again -- otherwise they stay
            // disabled forever (hidden, so unnoticed) and reconnecting is impossible.
            setConnectButtonsDisabled(false);
        }
    }

    async connectBluetooth() {
        if (!navigator.bluetooth) {
            logTerm("Web Bluetooth is not available in this browser.", "red");
            return;
        }
        setConnectButtonsDisabled(true);
        let device;
        try {
            // acceptAllDevices (rather than a services/name filter) is what's
            // been validated against a real BLE UART-bridge module in the
            // sibling "ars" tool -- Chrome's filter matching wasn't reliable
            // against that module's advertising data, so the user picks the
            // right device by name from the full list instead.
            device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [BLE_SERVICE_UUID],
            });
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(BLE_SERVICE_UUID);
            const notifyChar = await service.getCharacteristic(BLE_NOTIFY_UUID);
            const writeChar = await service.getCharacteristic(BLE_WRITE_UUID);

            const bleReader = new BleReader();
            notifyChar.addEventListener('characteristicvaluechanged', (e) => {
                const v = e.target.value;
                bleReader.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
            });
            await notifyChar.startNotifications();

            // Reused on reconnect (same device object) -- avoid stacking listeners.
            device.removeEventListener('gattserverdisconnected', this._onBleDisconnected);
            device.addEventListener('gattserverdisconnected', this._onBleDisconnected);

            this.port = null;
            this.bleDevice = device;
            this.reader = bleReader;
            this.bleWriter = new BleWriter(writeChar);
            this.transport = 'bluetooth';
            DebugLog.info('connection', 'bluetooth connected: ' + (device.name || device.id));
            setConnectedUI(true);
            this.keepReading = true;
            this.readLoop();
            await detectAltimeterOnConnect(this);
        } catch (e) {
            DebugLog.error('connection', 'bluetooth connect failed: ' + e.message);
            logTerm("Bluetooth Connection Error: " + e.message, "red");
            // If gatt.connect() succeeded but a later setup step (service/characteristic
            // discovery, startNotifications()) threw, this.bleDevice never got set --
            // without this, the device stays connected at the OS/Bluetooth level with
            // nothing in the UI able to see or disconnect it.
            if (device && device.gatt && device.gatt.connected) {
                try { device.gatt.disconnect(); } catch (_) {}
            }
        } finally {
            // Unconditional -- see the comment in connect()'s finally block above.
            setConnectButtonsDisabled(false);
        }
    }

    // 'gattserverdisconnected' listener -- the Bluetooth analog of the read
    // loop's catch block below (device out of range, powered off, etc.).
    handleBleDisconnected() {
        this.keepReading = false;
        if (this.reader) { this.reader.cancel(); }
        DebugLog.info('connection', 'bluetooth disconnected');
        this.forceUIDisconnect();
    }

    async disconnect() {
        this.keepReading = false;
        // try/catch (not .catch() chained onto the call) so this can't ever
        // throw regardless of what this.reader.cancel() returns -- a plain
        // try/catch around `await x` is safe even if x isn't a promise at
        // all (await on a non-promise just resolves immediately), whereas
        // `x.catch()` throws outright if x is undefined. This exact gap
        // previously aborted disconnect() before it ever reached the real
        // gatt.disconnect() call below, for any BLE session.
        if (this.reader) {
            try { await this.reader.cancel(); } catch (_) {}
            this.reader = null;
        }
        if (this.transport === 'bluetooth') {
            if (this.bleDevice) {
                try { this.bleDevice.removeEventListener('gattserverdisconnected', this._onBleDisconnected); } catch (_) {}
                try { if (this.bleDevice.gatt.connected) this.bleDevice.gatt.disconnect(); } catch (_) {}
            }
        } else if (this.port) {
            // Best-effort, same as the reader.cancel() above: a port that's already
            // gone (device unplugged, crashed mid-offload) rejects close() - without
            // catching that, this throw would skip forceUIDisconnect() entirely,
            // leaving the UI stuck showing "connected" to a dead port with no way
            // to recover short of reloading the app.
            await this.port.close().catch(() => {});
        }
        DebugLog.info('connection', 'disconnected');
        this.forceUIDisconnect();
    }

    forceUIDisconnect() {
        this.port = null; this.reader = null; this.bleWriter = null; this.bleDevice = null; this.transport = null;
        setBusy(false); this.recording = false; this.streaming = false;
        setConnectedUI(false);
        // 'offloadProgress' is only otherwise cleared by a clean "Ending Offload"
        // line (see processLine below) - a disconnect mid-offload (failed/hung
        // device, dropped USB, manual disconnect) would otherwise leave the
        // Offload button's label stuck on its last "N rows…" count forever.
        Telemetry.set('offloadProgress', null);
    }

    async sendCmd(msg) {
        // The Simulation tab holds its own writer on this same stream for the whole run - a
        // second concurrent writer would throw. See Simulation.run() in 10-simulation.js.
        if (this.simActive) return;
        if (this.transport === 'bluetooth') {
            if (!this.bleWriter) return;
            setBusy(true);
            await this.bleWriter.write(new TextEncoder().encode(msg + "\n"));
        } else {
            if (!this.port || !this.port.writable) return;
            setBusy(true);
            const writer = this.port.writable.getWriter();
            await writer.write(new TextEncoder().encode(msg + "\n"));
            writer.releaseLock();
        }
        DebugLog.tx('serial', msg);
        logTerm(`>> ${msg}`, "#38bdf8");
        if (!msg.includes("offload") && !msg.includes("erase") && !msg.includes("streamLog")) setTimeout(() => setBusy(false), 800);
    }

    // Handle one logical text line (from the text stream, or reconstructed from a
    // binary message record). Mirrors the original per-line offload logic.
    //
    // IMPORTANT (perf): data rows arrive at up to 50-100Hz while recording or
    // streaming. Echoing each one to the terminal grows termBuffer faster than
    // its 100ms flush can drain it - worse still while occluded, since
    // `setInterval` timers (including that flush) get throttled hard in the
    // background (same root cause as yieldToEventLoop's comment below). That's
    // what made offload visibly lag and alt-tab-back hang. Rows are already
    // captured into currentFlightLines/streamLogLines; recordOffloadProgress()
    // and the Live Graph tab's "last message age" cover the human-visible need
    // instead of a scrollback nobody reads in real time.
    processLine(line) {
        // The firmware emits this every tick while a *Sim build is running (see
        // SimulationParser::waitForEntry()) - route it to the flow-control loop instead of
        // logging it, since at ~100Hz it would flood the terminal exactly like data rows do
        // (see the perf note below).
        if (this.simActive) {
            const simSizeMatch = line.match(/^--simSize\s+(\d+)/);
            if (simSizeMatch) { Simulation.onSizeReport(parseInt(simSizeMatch[1], 10)); return; }
        }

        const isDataRow = /^\d/.test(line);
        if (!((this.recording || this.streaming) && isDataRow)) logTerm(line);

        // Ground station relay lines (GroundStationRelay::tick(), GROUND_STATION_MODE_c) - handled
        // after the generic terminal echo above (so they're still visible there like every other
        // line - useful for eyeballing e.g. GPS fix/satellite counts directly) but before the
        // MSG-text matching below, since they're this connection's actual telemetry, not log text.
        // Neither prefix is ever emitted outside ground-station mode, so seeing one is itself the
        // detection signal - there's no separate "ask the board its mode" step.
        if (line.startsWith("RADIO_RX\t")) { this.isGroundStation = true; this.handleGroundRadioRx(line); return; }
        if (line.startsWith("GPS\t")) { this.isGroundStation = true; this.handleGroundGps(line); return; }

        if (line.includes("Entries in log:")) Telemetry.set('logEntries', line.split(':').pop().trim());
        if (line.includes("Remaining log length:")) Telemetry.set('logRemaining', formatLogTime(line.split(':').pop().trim()));
        if (line.includes("Logging")) Telemetry.set('logStatus', line.includes("enabled") ? "ON" : "OFF");

        if (line.includes("Streaming enabled")) { this.streaming = true; this.liveDataBuffer = []; this.streamLogLines = []; this.currentStreamMessages = []; Telemetry.set('streaming', true); }
        if (line.includes("Streaming disabled")) { this.streaming = false; Telemetry.set('streaming', false); }

        const setMatch = line.match(/MSG:\s+([A-Z_]+)\s+is set to:\s+(.+)/);
        if (setMatch) {
            Telemetry.set(`cfg.${setMatch[1]}`, setMatch[2].trim());
            setBusy(false);
        }

        if (line.includes("Starting Offload")) {
            this.recording = true; this.currentFlightLines = []; this.currentFlightBin = [];
            this.currentBootConfig = ""; this.currentLaunchConfig = ""; this.currentFlightMessages = [];
            Telemetry.set('offloadProgress', 0);
            setBusy(true);
            return;
        }

        if (this.streaming) {
            if (isDataRow) handleLiveLine(this, line);
            // "Streaming enabled"/"disabled" are session-boundary signals, already handled
            // above - not arbitrary logged text, so excluded here same as the recording
            // block excludes "Logger setup"/"Ending Offload"/"CONFIG".
            else if (!line.includes("Streaming enabled") && !line.includes("Streaming disabled")) {
                handleLiveMessage(this, line);
            }
        }

        if (this.recording) {
            if (line.includes("Logger setup")) { this.flushRecordedFlight(); return; }
            if (line.includes("Ending Offload")) { this.flushRecordedFlight(); this.recording = false; Telemetry.set('offloadProgress', null); setBusy(false); return; }
            if (line.startsWith("CONFIG\t") || line.startsWith("CONFIG ")) {
                if (!this.currentBootConfig) this.currentBootConfig = line; else this.currentLaunchConfig = line;
                return;
            }
            if (isDataRow) { this.currentFlightLines.push(line); this.recordOffloadProgress(); }
            // Anything else during a recording is arbitrary logged text (data rows always start
            // with a digit timestamp, so this is an exhaustive - not best-effort - classifier).
            else this.currentFlightMessages.push({ afterRow: this.currentFlightLines.length, text: line });
        }
        if (line.includes("Erase Complete")) setBusy(false);
    }

    // Decodes one "RADIO_RX\t<rssi>\t<snr>\t<hexPayload>" line (GroundStationRelay::tick()) into the
    // same tab-row text a direct connection's --streamLog produces, then feeds it through the
    // normal live-telemetry path (handleLiveLine) - Live Stream, Live Map, and the pyro badges
    // (including aux) all work exactly as they do for a direct connection, with no separate code
    // path to keep in sync. A ground station has no "streaming on/off" concept of its own (unlike
    // a direct connection's --streamLog) - the first relayed packet just turns it on, mirroring the
    // "Streaming enabled" text handling above.
    //
    // The hex payload is the flight computer's raw LogDataStruct with NO leading id byte
    // (radio.startTransmit() sends the struct directly - unlike a flash/offload record, which is
    // wrapped in InternalStruct_s{id, data, crc}). profile.decodeDataRecord() always skips byte 0
    // (the flash record's id byte) - prepending one dummy byte here reuses that decoder unmodified
    // rather than forking a second copy of the field-offset logic.
    handleGroundRadioRx(line) {
        const parts = line.split('\t');
        if (parts.length < 4) return;
        const rssi = parseInt(parts[1], 10);
        const snr = parseFloat(parts[2]);
        const hex = parts[3];
        if (hex.length % 2 !== 0) {
            DebugLog.warn('ground', `RADIO_RX odd-length hex payload (${hex.length} chars) - dropping`);
            return;
        }
        const payload = new Uint8Array(hex.length / 2);
        for (let i = 0; i < payload.length; i++) payload[i] = parseInt(hex.substr(i * 2, 2), 16);
        if (payload.length !== this.profile.binDataSize) {
            DebugLog.warn('ground', `RADIO_RX payload is ${payload.length} bytes, expected ${this.profile.binDataSize} for ${this.profile.id} - dropping`);
            return;
        }
        const padded = new Uint8Array(payload.length + 1); // dummy id byte at [0], see comment above
        padded.set(payload, 1);

        Telemetry.set('radioLink', { rssi, snr });
        if (!this.streaming) {
            this.streaming = true; this.liveDataBuffer = []; this.streamLogLines = []; this.currentStreamMessages = [];
            Telemetry.set('streaming', true);
        }
        try {
            handleLiveLine(this, this.profile.decodeDataRecord(padded));
        } catch (e) {
            DebugLog.warn('ground', 'RADIO_RX decode failed: ' + e.message);
        }
    }

    // Decodes the ground station's OWN GPS fix - "GPS\t<lat>\t<lon>\t<alt>\t<unixTime>\t<hdop>\t
    // <vdop>\t<fixQuality>\t<satellites>" (GroundStationRelay::tick()) - NOT the relayed flight
    // computer's position (that comes through RADIO_RX -> handleGroundRadioRx -> the profile's own
    // gpsLat/gpsLon columns, published separately by publishTelemetryFromRow()). Kept under its own
    // Telemetry key since the two are different physical locations; a "ground/pad marker" on the
    // Live Map is a natural future consumer (see that file's header comment).
    handleGroundGps(line) {
        const p = line.split('\t');
        if (p.length < 9) return;
        Telemetry.set('groundGps', {
            lat: parseFloat(p[1]), lon: parseFloat(p[2]), alt: parseFloat(p[3]),
            unixTimeS: parseInt(p[4], 10), hdop: parseInt(p[5], 10), vdop: parseInt(p[6], 10),
            fixQuality: parseInt(p[7], 10), sats: parseInt(p[8], 10)
        });
    }

    // Publishes the running row count every 100 rows rather than every row -
    // frequent enough to look live, far too infrequent to be a perf concern.
    recordOffloadProgress() {
        if (this.currentFlightLines.length % 100 === 0) Telemetry.set('offloadProgress', this.currentFlightLines.length);
    }

    flushRecordedFlight() {
        if (this.currentFlightLines.length > 5) {
            saveFlight(this, this.currentFlightLines, {
                bootConfig: this.currentBootConfig, launchConfig: this.currentLaunchConfig,
                binChunks: this.currentFlightBin, messages: this.currentFlightMessages
            });
        }
        this.currentFlightLines = []; this.currentFlightBin = [];
        this.currentBootConfig = ""; this.currentLaunchConfig = ""; this.currentFlightMessages = [];
    }

    // Flush an accumulated binary message record into the normal line handler
    // (carries "Logger setup" flight boundaries and "CONFIG\t..." rows).
    flushBinMessage() {
        if (!this.binMsgBytes.length) return;
        const nul = this.binMsgBytes.indexOf(0);
        const bytes = nul >= 0 ? this.binMsgBytes.slice(0, nul) : this.binMsgBytes;
        const str = td.decode(new Uint8Array(bytes)).replace(/\s+$/, '');
        this.binMsgBytes = [];
        if (str) this.processLine(str);
    }

    // Flush an accumulated binary CONFIG record: decode it against the active profile's field
    // layout and synthesize the same "CONFIG\tNAME=value\t..." text form processLine()'s text-mode
    // CONFIG capture already produces, so both wire formats end up in the same bootConfig/
    // launchConfig slots regardless of source.
    flushBinConfig() {
        if (!this.binConfigBytes.length || !this.recording) { this.binConfigBytes = []; return; }
        const bytes = new Uint8Array(this.binConfigBytes);
        this.binConfigBytes = [];
        const decoded = decodeConfigRecord(bytes, this.profile.configFields);
        const asText = formatConfigAsText(decoded, this.profile.configFields);
        if (!this.currentBootConfig) this.currentBootConfig = asText; else this.currentLaunchConfig = asText;
    }

    processBinRecord(id, rec) {
        if (id !== LOG_MESSAGE_CONTINUATION) this.flushBinMessage();
        if (id !== LOG_CONFIG_CONTINUATION) this.flushBinConfig();
        // Exact raw mirror of every non-corrupt flash record (data, message, config, new-flight
        // alike) - matches the firmware's own binary-offload framing, which never distinguished
        // record types on the wire either. Text reconstruction below is a separate, additional path.
        if (this.recording) this.currentFlightBin.push(rec);
        if (id === LOG_DATA) {
            if (this.recording) {
                this.currentFlightLines.push(this.profile.decodeDataRecord(rec));
                this.recordOffloadProgress();
            }
        } else if (id === LOG_MESSAGE || id === LOG_MESSAGE_CONTINUATION) {
            for (let i = 1; i < rec.length; i++) this.binMsgBytes.push(rec[i]);
        } else if (id === LOG_CONFIG || id === LOG_CONFIG_CONTINUATION) {
            for (let i = 1; i < rec.length; i++) this.binConfigBytes.push(rec[i]);
        }
        // LOG_NEW_FLIGHT: flight splitting is driven by the "Logger setup" message
    }

    async readLoop() {
        // Bluetooth's this.reader (a BleReader) is created once by
        // connectBluetooth() and reused as-is -- unlike a Web Serial
        // ReadableStream's reader, it isn't re-acquired from a `readable`
        // property each outer iteration.
        while (this.keepReading && (this.transport === 'bluetooth' ? this.reader : (this.port && this.port.readable))) {
            if (this.transport !== 'bluetooth') this.reader = this.port.readable.getReader();
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
                                // Trailing-only: a leading .trim() would eat intentional indentation
                                // (e.g. --help's indented sub-flags).
                                const line = td.decode(buf.slice(0, nl)).replace(/\s+$/, '');
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
                                if (mode === 'records') { this.flushBinMessage(); this.flushBinConfig(); }
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
                // A genuinely dead port (device unplugged, crashed mid-offload)
                // lands here. Without forceUIDisconnect(), the read loop just
                // stops silently: the port stays set, the UI keeps showing
                // "connected", and any in-progress offload's progress/label
                // stays stuck forever with no way to recover except reloading
                // the app - this makes the failure visible and recoverable.
                DebugLog.error('connection', 'read loop error: ' + e.message);
                this.forceUIDisconnect();
                break;
            } finally { if (this.reader && this.transport !== 'bluetooth') { this.reader.releaseLock(); this.reader = null; } }
        }
    }
}

// Toggles the Connect/Disconnect tab-bar buttons and every device-facing
// control together. The three places a connection actually opens or closes -
// Connection.connect, Connection.forceUIDisconnect, and firmware.js's
// fwAdoptPort (post-flash auto-reconnect) - all flip the same three things,
// so they share this instead of repeating it.
function setConnectedUI(connected) {
    document.getElementById('connectBtn').style.display = connected ? 'none' : (navigator.serial ? 'block' : 'none');
    document.getElementById('connectBluetoothBtn').style.display = connected ? 'none' : (navigator.bluetooth ? 'block' : 'none');
    document.getElementById('disconnectBtn').style.display = connected ? 'block' : 'none';
    setSerialEnabled(connected);
    // Desktop-only workaround for a reported rendering glitch (main window
    // content shrinking to roughly half its width after connect/disconnect) -
    // window.sgWindow only exists in the Electron build (see preload.js), so
    // this is a no-op in the plain browser build.
    if (window.sgWindow) window.sgWindow.nudgeRepaint();
}

// Guards against a second, overlapping connect attempt while one is already
// in flight (mid-scan/picker-open) -- see the comment in Connection.connect().
// setConnectedUI() only toggles display, not disabled, so this is separate.
function setConnectButtonsDisabled(disabled) {
    document.getElementById('connectBtn').disabled = disabled;
    document.getElementById('connectBluetoothBtn').disabled = disabled;
}

// Returns the profile a saved flight was captured under (stamped by
// saveFlight()/the file-upload handler), falling back to the currently active
// profile for older in-memory flights that predate the stamp.
function profileForFlight(f) {
    return (f && ALTIMETER_PROFILES[f.profileId]) || ConnectionManager.getActive().profile;
}

// A macrotask yield (not just a microtask) so pending rendering/GC/timers get a
// turn - breaks up long synchronous bursts of buffered record parsing.
//
// IMPORTANT: this used to be `setTimeout(resolve, 0)`. Chromium (and Electron)
// throttles timers heavily once a window is occluded/backgrounded - alt-
// tabbing away is enough. Each yield could then take ~1s instead of ~0ms, so
// the read loop fell further behind the longer the window stayed unfocused,
// then had to burn through the backlog all at once on refocus - a multi-
// second hang right when you tabbed back in. A MessageChannel round-trip
// schedules a real macrotask without that background clamp, so the read loop
// keeps pace regardless of focus.
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
// Holds every live Connection (see its own multi-device note above). Exactly
// one is ever created/active today; the array + active-id indirection just
// means a second connection is additive later - push another Connection,
// point its UI at the new id, done. Nothing today iterates `connections`
// expecting more than one.
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
    // Reset on every connect attempt - conn is reused across sessions, and whether this particular
    // SeriousGoose is actually running in ground-station mode can't be known from its USB identity
    // alone (GROUND_STATION_MODE_c is a runtime config, not a separate board/firmware). This only
    // flips true reactively in processLine() once a "RADIO_RX"/"GPS" line is actually seen.
    conn.isGroundStation = false;

    // Desktop reads the USB iProduct string (fwDetectVariant, precise down to variant number);
    // a plain browser only gets numeric vendor/product ids (fwDetectFamilyFromUsbIds) - still
    // enough to tell SillyGoose from SeriousGoose, see that function's comment in 08-firmware.js.
    const familyId = window.sgFirmware ? await fwDetectVariant(conn) : fwDetectFamilyFromUsbIds(conn);
    if (!familyId) {
        // In the browser, include the raw USB id in the hint - fwDetectFamilyFromUsbIds()'s PID
        // table is unconfirmed against real hardware, so this is the fastest way to see what a
        // given board actually reports and fix the table if it's wrong.
        const idHex = !window.sgFirmware && fwUsbIdHexString(conn);
        showProfileSelectModal(conn, idHex
            ? `Couldn't auto-detect the connected board (USB ${idHex}) - pick which altimeter this is.`
            : "Couldn't auto-detect the connected board - pick which altimeter this is.");
        return;
    }
    // Nothing left to do here - fwDetectVariant()/fwDetectFamilyFromUsbIds() already called
    // setActiveProfile() for it.
}
