// --- Altimeter profiles -----------------------------------------------------
// Everything that differs between flight computer variants (log column layout,
// binary record decoding, config set, firmware asset naming) lives in one of
// these profile objects. The rest of the app reads through a connection's
// `profile` / `header` / `configs` rather than hardcoding a specific board's
// layout, so adding a new board should only mean adding a new profile here.
//
// SeriousGoose's log struct is NOT just SillyGoose's struct with GPS fields
// appended: it inserts its raw magnetometer (magX/Y/Z) right after imuTemp,
// BEFORE battV, and its aux pyro channel (`auxContinuity`/`auxFired`) right
// after mainFired, before the tilt/angularVel/quaternion block SillyGoose
// also has. Both insertions shift every subsequent SillyGoose column for
// SeriousGoose only. `COMMON_COLS` below only covers the genuinely identical
// prefix (timestampMs - the only field before the first insertion point) -
// each profile defines the rest of its own `cols` past that. Per-flight code
// should look values up through the flight's own profile's `cols` (see
// `profileForFlight()`), not assume the two profiles agree beyond that.
const SILLY_GOOSE_HEADER = [
    "timestampMs", "pressurePa", "tempK", "accelX", "accelY", "accelZ",
    "gyroX", "gyroY", "gyroZ", "imuTemp", "battV", "altitudeM",
    "velocityMS", "accelerationMSS", "unfiltAlt", "flightState",
    "drogueCont", "drogueFired", "mainCont", "mainFired",
    "tiltMagnitudeDeg", "angularVelRadS_x", "angularVelRadS_y", "angularVelRadS_z",
    "quaternion_a", "quaternion_b", "quaternion_c", "quaternion_d"
];
const SERIOUS_GOOSE_HEADER = [
    "timestampMs", "pressurePa", "tempK", "accelX", "accelY", "accelZ",
    "gyroX", "gyroY", "gyroZ", "imuTemp", "magX", "magY", "magZ", "battV", "altitudeM",
    "velocityMS", "accelerationMSS", "unfiltAlt", "flightState",
    // drogueState/mainState/auxState pack a 0/1/2 continuity+armed reading (see ArduinoPyro's
    // two-threshold model, firmware) into the same single byte a plain bool continuity flag
    // already used - no wire-size change from SillyGoose's continuity/fired layout below.
    "drogueState", "drogueFired", "mainState", "mainFired", "auxState", "auxFired",
    "tiltMagnitudeDeg", "angularVelRadS_x", "angularVelRadS_y", "angularVelRadS_z",
    "quaternion_a", "quaternion_b", "quaternion_c", "quaternion_d",
    "gpsLatitudeDeg", "gpsLongitudeDeg", "gpsAltitudeM", "gpsUnixTimeS", "gpsHdop", "gpsVdop", "gpsFixQuality", "gpsSatellitesTracked"
];
// Genuinely identical between every board so far - just timestampMs, since
// SeriousGoose's magX/Y/Z insertion (see comment above) shifts everything
// from battV onward. Pyro columns are NOT here either - see each profile's
// own `pyros` list below, since boards can have a different number of pyro
// channels (SillyGoose: drogue+main; SeriousGoose: +aux; a future board
// might have more still).
const COMMON_COLS = {
    timestampMs: 0
};
const SILLY_GOOSE_LOG_HEADER_STR = "timestampMs\tpressurePa\tbarometerTemperatureK\taccelerationMSS_x\taccelerationMSS_y\taccelerationMSS_z\tvelocityRadS_x\tvelocityRadS_y\tvelocityRadS_z\timuTemperatureK\tbatteryVoltageV\taltitudeM\tvelocityMS\taccelerationMSS\tunfilteredAltitudeM\tflightState\tdrogueContinuity\tdrogueFired\tmainContinuity\tmainFired\ttiltMagnitudeDeg\tangularVelRadS_x\tangularVelRadS_y\tangularVelRadS_z\tquaternion_a\tquaternion_b\tquaternion_c\tquaternion_d";
// Must match SeriousGoose.cpp's LOG_HEADER macro byte-for-byte - it's hashed
// (see crc16/headerCrcFor below) to auto-detect/validate a binary offload's
// format, so any drift here silently breaks that detection instead of erroring.
const SERIOUS_GOOSE_LOG_HEADER_STR = "timestampMs\tpressurePa\tbarometerTemperatureK\taccelerationMSS_x\taccelerationMSS_y\taccelerationMSS_z\tvelocityRadS_x\tvelocityRadS_y\tvelocityRadS_z\timuTemperatureK\tmagFieldTeslaRaw_x\tmagFieldTeslaRaw_y\tmagFieldTeslaRaw_z\tbatteryVoltageV\taltitudeM\tvelocityMS\taccelerationMSS\tunfilteredAltitudeM\tflightState\tdrogueState\tdrogueFired\tmainState\tmainFired\tauxState\tauxFired\ttiltMagnitudeDeg\tangularVelRadS_x\tangularVelRadS_y\tangularVelRadS_z\tquaternion_a\tquaternion_b\tquaternion_c\tquaternion_d\tgpsLatitudeDeg\tgpsLongitudeDeg\tgpsAltitudeM\tgpsUnixTimeS\tgpsHdop\tgpsVdop\tgpsFixQuality\tgpsSatellitesTracked";

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
    { id: "RADIO_TRANSMIT_INTERVAL", label: "Radio TX Interval (milliseconds)" },
    { id: "GROUND_STATION_MODE", label: "Ground Station Mode", type: "checkbox" }
];

// Byte layout for a decoded LOG_CONFIG record's payload (see BasicLogger::logConfig() /
// Configuration::getConfigDataBuffer()) - in firmware's declared/sorted-ID order
// (ConfigurationRegistry.h), which is also assignMemory()'s field-placement order. SillyGoose
// registers everything except the 3 radio fields; SeriousGoose registers all of them. This is a
// DIFFERENT list from SILLY_GOOSE_CONFIGS/RADIO_CONFIGS above (those drive the editable-config
// UI widget list and omit several fields - FLIGHT_STATE, BOARD_ORIENTATION, LAUNCH_ANGLE,
// GYROSCOPE_BIAS - that still exist in the binary snapshot and must be decodable here).
const CONFIG_FIELD_DEFS = [
    { name: "BOARD_NAME", type: "str", size: 100, align: 1 },
    { name: "FIRMWARE_VERSION", type: "str", size: 20, align: 1 },
    { name: "FLIGHT_STATE", type: "i32", size: 4, align: 4 },
    { name: "GROUND_ELEVATION", type: "f32", size: 4, align: 4 },
    { name: "GROUND_TEMPERATURE", type: "f32", size: 4, align: 4 },
    { name: "BOARD_ORIENTATION", type: "i32", size: 4, align: 4 },
    { name: "LAUNCH_ANGLE", type: "quat", size: 16, align: 4 },
    { name: "GYROSCOPE_BIAS", type: "gbias", size: 48, align: 4 },
    { name: "PYRO_FIRE_DURATION", type: "u32", size: 4, align: 4 },
    { name: "MAIN_ELEVATION", type: "f32", size: 4, align: 4 },
    { name: "DROGUE_DELAY", type: "u32", size: 4, align: 4 },
    { name: "BATTERY_VOLTAGE_SENSOR_SCALE_FACTOR", type: "f32", size: 4, align: 4 },
    { name: "RADIO_FREQUENCY", type: "f32", size: 4, align: 4, radioOnly: true },
    { name: "LORA_SPREADING_FACTOR", type: "i32", size: 4, align: 4, radioOnly: true },
    { name: "RADIO_TRANSMIT_INTERVAL", type: "u32", size: 4, align: 4, radioOnly: true },
    { name: "BUZZER_ENABLED", type: "u32", size: 4, align: 4 },
    { name: "GROUND_STATION_MODE", type: "u32", size: 4, align: 4, radioOnly: true },
];

// Computes each field's byte offset the same way firmware's Configuration::assignMemory() does
// (round up to the field's own alignment, place, advance). The JS has no live Configuration
// object to borrow already-computed offsets from (unlike firmware's own offload-time
// reconstruction), so this has to actually redo the alignment math.
function layoutConfigFields(fields) {
    let offset = 0;
    return fields.map(f => {
        offset = Math.ceil(offset / f.align) * f.align;
        const laidOut = { ...f, offset };
        offset += f.size;
        return laidOut;
    });
}
const SILLY_GOOSE_CONFIG_FIELDS = layoutConfigFields(CONFIG_FIELD_DEFS.filter(f => !f.radioOnly));
const SERIOUS_GOOSE_CONFIG_FIELDS = layoutConfigFields(CONFIG_FIELD_DEFS);

function decodeConfigField(dv, field) {
    const o = field.offset;
    switch (field.type) {
        case "str": {
            const bytes = new Uint8Array(dv.buffer, dv.byteOffset + o, field.size);
            const nul = bytes.indexOf(0);
            return new TextDecoder().decode(bytes.slice(0, nul >= 0 ? nul : field.size));
        }
        case "i32": return dv.getInt32(o, true);
        case "u32": return dv.getUint32(o, true);
        case "f32": return dv.getFloat32(o, true);
        case "quat": return [0, 1, 2, 3].map(i => dv.getFloat32(o + i * 4, true));
        case "gbias": return [0, 1, 2, 3].map(i => [0, 1, 2].map(j => dv.getFloat32(o + (i * 3 + j) * 4, true)));
        default: return null;
    }
}

// Decodes one reconstructed LOG_CONFIG record (8-byte {version,keyCrc} header + raw config
// bytes - see BasicLogger::logConfig()) using a board profile's field layout. keyCrc can't be
// independently re-verified here: firmware's CRC hashes opaque compile-time enum values the JS
// has no way to reproduce, so it's surfaced for display only - decoded-length-vs-expected is the
// structural sanity check instead. Uses >= rather than == : logChunked() pads the last chunk up
// to a full dataSize multiple, so the reconstructed payload is always at least as long as the
// real fields, usually longer (trailing zero padding, never read here).
function decodeConfigRecord(bytes, configFields) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const version = dv.getUint32(0, true);
    const keyCrc = dv.getUint32(4, true);
    const payload = new DataView(bytes.buffer, bytes.byteOffset + 8, bytes.length - 8);
    const expectedLen = configFields.length ? configFields[configFields.length - 1].offset + configFields[configFields.length - 1].size : 0;
    const fields = {};
    for (const f of configFields) {
        if (f.offset + f.size > payload.byteLength) break;
        fields[f.name] = decodeConfigField(payload, f);
    }
    return { version, keyCrc, fields, lengthMatches: payload.byteLength >= expectedLen };
}

function formatConfigFieldValue(value, type) {
    switch (type) {
        case "f32": return value.toFixed(8);
        case "quat": return value.map(v => v.toFixed(8)).join(",");
        case "gbias": return value.map(triplet => triplet.map(v => v.toFixed(8)).join(",")).join(",");
        default: return String(value); // str, i32, u32
    }
}

// Synthesizes the same "CONFIG\tNAME=value\t..." text a text-mode offload's firmware-side
// formatter (Configuration::formatBufferAsText()) would produce, from a decodeConfigRecord()
// result - so a binary-sourced CONFIG record ends up in the exact same bootConfig/launchConfig
// text form as a text-sourced one, and both can share one display/export code path.
function formatConfigAsText(decoded, configFields) {
    const parts = ["CONFIG"];
    for (const f of configFields) {
        if (!(f.name in decoded.fields)) continue;
        parts.push(`${f.name}=${formatConfigFieldValue(decoded.fields[f.name], f.type)}`);
    }
    parts.push(`CONFIGURATION_VERSION=${decoded.version}`);
    return parts.join("\t");
}

// Firmware's FlightState enum (see Avionics.h) - the canonical source for every
// place that turns a raw flightState int into a label (Offload's graph/summary,
// the Live Map widget, the config viewer's FLIGHT_STATE formatter).
const FLIGHT_STATE_NAMES = { 0: "PRE_FLIGHT", 1: "ASCENT", 2: "DESCENT", 3: "POST_FLIGHT", 4: "UNKNOWN_FLIGHT_STATE" };

// Decodes the fields every board has in common (timestampMs through
// imuTemperatureK) from a DataView positioned at the start of a LOG_DATA
// record (byte 0 is the record id). Returns the fields plus the byte offset
// just past them, so each profile's decodeDataRecord can keep decoding
// whatever comes next in its own layout - SeriousGoose's raw mag floats sit
// right here, shifting everything from battV onward for that board only
// (see decodeBattThroughPyroFields/decodeOrientationFields for the other
// shared blocks, and ALTIMETER_PROFILES for what's profile-specific).
function decodeCommonFields(dv) {
    let o = 1; // skip the id byte
    const f = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
    const fields = [
        u32(),         // timestampMs
        f(), f(),      // pressurePa, barometerTemperatureK
        f(), f(), f(), // accel x,y,z
        f(), f(), f(), // gyro x,y,z
        f(),           // imuTemperatureK
    ];
    return { fields, offset: o };
}

// Decodes battV through mainFired (10 fields) - identical layout on every
// board so far, but its byte OFFSET varies (SeriousGoose's mag floats shift
// it relative to SillyGoose), so callers pass in where it starts.
function decodeBattThroughPyroFields(dv, o) {
    const f = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
    const b = () => dv.getUint8(o++);
    const fields = [
        f(), f(), f(), f(), f(), // battV, altitudeM, velocityMS, accelerationMSS, unfilteredAltitudeM
        i32(),                   // flightState
        b(), b(), b(), b()       // drogueCont, drogueFired, mainCont, mainFired
    ];
    return { fields, offset: o };
}

// Decodes the tilt/angularVel/quaternion block (8 floats) - identical on every
// board so far, but its byte OFFSET varies (SeriousGoose's 2 aux pyro bytes
// shift it relative to SillyGoose), so callers pass in where it starts.
function decodeOrientationFields(dv, o) {
    const f = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
    const fields = [f(), f(), f(), f(), f(), f(), f(), f()]; // tilt, angularVel x,y,z, quat a,b,c,d
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
        cols: { ...COMMON_COLS, battV: 10, altitudeM: 11, velocityMS: 12, flightState: 15, tiltMagnitudeDeg: 20, angularVelX: 21, angularVelY: 22, angularVelZ: 23, quatA: 24, quatB: 25, quatC: 26, quatD: 27 },
        // Pyro channels as a list, not fixed named fields - a board with more
        // (or fewer) than these two just has a longer (or shorter) list here;
        // nothing downstream (Live Map badges, Control Panel Fire buttons,
        // offload graph fired-event markers) hardcodes "drogue"/"main"/"aux".
        pyros: [
            { id: "drogue", label: "Drogue", contCol: 16, firedCol: 17, fireCmd: "--fire -d" },
            { id: "main", label: "Main", contCol: 18, firedCol: 19, fireCmd: "--fire -m" }
        ],
        // ArduinoPyro's continuity byte is 0/1 here (single threshold - no separate armed
        // reading), vs SeriousGoose's 0/1/2 below - see publishTelemetryFromRow() in
        // 06-live-map.js, which is what actually branches on this to interpret contCol's raw
        // value correctly per-profile. Continuity alone reads as ARMED for boards without this
        // tier (matches ArduinoPyro::isArmed()'s firmware-side default), so the UNARMED badge
        // state is simply never reached here.
        pyroHasArmedTier: false,
        hasGps: false,
        decodeDataRecord(rec) {
            const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
            const common = decodeCommonFields(dv);
            const pyro = decodeBattThroughPyroFields(dv, common.offset);
            const orient = decodeOrientationFields(dv, pyro.offset);
            return formatDecodedRow([...common.fields, ...pyro.fields, ...orient.fields]);
        },
        configs: SILLY_GOOSE_CONFIGS,
        configFields: SILLY_GOOSE_CONFIG_FIELDS,
        firmwareVariants: [
            { value: "V1", label: "SillyGoose V1" },
            { value: "V2", label: "SillyGoose V2" }
        ],
        usbNameMatch: /^sillygoose/i
    },
    SeriousGoose: {
        id: "SeriousGoose",
        displayName: "SeriousGoose",
        header: SERIOUS_GOOSE_HEADER,
        oldMinCols: 36, // still a valid MINIMUM column count (41 cols now) - not bumped
        binDataSize: 136, // sizeof(SillyGooseLogData) in SeriousGoose.cpp, packed (100 + 12 mag bytes + 2 aux bytes + 22 GPS bytes)
        fwLogHeader: SERIOUS_GOOSE_LOG_HEADER_STR,
        defaultSeries: [14, 15, 16],
        cols: {
            ...COMMON_COLS,
            magX: 10, magY: 11, magZ: 12,
            battV: 13, altitudeM: 14, velocityMS: 15, flightState: 18,
            tiltMagnitudeDeg: 25, angularVelX: 26, angularVelY: 27, angularVelZ: 28,
            quatA: 29, quatB: 30, quatC: 31, quatD: 32,
            gpsLat: 33, gpsLon: 34, gpsAlt: 35, gpsUnixTimeS: 36, gpsHdop: 37, gpsVdop: 38, gpsFixQuality: 39, gpsSatellites: 40
        },
        // contCol's raw byte value is 0/1/2 here (open/unarmed/armed - see ArduinoPyro's
        // two-threshold model, firmware) vs SillyGoose's 0/1 (above) - packed into the exact same
        // single continuity byte either way, no wire-size change. See pyroHasArmedTier's comment
        // (above) for where this is actually interpreted.
        pyroHasArmedTier: true,
        pyros: [
            { id: "drogue", label: "Drogue", contCol: 19, firedCol: 20, fireCmd: "--fire -d" },
            { id: "main", label: "Main", contCol: 21, firedCol: 22, fireCmd: "--fire -m" },
            { id: "aux", label: "Aux", contCol: 23, firedCol: 24, fireCmd: "--fire -a" }
        ],
        hasGps: true,
        decodeDataRecord(rec) {
            const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
            const common = decodeCommonFields(dv);
            let o = common.offset;
            const magX = dv.getFloat32(o, true); o += 4;
            const magY = dv.getFloat32(o, true); o += 4;
            const magZ = dv.getFloat32(o, true); o += 4;
            const pyro = decodeBattThroughPyroFields(dv, o);
            o = pyro.offset;
            const auxState = dv.getUint8(o); o += 1;
            const auxFired = dv.getUint8(o); o += 1;
            const orient = decodeOrientationFields(dv, o);
            o = orient.offset;
            const all = [...common.fields, magX, magY, magZ, ...pyro.fields, auxState, auxFired, ...orient.fields];
            all.push(dv.getFloat32(o, true)); o += 4; // gpsLatitudeDeg
            all.push(dv.getFloat32(o, true)); o += 4; // gpsLongitudeDeg
            all.push(dv.getFloat32(o, true)); o += 4; // gpsAltitudeM
            all.push(dv.getUint32(o, true)); o += 4;  // gpsUnixTimeS
            all.push(dv.getUint16(o, true)); o += 2;  // gpsHdop
            all.push(dv.getUint16(o, true)); o += 2;  // gpsVdop
            all.push(dv.getUint8(o)); o += 1;         // gpsFixQuality
            all.push(dv.getUint8(o)); o += 1;         // gpsSatellitesTracked
            return formatDecodedRow(all);
        },
        configs: [...SILLY_GOOSE_CONFIGS, ...RADIO_CONFIGS],
        configFields: SERIOUS_GOOSE_CONFIG_FIELDS,
        firmwareVariants: [{ value: "V1", label: "SeriousGoose V1" }],
        // Also matches an old already-deployed SeriousGooseGroundV1 unit (pre-GROUND_STATION_MODE
        // firmware) - it's the same board family/wire protocol, just running as a ground station,
        // which is now a runtime mode rather than separate firmware (see GROUND_STATION_MODE_c).
        usbNameMatch: /^seriousgoose/i
    }
};
const ALL_BOARD_FAMILIES = ALTIMETER_PROFILES;

// --- Binary offload protocol (mirrors firmware BasicLogger.h) ---
const BIN_MAGIC = [0x53, 0x47, 0x42]; // 'SGB'
const LOG_EMPTY = 0xFF, LOG_DATA = 0x01, LOG_NEW_FLIGHT = 0x02, LOG_MESSAGE = 0x03, LOG_MESSAGE_CONTINUATION = 0x04, LOG_CONFIG = 0x05, LOG_CONFIG_CONTINUATION = 0x06;
// CRC-16/CCITT (poly 0x1021, init 0xFFFF) — matches firmware src/util/CRC.h crc16().
function crc16(bytes) {
    let crc = 0xFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc & 0xFFFF;
}
function headerCrcFor(profile) {
    return crc16(Array.from(profile.fwLogHeader, c => c.charCodeAt(0)));
}

// Best-effort guess at which profile a loaded text file belongs to, based on
// how many columns its data rows have. Text files (unlike binary offloads)
// carry no CRC fingerprint, so this is the best available signal.
function guessProfileFromColumnCount(n, fallbackId) {
    const matches = Object.values(ALTIMETER_PROFILES).filter(p => p.header.length === n);
    return matches.length === 1 ? matches[0].id : fallbackId;
}
