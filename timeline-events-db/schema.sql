CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  external_id TEXT,
  external_source TEXT,

  event_date TEXT,
  event_type TEXT,
  event_name_line_1 TEXT,
  event_name_line_2 TEXT,
  event_description TEXT,

  posted_by_name TEXT,
  posted_by_photo TEXT,

  date_added TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1,
  approved INTEGER DEFAULT 0,

  origin TEXT CHECK (origin IN ('facebook', 'webflow')) NOT NULL,
  sync INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_origin_sync
  ON events (origin, sync);

CREATE INDEX IF NOT EXISTS idx_events_external
  ON events (external_source, external_id);

CREATE TABLE IF NOT EXISTS event_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  event_id INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  public_url TEXT,
  original_source_url TEXT,
  position INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_photos_event
  ON event_photos (event_id, position);
