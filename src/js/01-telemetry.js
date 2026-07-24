// --- Telemetry store ---------------------------------------------------------
// Flat key -> latest-value dictionary, decoupled from which connection/
// profile/column produced it - widgets (battery, GPS, attitude, pyro
// continuity) subscribe by name instead of reading a raw row by column index.
// "Latest value only", not a time series - full-history plots (Live Stream /
// Offload) read the connection's liveDataBuffer / a flight's raw rows instead.
//
// Not namespaced per-device yet (only one connection is ever active - see
// ConnectionManager). When multi-device support lands, keys become
// `${connectionId}.${field}`; every call site already goes through
// set()/subscribe() rather than a bare object, so that's mechanical, not a rewrite.
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
