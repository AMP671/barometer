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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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

app.listen(PORT, () => {
  console.log(`Barometer server listening on :${PORT} (build ${BUILD_ID})`);
});
