// --- Altimeter profiles -----------------------------------------------------
// What differs between flight computer variants that the board can't describe itself: config
// set, binary config layout, firmware asset naming, USB identity. The log data layout is NOT
// here - every board sends its own (see "Log format" below), so the tool keeps no per-board
// list of log variables.

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
    { name: "FIRST_STAGE_BURNOUT", type: "u32", size: 4, align: 4 },
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

// --- Log format ---------------------------------------------------------------
// Firmware defines its log struct with LOG_DATA_AUTO_DEFINE (BasicLoggerHelper.h) and sends the
// definition text as a "LOG_FORMAT\t<definition>" line - at the start of every offload, when
// streaming starts, and in reply to --logFormat (sent on connect). For example:
//   LOG_FORMAT	struct SillyGooseLogData { uint32_t timestampMs; float pressurePa, barometerTemperatureK; ... } __attribute__((packed));
// Everything about the log columns (names, order, binary layout) comes from that. Older firmware
// sends no definition, but its text offloads still start with a tab-separated column-name line,
// which is enough for text data (see Connection.processLine()).
const LOG_FORMAT_PREFIX = "LOG_FORMAT\t";

// The only log fields the tool knows by name: what the live view widgets read, and which series
// the graphs show by default. A board that lacks one just doesn't light up that widget.
const LIVE_FIELDS = {
    timestampMs: "timestampMs",
    altitudeM: "altitudeM",
    velocityMS: "velocityMS",
    flightState: "flightState",
    battV: "batteryVoltageV",
    quatA: "quaternion_a", quatB: "quaternion_b", quatC: "quaternion_c", quatD: "quaternion_d",
    gpsLat: "gpsLatitudeDeg", gpsLon: "gpsLongitudeDeg",
    gpsFixQuality: "gpsFixQuality", gpsSatellites: "gpsSatellitesTracked",
};
const DEFAULT_GRAPH_SERIES = ["altitudeM", "velocityMS", "accelerationMSS"];

// Pyro channels are found by field name: "<id>State" (0/1/2 open/unarmed/armed - see
// ArduinoPyro's two-threshold model) or "<id>Continuity" (plain 0/1), paired with "<id>Fired".
// The fire command is CLI, not log data, so it can't come from the definition.
const PYRO_FIRE_FLAGS = { drogue: "-d", main: "-m", aux: "-a" };

// Same rules as BasicLoggerHelper's parser, with the target's sizes (ARM: long is 4 bytes,
// plain char is unsigned). The binary preamble's struct size double-checks the result.
const NAMED_LOG_TYPES = {
    bool: { kind: "b", size: 1 }, float: { kind: "f", size: 4 }, double: { kind: "f", size: 8 },
    int8_t: { kind: "i", size: 1 }, int16_t: { kind: "i", size: 2 }, int32_t: { kind: "i", size: 4 }, int64_t: { kind: "i", size: 8 },
    uint8_t: { kind: "u", size: 1 }, uint16_t: { kind: "u", size: 2 }, uint32_t: { kind: "u", size: 4 }, uint64_t: { kind: "u", size: 8 },
};
const INT_TYPE_KEYWORDS = new Set(["unsigned", "signed", "short", "long", "char", "int"]);
const IDENT_RE = /^[A-Za-z_]\w*$/;

function resolveLogType(words) {
    if (words.length === 1 && NAMED_LOG_TYPES[words[0]]) return NAMED_LOG_TYPES[words[0]];
    if (!words.length || !words.every(w => INT_TYPE_KEYWORDS.has(w))) return null;
    const longs = words.filter(w => w === "long").length;
    const isChar = words.includes("char"), isShort = words.includes("short");
    const size = isChar ? 1 : isShort ? 2 : longs >= 2 ? 8 : 4;
    const signed = words.includes("unsigned") ? false : words.includes("signed") ? true : !isChar;
    return { kind: signed ? "i" : "u", size };
}

// Parses a LOG_FORMAT definition into { definition, structName, fields: [{name, type, kind,
// size, offset}], size, header: [names] }. Throws on anything it can't lay out - the firmware's
// static_asserts reject the same constructs, so this only fires for corrupted or foreign input.
function parseLogFormat(definition) {
    const open = definition.indexOf("{");
    const close = open < 0 ? -1 : definition.indexOf("}", open);
    if (open < 0 || close < 0) throw new Error("no struct body");
    const nameMatch = definition.slice(0, open).match(/struct\s+([A-Za-z_]\w*)/);
    const fields = [];
    let offset = 0;
    for (const rawDecl of definition.slice(open + 1, close).split(";")) {
        const decl = rawDecl.trim();
        if (!decl) continue;
        const parts = decl.split(",").map(p => p.trim());
        const words = parts[0].split(/\s+/);
        const names = [words.pop(), ...parts.slice(1)];
        const type = resolveLogType(words);
        if (!type) throw new Error(`unsupported type "${words.join(" ")}"`);
        for (const name of names) {
            if (!IDENT_RE.test(name)) throw new Error(`bad field name "${name}"`);
            fields.push({ name, type: words.join(" "), kind: type.kind, size: type.size, offset });
            offset += type.size;
        }
    }
    if (!fields.length) throw new Error("struct has no fields");
    return { definition, structName: nameMatch ? nameMatch[1] : "", fields, size: offset, header: fields.map(f => f.name) };
}

// A firmware column-name line ("timestampMs\tpressurePa\t...") - the fallback when no
// LOG_FORMAT was sent. Data rows start with a digit and CONFIG/MSG lines contain '=' / ':',
// so this can't match either.
function isHeaderNamesLine(line) {
    const names = line.split("\t");
    return names.length > 1 && names.every(n => IDENT_RE.test(n));
}

// Decodes one packed record (little-endian) into display strings, starting `base` bytes in -
// 1 for flash/offload records (byte 0 is the record id), 0 for a bare struct.
function decodeLogRecord(format, bytes, base) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return format.fields.map(f => {
        const o = base + f.offset;
        if (f.kind === "f") {
            // 9 significant digits round-trips a float; String() alone would print the
            // double expansion (101325.1171875 for 101325.117f)
            return f.size === 4 ? String(parseFloat(dv.getFloat32(o, true).toPrecision(9))) : String(dv.getFloat64(o, true));
        }
        if (f.size === 8) return String(f.kind === "i" ? dv.getBigInt64(o, true) : dv.getBigUint64(o, true));
        if (f.kind === "i") return String(f.size === 1 ? dv.getInt8(o) : f.size === 2 ? dv.getInt16(o, true) : dv.getInt32(o, true));
        return String(f.size === 1 ? dv.getUint8(o) : f.size === 2 ? dv.getUint16(o, true) : dv.getUint32(o, true));
    });
}

// Column lookups for one header (a list of field names): `cols` maps each LIVE_FIELDS key to
// its column index (missing when the board doesn't log it), `pyros` lists the detected pyro
// channels. Cached per header array.
const layoutCache = new WeakMap();
function layoutForHeader(header) {
    if (layoutCache.has(header)) return layoutCache.get(header);
    const index = new Map(header.map((n, i) => [n, i]));
    const cols = {};
    for (const [key, name] of Object.entries(LIVE_FIELDS)) if (index.has(name)) cols[key] = index.get(name);
    const pyros = [];
    header.forEach((name, i) => {
        const m = name.match(/^([a-z]\w*?)(State|Continuity)$/);
        if (!m || !index.has(`${m[1]}Fired`)) return;
        const id = m[1];
        pyros.push({
            id, label: id.charAt(0).toUpperCase() + id.slice(1),
            contCol: i, firedCol: index.get(`${id}Fired`),
            hasArmedTier: m[2] === "State",
        });
    });
    const layout = { cols, pyros };
    layoutCache.set(header, layout);
    return layout;
}

// Flight computer profiles - drive System Configuration and firmware updates. Log columns are
// per-connection/per-flight instead (Connection.header, flight.header), from the board's own
// LOG_FORMAT.
const ALTIMETER_PROFILES = {
    SillyGoose: {
        id: "SillyGoose",
        displayName: "SillyGoose",
        configs: SILLY_GOOSE_CONFIGS,
        configFields: SILLY_GOOSE_CONFIG_FIELDS,
        pyroChannels: ["drogue", "main"],
        armable: false,
        firmwareVariants: [
            { value: "V1", label: "SillyGoose V1" },
            { value: "V2", label: "SillyGoose V2" }
        ],
        usbNameMatch: /^sillygoose/i
    },
    SeriousGoose: {
        id: "SeriousGoose",
        displayName: "SeriousGoose",
        configs: [...SILLY_GOOSE_CONFIGS, ...RADIO_CONFIGS],
        configFields: SERIOUS_GOOSE_CONFIG_FIELDS,
        firmwareVariants: [{ value: "V1", label: "SeriousGoose V1" }],
        pyroChannels: ["drogue", "main", "aux"],
        armable: true,
        // Also matches an old already-deployed SeriousGooseGroundV1 unit (pre-GROUND_STATION_MODE
        // firmware) - it's the same board family/wire protocol, just running as a ground station,
        // which is now a runtime mode rather than separate firmware (see GROUND_STATION_MODE_c).
        usbNameMatch: /^seriousgoose/i
    }
};
const ALL_BOARD_FAMILIES = ALTIMETER_PROFILES;

// --- Binary offload protocol (mirrors firmware BasicLogger.h) ---
// Preamble: 'SGB', struct size (u16), CRC16 of the tab-joined field names (u16) - checked
// against the LOG_FORMAT line the board sent just before it.
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
function headerCrcFor(header) {
    return crc16(Array.from(header.join("\t"), c => c.charCodeAt(0)));
}
