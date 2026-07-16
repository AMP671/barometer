const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIRALTY_API_KEY = process.env.ADMIRALTY_API_KEY || '';
const ADMIRALTY_BASE = 'https://admiraltyapi.azure-api.net/uktidalapi/api/V1';

// Build/version id used by the frontend to force-reload after a deploy.
// Set BUILD_ID in docker-compose for a stable value across restarts of the
// same deploy; falls back to process start time so at minimum every
// container restart counts as a new version.
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

// --- Postgres -----------------------------------------------------------
// Local Postgres container, no SSL — only enable SSL for connection
// strings that explicitly need it (e.g. a SUPABASE_URL-style var), never
// as a generic fallback. This app only ever talks to the local container.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// An error on an idle pooled client is emitted on the pool itself — left
// unhandled it's an uncaught 'error' event, which takes the whole process
// down (e.g. when the Postgres container restarts underneath us).
pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

const DEFAULT_STATE = {
  locations: [],
  activeLocationId: null,
  windUnit: 'kn',
};

async function getState() {
  const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', ['app_state']);
  if (rows.length === 0) return DEFAULT_STATE;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return DEFAULT_STATE;
  }
}

async function setState(state) {
  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at)
     VALUES ('app_state', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(state)]
  );
}

// Default 100kb JSON body limit is far too small for a log entry with a
// compressed photo attached — the frontend downsizes images before
// sending, but still needs headroom beyond the default.
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // no-cache = revalidate before use, not "don't store". iOS Safari is
    // aggressive about heuristic caching for PWAs; the entry point and the
    // service worker must always be revalidated or deploys never arrive.
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// --- API ------------------------------------------------------------------

app.get('/api/version', (req, res) => {
  res.json({ version: BUILD_ID });
});

app.get('/api/state', async (req, res) => {
  try {
    const state = await getState();
    res.json(state);
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Could not load saved state' });
  }
});

app.put('/api/state', async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.locations)) {
    return res.status(400).json({ error: 'Malformed state payload' });
  }
  try {
    await setState(body);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/state failed', err);
    res.status(500).json({ error: 'Could not save state' });
  }
});

// Station list is metadata (names/coordinates), not tidal predictions, so
// it's fine to cache briefly server-side — it barely ever changes and this
// cuts down on repeated calls to the free tier's quota. Kept in memory only
// (not Postgres), and re-fetched if the process restarts.
let stationCache = null;
let stationCacheAt = 0;
const STATION_CACHE_MS = 24 * 60 * 60 * 1000;

app.get('/api/tide-stations', async (req, res) => {
  if (!ADMIRALTY_API_KEY) {
    return res.status(503).json({ error: 'ADMIRALTY_API_KEY not configured on the server' });
  }
  if (stationCache && Date.now() - stationCacheAt < STATION_CACHE_MS) {
    return res.json(stationCache);
  }
  try {
    const upstream = await fetch(`${ADMIRALTY_BASE}/Stations`, {
      headers: { 'Ocp-Apim-Subscription-Key': ADMIRALTY_API_KEY },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Admiralty station fetch failed' });
    const data = await upstream.json();
    stationCache = data;
    stationCacheAt = Date.now();
    res.json(data);
  } catch (err) {
    console.error('GET /api/tide-stations failed', err);
    res.status(502).json({ error: 'Station fetch failed' });
  }
});

// Tidal predictions themselves — the Discovery tier's terms prohibit
// caching this data, so every request goes straight to Admiralty, fresh.
app.get('/api/tide-events/:stationId', async (req, res) => {
  if (!ADMIRALTY_API_KEY) {
    return res.status(503).json({ error: 'ADMIRALTY_API_KEY not configured on the server' });
  }
  const { stationId } = req.params;
  try {
    const upstream = await fetch(`${ADMIRALTY_BASE}/Stations/${encodeURIComponent(stationId)}/TidalEvents`, {
      headers: { 'Ocp-Apim-Subscription-Key': ADMIRALTY_API_KEY },
    });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Admiralty tidal events fetch failed' });
    const data = await upstream.json();
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    console.error('GET /api/tide-events failed', err);
    res.status(502).json({ error: 'Tidal events fetch failed' });
  }
});

// Places search beyond cities/towns — beaches, coves, bays, headlands, etc.
// Open-Meteo's geocoder only covers populated places, not this level of
// detail. Proxied through here (rather than called directly from the
// browser) so we can set a proper identifying User-Agent, which
// Nominatim's usage policy requires and a browser fetch() can't set itself.
app.get('/api/geocode-places', async (req, res) => {
  const q = req.query.q;
  if (!q || typeof q !== 'string') return res.json([]);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=8&addressdetails=1`;
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'BarometerPWA/1.0 (personal-use weather app)' },
    });
    if (!upstream.ok) return res.status(upstream.status).json([]);
    const data = await upstream.json();
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('GET /api/geocode-places failed', err);
    res.status(502).json([]);
  }
});

// --- Seaward direction (auto coast orientation) ---------------------------
// OSM's natural=coastline ways follow a hard mapping convention: land is on
// the left of the way's direction, water on the right. So the compass
// direction pointing from the shore out to sea is the nearest coastline
// segment's bearing + 90°. Queried via Overpass, proxied here for the same
// reason as Nominatim (identifying User-Agent + shared-service etiquette),
// and cached in memory — coastlines don't move, so one lookup per place.
// Lakes/rivers aren't tagged natural=coastline, so inland locations cleanly
// return null: shore wind is simply not applicable there.
const seawardCache = new Map();
const SEAWARD_RADIUS_M = 3000;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function segBearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Distance in metres from point p to segment a–b, in a local planar
// approximation — fine at the few-km scale this is ever used at.
function pointSegDistM(p, a, b) {
  const kx = 111320 * Math.cos(toRad(p.lat));
  const ky = 110540;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

app.get('/api/seaward', async (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat and lon query params required' });
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (seawardCache.has(key)) return res.json(seawardCache.get(key));
  try {
    const q = `[out:json][timeout:15];way(around:${SEAWARD_RADIUS_M},${lat},${lon})[natural=coastline];out geom;`;
    const upstream = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'BarometerPWA/1.0 (personal-use weather app)',
      },
      body: 'data=' + encodeURIComponent(q),
    });
    // 429/504 from the shared instance are transient — report upstream
    // failure and DON'T cache it, so the app can retry later.
    if (!upstream.ok) return res.status(502).json({ error: `Overpass returned ${upstream.status}` });
    const data = await upstream.json();
    let best = null;
    for (const el of data.elements || []) {
      if (!el.geometry || el.geometry.length < 2) continue;
      for (let i = 0; i < el.geometry.length - 1; i++) {
        const a = el.geometry[i], b = el.geometry[i + 1];
        const d = pointSegDistM({ lat, lon }, a, b);
        if (!best || d < best.distM) best = { distM: d, bearing: segBearing(a, b) };
      }
    }
    const result = best
      ? { seaward: Math.round((best.bearing + 90) % 360), coastDistanceM: Math.round(best.distM) }
      : { seaward: null, coastDistanceM: null };
    if (seawardCache.size > 500) seawardCache.clear();
    seawardCache.set(key, result);
    res.json(result);
  } catch (err) {
    console.error('GET /api/seaward failed', err);
    res.status(502).json({ error: 'Seaward lookup failed' });
  }
});

// --- Saved routes -------------------------------------------------------
// Same one-row-per-item pattern as the voyage log.

app.get('/api/routes', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM kv_store WHERE key LIKE 'route:%'");
    const routes = rows
      .map((r) => { try { return JSON.parse(r.value); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    res.json(routes);
  } catch (err) {
    console.error('GET /api/routes failed', err);
    res.status(500).json({ error: 'Could not load routes' });
  }
});

app.post('/api/routes', async (req, res) => {
  const route = req.body;
  if (!route || !Array.isArray(route.waypoints)) {
    return res.status(400).json({ error: 'Malformed route' });
  }
  const id = route.id || `route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const toSave = { ...route, id, savedAt: route.savedAt || new Date().toISOString() };
  try {
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`route:${id}`, JSON.stringify(toSave)]
    );
    res.json(toSave);
  } catch (err) {
    console.error('POST /api/routes failed', err);
    res.status(500).json({ error: 'Could not save route' });
  }
});

app.delete('/api/routes/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [`route:${req.params.id}`]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/routes failed', err);
    res.status(500).json({ error: 'Could not delete route' });
  }
});

// --- Voyage log -------------------------------------------------------
// Each entry is its own kv_store row (key: log:<id>) rather than one
// array in a single row, so entries can be added/removed independently.

app.get('/api/log-entries', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM kv_store WHERE key LIKE 'log:%'");
    const entries = rows
      .map((r) => { try { return JSON.parse(r.value); } catch { return null; } })
      .filter(Boolean)
      // List payload: strip the full-size photos and send only a thumbnail
      // — with base64 photos inline, the old everything-response grew
      // without bound as the log filled up. The detail view fetches the
      // complete entry by id. Legacy entries without a stored thumb fall
      // back to their full photo, so nothing disappears.
      .map((e) => {
        const { photos, photo, ...light } = e;
        light.thumb = e.thumb || (Array.isArray(photos) && photos[0]) || photo || null;
        light.photoCount = Array.isArray(photos) ? photos.length : photo ? 1 : 0;
        return light;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(entries);
  } catch (err) {
    console.error('GET /api/log-entries failed', err);
    res.status(500).json({ error: 'Could not load log entries' });
  }
});

app.get('/api/log-entries/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [`log:${req.params.id}`]);
    if (rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    try {
      res.json(JSON.parse(rows[0].value));
    } catch {
      res.status(500).json({ error: 'Entry is corrupt' });
    }
  } catch (err) {
    console.error('GET /api/log-entries/:id failed', err);
    res.status(500).json({ error: 'Could not load log entry' });
  }
});

app.post('/api/log-entries', async (req, res) => {
  const entry = req.body;
  if (!entry || !entry.date) {
    return res.status(400).json({ error: 'Malformed log entry' });
  }
  const id = entry.id || `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const toSave = { ...entry, id };
  try {
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`log:${id}`, JSON.stringify(toSave)]
    );
    res.json(toSave);
  } catch (err) {
    console.error('POST /api/log-entries failed', err);
    res.status(500).json({ error: 'Could not save log entry' });
  }
});

app.delete('/api/log-entries/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [`log:${req.params.id}`]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/log-entries failed', err);
    res.status(500).json({ error: 'Could not delete log entry' });
  }
});

app.listen(PORT, () => {
  console.log(`Barometer server listening on :${PORT} (build ${BUILD_ID})`);
});
