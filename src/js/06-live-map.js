// ===================== Live Map tab =====================
// Offline-capable map + a unified telemetry panel, fed by the same
// conn.liveDataBuffer as the Live Stream tab (via handleLiveLine). Only a
// direct flight-computer connection feeds it today; a ground station's
// forwarded GPS/radio lines are a natural second source later, since widgets
// below read the Telemetry store by key rather than a raw row/profile - a
// second source just needs to publish the same keys.
//
// TILE SOURCES: Esri ArcGIS World_Street_Map/World_Imagery - free, no API key,
// for this hobby volume. Switched from the raw OpenStreetMap tile server
// after hitting 403s there (OSM's usage policy blocks exactly this kind of
// bulk/scripted access, which offline pre-caching is); re-check Esri's terms
// before an actual launch - heavy use may want a developer key or a self-
// hosted source instead. `{s}`/`subdomains` is Leaflet's domain-sharding,
// working around the ~6-connections-per-origin cap on this endpoint's plain
// HTTP/1.1 (confirmed via curl) - the real ceiling on SAVE_CONCURRENCY below,
// not the browser or this code. `services.arcgisonline.com` mirrors
// `server.arcgisonline.com` on both layers (confirmed directly) but isn't a
// documented Esri sharding domain, so if that ever changes, tiles routed
// there just fail (saveCurrentMapViewOffline retries once, then skips them).
// Attribution is shortened to "© Esri" from Esri's full per-contributor
// `copyrightText`; Leaflet's own credit is dropped entirely (its BSD-2-Clause
// license doesn't require on-map credit, unlike Esri's terms).
const TILE_LAYERS = {
    street: {
        label: 'Street',
        url: 'https://{s}.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
        subdomains: ['server', 'services'],
        attribution: '&copy; Esri'
    },
    satellite: {
        label: 'Satellite',
        url: 'https://{s}.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        subdomains: ['server', 'services'],
        attribution: '&copy; Esri'
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
function tileDbGetAllKeys(db) {
    return new Promise((resolve, reject) => {
        const req = db.transaction(TILE_STORE, 'readonly').objectStore(TILE_STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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
    liveMap.attributionControl.setPrefix(false); // drop the "Leaflet" credit - not required by its license

    liveMapTileLayers = {};
    Object.entries(TILE_LAYERS).forEach(([key, cfg]) => {
        liveMapTileLayers[key] = new OfflineTileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution, subdomains: cfg.subdomains });
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

    // Render the QR code, elevation graph, and navball immediately with their
    // static defaults, rather than waiting for the first telemetry line.
    updateGpsQrCode(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]);
    updateElevationSparkline();
    initNavball3D();
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
    dismissOnOutsideClick(menu);
}

// Saves a zoom range around the current view (not just the exact level on
// screen) so zooming in further offline still shows cached tiles instead of
// blanks. Capped relative to the CURRENT zoom rather than the layer's
// absolute max (19): tile count roughly quadruples per level, so saving from
// a zoomed-out view (e.g. a whole city) used to silently try to fetch the
// entire area at street-level zoom-19. This bounds the worst case regardless
// of starting zoom, while still reaching the true max for the "zoom to the
// launch site, then save" case this is for.
const SAVE_ZOOM_OUT = 1;
const SAVE_ZOOM_IN = 3;
// Sequential fetching (one round trip at a time) is what made this take
// "forever"; a bounded worker pool cuts wall-clock time roughly by this
// factor without firing every request at once. Esri's CDN comfortably
// handles well beyond the 40 this started at, so it's pushed higher - the
// real bottleneck at this concurrency is bandwidth × tile count (surfaced by
// the confirm() dialog below), not the browser or this code.
const SAVE_CONCURRENCY = 64;
// One retry for a tile that fails (transient network blip / a momentary CDN
// hiccup) rather than permanently skipping it - cheap since it only fires on
// failure, and meaningfully improves how "complete" a save ends up being.
async function fetchTileWithRetry(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(url);
            if (res.ok) return res;
        } catch (e) { /* fall through to retry / give up */ }
    }
    return null;
}

async function saveCurrentMapViewOffline() {
    if (!liveMap) return;
    const statusEl = document.getElementById('map-save-status');
    const layer = liveMapTileLayers[liveMapActiveTileKey];
    const tileSize = layer.getTileSize().x;
    const bounds = liveMap.getBounds();
    const currentZoom = Math.round(liveMap.getZoom());
    const minZoom = Math.max(0, currentZoom - SAVE_ZOOM_OUT);
    const maxZoom = Math.min(layer.options.maxZoom || 19, currentZoom + SAVE_ZOOM_IN);

    let db;
    try {
        db = await getTileDb();
    } catch (e) {
        // IndexedDB can legitimately be unavailable (private-browsing modes,
        // storage quota/permission issues) - fail with a clear message rather
        // than an unhandled rejection.
        if (statusEl) statusEl.textContent = "Couldn't open the offline tile cache (IndexedDB unavailable).";
        DebugLog.error('live-map', 'getTileDb failed: ' + e.message);
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

    // One bulk read of every cached key up front (a single transaction)
    // instead of a `get()` per tile - with 64 concurrent workers each
    // checking individually, that was 64 IndexedDB transactions competing for
    // the same answer. Existence is now a plain in-memory Set lookup;
    // IndexedDB is only touched for tiles that actually need writing.
    let existingKeys;
    try {
        existingKeys = new Set(await tileDbGetAllKeys(db));
    } catch (e) {
        existingKeys = new Set(); // best-effort - treat everything as not-yet-cached
    }

    let done = 0;
    const label = () => `Saving ${done}/${total} tiles (zoom ${minZoom}-${maxZoom})…`;
    if (statusEl) statusEl.textContent = label();

    let nextIndex = 0;
    async function worker() {
        while (nextIndex < tiles.length) {
            const { x, y, z } = tiles[nextIndex++];
            const url = layer.getTileUrl({ x, y, z });
            if (!existingKeys.has(url)) {
                try {
                    const res = await fetchTileWithRetry(url);
                    if (res) await tileDbPut(db, url, await res.blob());
                } catch (e) { /* best-effort - skip tiles that fail */ }
            }
            done++;
            if (statusEl) statusEl.textContent = label();
        }
    }
    await Promise.all(Array.from({ length: Math.min(SAVE_CONCURRENCY, tiles.length) }, worker));

    if (statusEl) statusEl.textContent = `Saved ${total} tiles (zoom ${minZoom}-${maxZoom}) for offline use.`;
    DebugLog.info('live-map', `saved ${total} tiles zoom ${minZoom}-${maxZoom}`);
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

// Navball: a real textured 3D sphere rendered with three.js/WebGL, not a flat
// panned image - a 2D CSS pan can only approximate a rotating sphere (no
// perspective foreshortening near the poles, roll doesn't tilt anything in
// 3D). Replicates AerospaceNU/pyqt_groundstation's actual technique (a
// textured OpenGL sphere, navball_display_widget.py) instead of approximating it.
let navballScene = null, navballCamera = null, navballRenderer = null, navballSphere = null;

function initNavball3D() {
    if (navballScene || typeof THREE === 'undefined') return;
    const canvas = document.getElementById('navball-canvas');
    if (!canvas) return;

    // A real WebGL context isn't available everywhere this app runs headless
    // (test harnesses, jsdom) - THREE.WebGLRenderer throws rather than
    // degrading gracefully, so guard the whole setup instead of taking down
    // the rest of the Live Map tab over a gauge.
    try {
        navballScene = new THREE.Scene();
        // Matches the reference's gluPerspective(40, 1, 1, 40) + gluLookAt(0,0,3, ...):
        // fixed camera, the sphere rotates under it - exactly how a real navball reads
        // (the reticle overlay is the vehicle's fixed reference, the ball moves under it).
        navballCamera = new THREE.PerspectiveCamera(40, 1, 1, 40);
        navballCamera.position.set(0, 0, 3);
        navballCamera.lookAt(0, 0, 0);

        navballRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        const size = canvas.clientWidth || 150;
        navballRenderer.setSize(size, size, false);

        navballScene.add(new THREE.AmbientLight(0xffffff, 1.0)); // flat/unlit look - this is a gauge, not a lit scene

        const texture = new THREE.TextureLoader().load('{{NAVBALL_DATA_URI}}', () => navballRenderer.render(navballScene, navballCamera));
        texture.wrapS = THREE.RepeatWrapping; // heading wraps 360deg around the sphere
        texture.minFilter = THREE.LinearFilter;

        const geometry = new THREE.SphereGeometry(1, 48, 48);
        const material = new THREE.MeshBasicMaterial({ map: texture });
        navballSphere = new THREE.Mesh(geometry, material);
        navballScene.add(navballSphere);

        navballRenderer.render(navballScene, navballCamera);
    } catch (e) {
        DebugLog.warn('live-map', 'navball WebGL init failed: ' + e.message);
        navballScene = null; navballCamera = null; navballRenderer = null; navballSphere = null;
    }
}

// Sign/axis conventions were tuned empirically against real screenshots, not
// derived - the reference project's own constants aren't documented either,
// and three.js's sphere uses a different pole axis than GLU's anyway, so they
// wouldn't carry over verbatim. What's verified as "correct": at rest sky is
// up/ground is down; positive pitch (nose up) drops the horizon; positive
// roll tilts it; yaw pans heading.
function updateNavball(roll, pitch, yaw) {
    initNavball3D();
    if (!navballSphere) return;
    const d2r = Math.PI / 180;
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw * d2r);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch * d2r);
    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * d2r);
    navballSphere.quaternion.copy(qRoll).multiply(qPitch).multiply(qYaw);
    navballRenderer.render(navballScene, navballCamera);
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

// Rebuilds the Live Map's pyro badges, one per channel in the active
// profile's `pyros` list (see ALTIMETER_PROFILES[...].pyros).
function rebuildPyroWidgets(conn) {
    const container = document.getElementById('telemetry-pyros');
    if (!container) return;
    container.innerHTML = conn.profile.pyros.map(p =>
        `<div class="pyro-item"><span>${p.label}</span><span id="pyro-${p.id}" class="pyro-badge">-</span></div>`
    ).join('');
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

// Publishes the latest live row into the Telemetry store as named fields,
// decoupled from the connection's profile/column layout - see 01-telemetry.js.
// Everything downstream (navball, compass, pyro badges, battery/GPS readouts)
// subscribes to these keys rather than reading `row[cols.x]` directly.
function publishTelemetryFromRow(conn, row) {
    const cols = conn.profile.cols;

    const battV = parseFloat(row[cols.battV]);
    Telemetry.set('battV', isNaN(battV) ? null : battV);

    const quat = { w: parseFloat(row[cols.quatA]), x: parseFloat(row[cols.quatB]), y: parseFloat(row[cols.quatC]), z: parseFloat(row[cols.quatD]) };
    if (![quat.w, quat.x, quat.y, quat.z].some(isNaN)) {
        Telemetry.set('attitude', quatToEuler(quat.w, quat.x, quat.y, quat.z));
    }

    // One entry per pyro channel in the active profile (see ALTIMETER_PROFILES[...].pyros).
    Telemetry.set('pyros', conn.profile.pyros.map(p => ({
        id: p.id, label: p.label,
        continuity: row[p.contCol] === "1", fired: row[p.firedCol] === "1"
    })));
    Telemetry.set('flightState', parseInt(row[cols.flightState]));

    if (conn.profile.hasGps && cols.gpsLat !== undefined) {
        Telemetry.set('gps', {
            hasGps: true,
            lat: parseFloat(row[cols.gpsLat]), lon: parseFloat(row[cols.gpsLon]),
            fixQuality: parseInt(row[cols.gpsFixQuality]), sats: parseInt(row[cols.gpsSatellites])
        });
    } else {
        Telemetry.set('gps', { hasGps: false });
    }
}

// Wires the Telemetry keys published above to the actual DOM widgets. Called
// once at startup - see initUI() in 09-main.js.
function initTelemetryWidgets() {
    Telemetry.subscribe('battV', v => {
        const el = document.getElementById('widget-battery-val');
        if (el) el.textContent = (v == null || isNaN(v)) ? '-' : `${v.toFixed(2)}V`;
    });
    Telemetry.subscribe('attitude', ({ roll, pitch, yaw }) => {
        updateNavball(roll, pitch, yaw);
        updateCompass(yaw);
    });
    Telemetry.subscribe('pyros', list => list.forEach(p => setPyroBadge(`pyro-${p.id}`, p.continuity, p.fired)));
    Telemetry.subscribe('flightState', v => {
        const el = document.getElementById('widget-flightstate-val');
        if (el) el.textContent = FLIGHT_STATE_NAMES[v] || '-';
    });
    Telemetry.subscribe('gps', g => {
        const gpsEl = document.getElementById('widget-gps-val');
        if (!g.hasGps) { if (gpsEl) gpsEl.textContent = 'No GPS on this board'; return; }
        if (gpsEl) gpsEl.textContent = isNaN(g.fixQuality) ? '-' : `fix ${g.fixQuality} · ${g.sats} sats`;
        // Leave the map/QR showing whatever they last showed (the static default,
        // or a previous real fix) until an actual non-zero fix comes in.
        if (!isNaN(g.lat) && !isNaN(g.lon) && (g.lat !== 0 || g.lon !== 0)) updateLiveMapPosition(g.lat, g.lon);
    });
}

// Renders unconditionally, even with an empty buffer - the graph is part of
// the tab's static layout (see DEFAULT_MAP_CENTER above), not something that
// only appears once data starts flowing.
function updateElevationSparkline(conn) {
    if (typeof Plotly === 'undefined') return;
    conn = conn || ConnectionManager.getActive();
    const cols = conn.profile.cols;
    const buf = conn.liveDataBuffer;
    const t0 = buf.length ? parseFloat(buf[0][cols.timestampMs]) : 0;
    const t = buf.map(r => (parseFloat(r[cols.timestampMs]) - t0) / 1000);
    const alt = buf.map(r => parseFloat(r[cols.altitudeM]));
    Plotly.react('elevation-sparkline', [{ x: t, y: alt, mode: 'lines', line: { color: '#38bdf8', width: 1.5 }, hoverinfo: 'none' }], {
        paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 4, r: 4, l: 30, b: 20 }, font: { color: '#94a3b8', size: 9 },
        xaxis: { gridcolor: '#334155', showticklabels: false }, yaxis: { gridcolor: '#334155' },
        showlegend: false
    }, { responsive: true, displaylogo: false, staticPlot: true });
}

// Same 10Hz cap as the Live Graph tab's plot (see throttleByTime/
// LIVE_REDRAW_MIN_INTERVAL_MS in 05-live-stream.js) - the elevation sparkline
// is a Plotly.react call too, no need to pay that cost on every incoming row.
const throttledElevationSparkline = throttleByTime(updateElevationSparkline, LIVE_REDRAW_MIN_INTERVAL_MS);

// Called from handleLiveLine() alongside the existing Live Stream tab update.
// Map rendering is comparatively expensive, so it only runs while the Live Map
// tab is actually visible.
function updateLiveMapIfActive(conn) {
    const tabEl = document.getElementById('live-map-tab');
    if (!tabEl || !tabEl.classList.contains('active') || document.hidden) return;
    if (conn.liveDataBuffer.length === 0) return;
    initLiveMap();
    // Leaflet sizes itself from the DOM at creation time; the tab may have been
    // hidden (display:none) then, so nudge it once the container has real size.
    if (liveMap) liveMap.invalidateSize();
    publishTelemetryFromRow(conn, conn.liveDataBuffer[conn.liveDataBuffer.length - 1]);
    throttledElevationSparkline(conn);
}
