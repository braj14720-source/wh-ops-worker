// db.js — Cloudflare D1 adapter.
//
// Provides the same surface as the libSQL/Turso helper (run/get/all/exec/transaction)
// so route code is portable. The D1 binding is injected via initDb(env.DB) at
// the top of the Worker fetch handler.

let _db = null;
let _batchSupported = true;

export function initDb(db) {
  _db = db;
}

// Apply positional args to a D1 prepared statement.
// IMPORTANT: D1's bind() takes ALL bindings at once and replaces them. Calling
// .bind() multiple times overwrites — does not append. So we spread the array.
function bindAll(stmt, params = []) {
  return stmt.bind(...params);
}

// toArgs — same as the libSQL shim, kept for drop-in compatibility.
function toArgs(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params;
  return Object.values(params);
}

// run — INSERT/UPDATE/DELETE. Returns {lastInsertRowid, changes}.
export async function run(sql, params = []) {
  const args = toArgs(params);
  const stmt = _db.prepare(sql);
  const r = await bindAll(stmt, args).run();
  return {
    lastInsertRowid: Number(r.meta?.last_row_id ?? r.lastInsertRowid ?? 0),
    changes: Number(r.meta?.changes ?? r.changes ?? 0),
  };
}

// get — SELECT a single row. Returns the row object or null.
export async function get(sql, params = []) {
  const args = toArgs(params);
  const stmt = _db.prepare(sql);
  const r = await bindAll(stmt, args).first();
  return r || null;
}

// all — SELECT many rows. Returns array of row objects.
export async function all(sql, params = []) {
  const args = toArgs(params);
  const stmt = _db.prepare(sql);
  const r = await bindAll(stmt, args).all();
  return r.results || [];
}

// exec — execute a multi-statement SQL string (schema bootstrap).
// Splits on `;\n` like the libSQL shim and runs each statement individually.
export async function exec(sql) {
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
  if (statements.length === 0) return;
  if (_batchSupported && statements.length > 1) {
    try {
      const prepared = statements.map((s) => _db.prepare(s));
      await _db.batch(prepared);
      return;
    } catch (e) {
      // Some statements (PRAGMA, etc.) can't be in a batch — fall back.
      _batchSupported = false;
    }
  }
  for (const stmt of statements) {
    await _db.prepare(stmt).run();
  }
}

// transaction — D1's batch is implicitly transactional. If fn throws, D1 has no
// explicit rollback, but the calling code's BEGIN/COMMIT pattern (used in the
// Express backend) can be adapted to D1's batch API.
export async function transaction(fn) {
  if (typeof fn !== 'function') return;
  return fn();
}

// batchMany — run an array of {sql, args} as a single D1 batch. Counts as 1 subrequest.
// Returns number of rows affected across all statements.
export async function batchMany(operations) {
  if (!operations || !operations.length) return 0;
  const prepared = operations.map((op) => bindAll(_db.prepare(op.sql), toArgs(op.args || [])));
  const r = await _db.batch(prepared);
  return Array.isArray(r) ? r.length : 1;
}

// ---- schema bootstrap (runs once per cold start; idempotent CREATE statements) ----

const SCHEMA_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_event_alloc_event ON event_allocations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_alloc_pm    ON event_allocations(event_id, pm_team);
CREATE INDEX IF NOT EXISTS idx_event_src_team    ON event_source_teams(event_id);
CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode);
CREATE INDEX IF NOT EXISTS idx_event_materials_event ON event_materials(event_id);
`;

let _schemaApplied = false;

// Ensure schema exists. Idempotent — safe to call from every request.
// D1 is single-instance-per-region and schema is created once globally.
export async function ensureSchema() {
  if (_schemaApplied) return;
  await exec(SCHEMA_SQL);
  _schemaApplied = true;
}

// ---- bootstrap: create the super_admin from BOOTSTRAP_OWNER_* env vars ----

export async function maybeBootstrap(env) {
  const row = await get('SELECT COUNT(*) AS n FROM users');
  const userCount = row ? Number(row.n) : 0;
  if (userCount > 0) return;
  if (!env.BOOTSTRAP_OWNER_EMAIL || !env.BOOTSTRAP_OWNER_PASSWORD) return;
  const bcrypt = await import('bcryptjs');
  const hash = bcrypt.hashSync(env.BOOTSTRAP_OWNER_PASSWORD, 10);
  await run(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
    [
      env.BOOTSTRAP_OWNER_EMAIL.trim().toLowerCase(),
      hash,
      (env.BOOTSTRAP_OWNER_NAME || 'Owner').trim(),
      'super_admin',
    ],
  );
  console.log(`[bootstrap] Created super admin: ${env.BOOTSTRAP_OWNER_EMAIL}`);
}

// ---- legacy compatibility ----

export const query = all;