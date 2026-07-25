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
    "drogueCont", "drogueFired", "mainCont", "mainFired", "auxCont", "auxFired",
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
const SERIOUS_GOOSE_LOG_HEADER_STR = "timestampMs\tpressurePa\tbarometerTemperatureK\taccelerationMSS_x\taccelerationMSS_y\taccelerationMSS_z\tvelocityRadS_x\tvelocityRadS_y\tvelocityRadS_z\timuTemperatureK\tmagFieldTeslaRaw_x\tmagFieldTeslaRaw_y\tmagFieldTeslaRaw_z\tbatteryVoltageV\taltitudeM\tvelocityMS\taccelerationMSS\tunfilteredAltitudeM\tflightState\tdrogueContinuity\tdrogueFired\tmainContinuity\tmainFired\tauxContinuity\tauxFired\ttiltMagnitudeDeg\tangularVelRadS_x\tangularVelRadS_y\tangularVelRadS_z\tquaternion_a\tquaternion_b\tquaternion_c\tquaternion_d\tgpsLatitudeDeg\tgpsLongitudeDeg\tgpsAltitudeM\tgpsUnixTimeS\tgpsHdop\tgpsVdop\tgpsFixQuality\tgpsSatellitesTracked";

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
        hasGps: false,
        decodeDataRecord(rec) {
            const dv = new DataView(rec.buffer, rec.byteOffset, rec.length);
            const common = decodeCommonFields(dv);
            const pyro = decodeBattThroughPyroFields(dv, common.offset);
            const orient = decodeOrientationFields(dv, pyro.offset);
            return formatDecodedRow([...common.fields, ...pyro.fields, ...orient.fields]);
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
        header: SERIOUS_GOOSE_HEADER,
        oldMinCols: 36, // still a valid MINIMUM column count even post-mag/aux-pyro (41 cols now) - not bumped
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
            const auxContinuity = dv.getUint8(o); o += 1;
            const auxFired = dv.getUint8(o); o += 1;
            const orient = decodeOrientationFields(dv, o);
            o = orient.offset;
            const all = [...common.fields, magX, magY, magZ, ...pyro.fields, auxContinuity, auxFired, ...orient.fields];
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
