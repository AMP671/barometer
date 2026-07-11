CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed one default location (Greenwich) so the app has something to show
-- before you add your own via the location picker.
INSERT INTO kv_store (key, value)
VALUES (
  'app_state',
  '{"locations":[{"id":"default","label":"Greenwich, UK","lat":51.4769,"lon":-0.0005,"timezone":"auto"}],"activeLocationId":"default","windUnit":"kn"}'
)
ON CONFLICT (key) DO NOTHING;
