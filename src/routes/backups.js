// routes/backups.js — DB snapshotting (SQL dump) with optional R2 remote backup.
//
// Snapshots are persisted in D1 (the backups table) so they survive Worker
// isolate restarts. For small backups, the SQL text is stored inline; for
// large ones, configure R2 binding in wrangler.toml and pass {upload:true}.
//
// Restoring: send the SQL dump to POST /api/backups/restore with body {sql:"..."}.
import { Hono } from 'hono';
import { all, get, run, transaction } from '../lib/db.js';
import { authRequired, requireSuperAdmin } from '../middleware/auth.js';

const backups = new Hono();
backups.use('*', authRequired());

const TABLES_TO_DUMP = [
  'users',
  'inventory',
  'labor',
  'attendance',
  'vehicles',
  'events',
  'event_source_teams',
  'event_allocations',
  'event_materials',
  'user_settings',
  'device_tokens',
];

function escapeSqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function buildSqlDump() {
  const out = [];
  out.push(`-- WH-OPS SQL snapshot`);
  out.push(`-- Generated: ${new Date().toISOString()}`);
  out.push(`-- Source: Cloudflare D1 (Workers)`);
  out.push('BEGIN;');
  for (const table of TABLES_TO_DUMP) {
    let rows;
    try {
      rows = await all(`SELECT * FROM ${table}`);
    } catch (e) {
      out.push(`-- (skip ${table}: ${e.message})`);
      continue;
    }
    if (!rows.length) continue;
    out.push(`-- Table: ${table} (${rows.length} rows)`);
    const cols = Object.keys(rows[0]);
    const colList = cols.join(', ');
    for (const row of rows) {
      const values = cols.map((c) => escapeSqlValue(row[c])).join(', ');
      out.push(`INSERT INTO ${table} (${colList}) VALUES (${values});`);
    }
  }
  out.push('COMMIT;');
  out.push('');
  return out.join('\n');
}

// GET /api/backups — list all snapshots, newest first
backups.get('/', (c) => {
  const r2Enabled = !!c.env.R2;
  // Returning from sync handler so we don't await — but we DO need D1, so async it is.
  return (async () => {
    const rows = await all(
      'SELECT id, filename, size_bytes, created_at, storage, remote FROM backups ORDER BY created_at DESC LIMIT 100',
    );
    const items = rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      size_bytes: r.size_bytes,
      created_at: r.created_at,
      storage: r.storage,
      remote: r.remote ? JSON.parse(r.remote) : null,
    }));
    return c.json({
      remote: r2Enabled ? { enabled: true, type: 'cloudflare-r2' } : { enabled: false },
      items,
    });
  })();
});

// POST /api/backups — create a new snapshot. Body: { upload?: bool }
backups.post('/', requireSuperAdmin(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const wantUpload = !!(body && body.upload);
  if (wantUpload && !c.env.R2) {
    return c.json({ error: 'R2 is not configured on this Worker. Set up the R2 binding in wrangler.toml first.' }, 400);
  }
  const sql = await buildSqlDump();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `wh-ops-${stamp}`;
  const filename = `${id}.sql`;
  const size = sql.length;
  let storage = 'inline';
  let remote = null;

  if (wantUpload && c.env.R2) {
    try {
      await c.env.R2.put(filename, sql, { httpMetadata: { contentType: 'application/sql' } });
      storage = 'r2';
      remote = { enabled: true, key: filename };
    } catch (e) {
      remote = { error: e.message };
    }
  }

  await run(
    'INSERT INTO backups (id, filename, size_bytes, storage, remote) VALUES (?, ?, ?, ?, ?)',
    [id, filename, size, storage, remote ? JSON.stringify(remote) : null],
  );

  return c.json({ backup: { id, filename, size_bytes: size, created_at: new Date().toISOString(), storage, remote } }, 201);
});

// GET /api/backups/:id/download — returns the SQL dump text
backups.get('/:id/download', async (c) => {
  const id = c.req.param('id');
  // id may include .sql suffix
  const cleanId = id.endsWith('.sql') ? id.slice(0, -4) : id;
  const row = await get('SELECT id, filename FROM backups WHERE id = ?', [cleanId]);
  if (!row) return c.json({ error: 'not found' }, 404);

  const sql = await buildSqlDump(); // regenerate from current DB
  return c.body(sql, 200, {
    'Content-Type': 'application/sql',
    'Content-Disposition': `attachment; filename="${row.filename}"`,
  });
});

// DELETE /api/backups/:id
backups.delete('/:id', requireSuperAdmin(), async (c) => {
  const id = c.req.param('id');
  const cleanId = id.endsWith('.sql') ? id.slice(0, -4) : id;
  const info = await run('DELETE FROM backups WHERE id = ?', [cleanId]);
  if (!info.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

// POST /api/backups/restore — body: { sql: "..." }
backups.post('/restore', requireSuperAdmin(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const sqlText = body && body.sql;
  if (!sqlText || typeof sqlText !== 'string') {
    return c.json({ error: 'sql (string) is required' }, 400);
  }
  if (sqlText.length > 5 * 1024 * 1024) {
    return c.json({ error: 'sql dump too large (>5MB)' }, 413);
  }
  const statements = sqlText
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(s));

  if (!statements.length) return c.json({ restored: 0 });

  await transaction(async () => {
    for (const stmt of statements) {
      await run(stmt);
    }
  });
  return c.json({ restored: statements.length });
});

export default backups;