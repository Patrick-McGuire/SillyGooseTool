// --- Debug logger -----------------------------------------------------------
// A structured ring buffer (cap MAX_ENTRIES) of everything the app does -
// connects/disconnects, every command sent, every notable received line,
// warnings/errors. Independent of the on-screen terminal (#terminal, capped
// at 80 lines for a human-readable live view) - this is for a user hitting a
// bug to export and hand back for troubleshooting.
const DebugLog = (() => {
    const MAX_ENTRIES = 5000;
    const entries = [];

    function push(level, tag, msg) {
        entries.push({ t: Date.now(), level, tag, msg: String(msg) });
        if (entries.length > MAX_ENTRIES) entries.shift();
    }
    const info = (tag, msg) => push('INFO', tag, msg);
    const warn = (tag, msg) => push('WARN', tag, msg);
    const error = (tag, msg) => push('ERROR', tag, msg);
    const tx = (tag, msg) => push('TX', tag, msg);
    const rx = (tag, msg) => push('RX', tag, msg);

    function buildReport(extra) {
        const lines = [];
        lines.push(`SillyGoose Tool debug log - ${new Date().toISOString()}`);
        lines.push(`App version: ${window.SG_VERSION || 'unknown'}`);
        lines.push(`Build: ${window.sgFirmware ? 'desktop (Electron)' : 'browser'}`);
        lines.push(`User agent: ${navigator.userAgent}`);
        Object.entries(extra || {}).forEach(([k, v]) => lines.push(`${k}: ${v}`));
        lines.push('--- log (oldest first, ' + entries.length + ' entries) ---');
        entries.forEach(e => {
            const tag = e.tag ? `(${e.tag}) ` : '';
            lines.push(`[${new Date(e.t).toISOString()}] ${e.level.padEnd(5)} ${tag}${e.msg}`);
        });
        return lines.join('\n');
    }

    // extra: plain object of extra context lines to prepend (active device,
    // connection state, etc) - gathered by the caller since this module has no
    // knowledge of Connection/ConnectionManager.
    function download(extra) {
        const blob = new Blob([buildReport(extra)], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sillygoose-debug-${Date.now()}.log`;
        a.click();
    }

    return { info, warn, error, tx, rx, buildReport, download, entries };
})();
