const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`Barometer server listening on :${PORT} (build ${BUILD_ID})`);
});
