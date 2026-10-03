-- D1 schema for PW-WH-OPS. SQLite-compatible.
-- Applied via `wrangler d1 execute wh-ops --file=schema.sql --remote`.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('super_admin','admin','employee','in_house_labour')) DEFAULT 'employee',
  designation   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  category     TEXT,
  unit         TEXT,
  quantity     REAL DEFAULT 0,
  unit_price   REAL DEFAULT 0,
  supplier     TEXT,
  barcode      TEXT,
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id           INTEGER PRIMARY KEY,
  attendance_remind INTEGER NOT NULL DEFAULT 1,
  remind_time       TEXT    NOT NULL DEFAULT '09:00',
  low_stock_alerts  INTEGER NOT NULL DEFAULT 1,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  push_token        TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  token         TEXT    UNIQUE NOT NULL,
  platform      TEXT,
  last_seen_at  TEXT DEFAULT (datetime('now')),
  created_at    TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labor (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  role         TEXT,
  phone        TEXT,
  daily_wage   REAL DEFAULT 0,
  active       INTEGER DEFAULT 1,
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  labor_id     INTEGER NOT NULL,
  date         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('present','absent','half_day')) DEFAULT 'present',
  overtime_hours REAL DEFAULT 0,
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(labor_id, date),
  FOREIGN KEY (labor_id) REFERENCES labor(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vehicles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_no   TEXT NOT NULL,
  driver_name  TEXT,
  from_location TEXT,
  to_location  TEXT,
  purpose      TEXT,
  status       TEXT DEFAULT 'pending',
  departed_at  TEXT,
  arrived_at   TEXT,
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  date              TEXT,
  location          TEXT,
  client_name       TEXT,
  customer_phone    TEXT,
  project_manager   TEXT,
  project_executive TEXT,
  consultant        TEXT,
  status            TEXT DEFAULT 'planning',
  total_workers     INTEGER DEFAULT 0,
  num_source_teams  INTEGER DEFAULT 0,
  num_pm_teams      INTEGER DEFAULT 0,
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_materials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL,
  inventory_id    INTEGER NOT NULL,
  quantity        REAL    NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL DEFAULT 'planning_pending',
  notes           TEXT,
  created_at      TEXT    DEFAULT (datetime('now')),
  updated_at      TEXT    DEFAULT (datetime('now')),
  UNIQUE(event_id, inventory_id),
  FOREIGN KEY (event_id)     REFERENCES events(id)     ON DELETE CASCADE,
  FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS event_source_teams (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL,
  name             TEXT NOT NULL,
  worker_count     INTEGER NOT NULL DEFAULT 0,
  supervisor_count INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL,
  labor_id       INTEGER NOT NULL,
  source_team_id INTEGER,
  pm_team        INTEGER,
  role           TEXT DEFAULT 'worker',
  notes          TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(event_id, labor_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (labor_id) REFERENCES labor(id) ON DELETE CASCADE,
  FOREIGN KEY (source_team_id) REFERENCES event_source_teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id          TEXT    PRIMARY KEY,
  filename    TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  remote      TEXT,                 -- JSON string with R2 upload info or error
  storage     TEXT    NOT NULL DEFAULT 'inline'  -- 'inline' (in DB) | 'r2' (R2 object)
);

CREATE INDEX IF NOT EXISTS idx_event_alloc_event ON event_allocations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_alloc_pm    ON event_allocations(event_id, pm_team);
CREATE INDEX IF NOT EXISTS idx_event_src_team    ON event_source_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode);
CREATE INDEX IF NOT EXISTS idx_event_materials_event ON event_materials(event_id);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at);