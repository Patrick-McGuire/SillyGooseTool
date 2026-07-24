// --- Telemetry store ---------------------------------------------------------
// A flat, named key -> latest-value dictionary, decoupled from which
// connection/profile/column-index produced the value - the same idea as
// AerospaceNU/pyqt_groundstation's global telemetry dictionary. Widgets that
// only ever need the *current* value (battery voltage, GPS fix, attitude,
// pyro continuity) subscribe here instead of reaching into a raw decoded row
// with a profile-specific column index.
//
// Plots that need full history (the Live Stream / Offload graphs) still read
// from the connection's liveDataBuffer / a flight's raw rows directly - this
// store is deliberately "latest value only", not a time series.
//
// Not yet namespaced per-device - only one connection is ever active today
// (see ConnectionManager). When multi-device support lands, keys should
// become `${connectionId}.${field}` and each device's widgets should
// subscribe against its own prefix; every call site below already goes
// through set()/subscribe() rather than touching a bare object, so that's a
// mechanical follow-up, not a rewrite.
const Telemetry = (() => {
    const values = new Map();
    const subs = new Map(); // key -> Set(fn)

    function set(key, value) {
        values.set(key, value);
        const fns = subs.get(key);
        if (fns) fns.forEach(fn => { try { fn(value, key); } catch (e) { DebugLog.error('telemetry', `subscriber for "${key}" threw: ${e.message}`); } });
    }
    function setAll(obj) { Object.entries(obj).forEach(([k, v]) => set(k, v)); }
    function get(key) { return values.get(key); }
    function subscribe(key, fn) {
        if (!subs.has(key)) subs.set(key, new Set());
        subs.get(key).add(fn);
        return () => { const s = subs.get(key); if (s) s.delete(fn); };
    }
    function clear() { values.clear(); }

    return { set, setAll, get, subscribe, clear };
})();
