// routes/inventory.js — CRUD for materials (Hono router).
//
// Soft-merge support: rows with `merged_into` set are hidden from the default
// listing. Use ?include_merged=1 to see them, GET /duplicates to review groups,
// POST /merge to merge, POST /:id/unmerge to restore.
import { Hono } from 'hono';
import { all, get, run, transaction } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete, requireSuperAdmin } from '../middleware/auth.js';

const inventory = new Hono();
inventory.use('*', authRequired());

function row(payload) {
  return [
    String(payload.name || '').trim(),
    payload.category ? String(payload.category).trim() : null,
    payload.unit ? String(payload.unit).trim() : 'pcs',
    Number(payload.quantity ?? 0),
    Number(payload.unit_price ?? 0),
    payload.supplier ? String(payload.supplier).trim() : null,
    payload.barcode ? String(payload.barcode).trim() : null,
    payload.notes ? String(payload.notes).trim() : null,
    payload.photo_url ? String(payload.photo_url).trim() : null,
  ];
}

const COLS = '(name, category, unit, quantity, unit_price, supplier, barcode, notes, photo_url)';
const PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?)';

inventory.get('/', async (c) => {
  const includeMerged = c.req.query('include_merged') === '1';
  const sql = includeMerged
    ? 'SELECT * FROM inventory ORDER BY datetime(updated_at) DESC, id DESC'
    : 'SELECT * FROM inventory WHERE merged_into IS NULL ORDER BY datetime(updated_at) DESC, id DESC';
  const items = await all(sql);
  return c.json({ items });
});

inventory.get('/by-barcode/:code', async (c) => {
  const code = String(c.req.param('code') || '').trim();
  if (!code) return c.json({ error: 'barcode is required' }, 400);
  // Barcode lookup matches active rows only — merged rows are invisible.
  const item = await get(
    'SELECT * FROM inventory WHERE barcode = ? AND merged_into IS NULL ORDER BY id DESC LIMIT 1',
    [code],
  );
  if (!item) return c.json({ error: 'No item with that barcode' }, 404);
  return c.json({ item });
});

// List every duplicate name group with all member rows so the admin can
// review the auto-merge or undo specific pairs.
inventory.get('/duplicates', async (c) => {
  const rows = await all(`
    WITH groups AS (
      SELECT LOWER(TRIM(name)) AS norm, COUNT(*) AS n,
             MIN(id) AS keeper_id,
             SUM(CASE WHEN merged_into IS NULL THEN 1 ELSE 0 END) AS active_count
        FROM inventory
       WHERE TRIM(COALESCE(name, '')) <> ''
       GROUP BY LOWER(TRIM(name))
      HAVING n > 1
    )
    SELECT i.id, i.name, i.category, i.quantity, i.unit_price, i.barcode,
           i.photo_url, i.merged_into, i.created_at,
           LOWER(TRIM(i.name)) AS norm
      FROM inventory i
     WHERE LOWER(TRIM(i.name)) IN (SELECT norm FROM groups)
     ORDER BY i.name ASC, i.id ASC
  `);
  // Group by lowercased name for the UI.
  const groups = new Map();
  for (const r of rows) {
    const key = r.norm;
    if (!groups.has(key)) {
      groups.set(key, {
        name: r.name,
        norm: key,
        keeper_id: null, // filled below
        members: [],
      });
    }
    groups.get(key).members.push({
      id: r.id,
      name: r.name,
      category: r.category,
      quantity: r.quantity,
      unit_price: r.unit_price,
      barcode: r.barcode,
      has_photo: !!r.photo_url,
      merged_into: r.merged_into,
      created_at: r.created_at,
    });
  }
  // Pick a sensible keeper for each group: lowest id with the most data
  // (barcode + photo beats quantity beats id).
  const result = [];
  for (const g of groups.values()) {
    const ranked = [...g.members].sort((a, b) => {
      const score = (x) => (x.barcode ? 4 : 0) + (x.has_photo ? 2 : 0) + (x.quantity > 0 ? 1 : 0);
      return score(b) - score(a) || a.id - b.id;
    });
    g.keeper_id = ranked[0].id;
    g.members.sort((a, b) => a.id - b.id);
    result.push(g);
  }
  result.sort((a, b) => a.norm.localeCompare(b.norm));
  return c.json({ groups: result, total_groups: result.length });
});

inventory.post('/merge', requireSuperAdmin(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const keepId = Number(body.keep_id);
  const dropIds = Array.isArray(body.drop_ids) ? body.drop_ids.map(Number).filter(Boolean) : [];
  if (!keepId || !dropIds.length) {
    return c.json({ error: 'keep_id + non-empty drop_ids[] required' }, 400);
  }
  if (dropIds.includes(keepId)) {
    return c.json({ error: 'keep_id cannot also be in drop_ids' }, 400);
  }
  const keep = await get('SELECT * FROM inventory WHERE id = ? AND merged_into IS NULL', [keepId]);
  if (!keep) return c.json({ error: 'Keep row not found or already merged' }, 404);
  const drops = await all(
    `SELECT * FROM inventory WHERE id IN (${dropIds.map(() => '?').join(',')}) AND merged_into IS NULL`,
    dropIds,
  );
  if (drops.length !== dropIds.length) {
    return c.json({ error: 'One or more drop rows are missing or already merged' }, 400);
  }

  let addedQty = 0;
  await transaction(async () => {
    for (const d of drops) {
      addedQty += Number(d.quantity || 0);
      await run(
        'UPDATE inventory SET merged_into = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [keepId, d.id],
      );
    }
    if (addedQty > 0) {
      await run(
        'UPDATE inventory SET quantity = quantity + ?, updated_at = datetime(\'now\') WHERE id = ?',
        [addedQty, keepId],
      );
    }
  });

  const updated = await get('SELECT * FROM inventory WHERE id = ?', [keepId]);
  return c.json({
    ok: true,
    kept: updated,
    dropped_count: drops.length,
    quantity_added: addedQty,
  });
});

// Restore a single soft-merged row.
inventory.post('/:id/unmerge', requireSuperAdmin(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!existing.merged_into) return c.json({ error: 'Row is not merged' }, 400);
  await run(
    'UPDATE inventory SET merged_into = NULL, updated_at = datetime(\'now\') WHERE id = ?',
    [id],
  );
  const item = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  return c.json({ item });
});

// Restore every row that points at this keeper.
inventory.post('/:id/unmerge-all', requireSuperAdmin(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  await run(
    'UPDATE inventory SET merged_into = NULL, updated_at = datetime(\'now\') WHERE merged_into = ?',
    [id],
  );
  return c.json({ ok: true });
});

inventory.post('/', requireSuperAdmin(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r[0]) return c.json({ error: 'name is required' }, 400);
  if (r[6]) {
    const dup = await get(
      'SELECT id FROM inventory WHERE barcode = ? AND merged_into IS NULL',
      [r[6]],
    );
    if (dup) return c.json({ error: 'Barcode already in use' }, 409);
  }
  const info = await run(
    `INSERT INTO inventory ${COLS} VALUES ${PLACEHOLDERS}`,
    r,
  );
  const item = await get('SELECT * FROM inventory WHERE id = ?', [info.lastInsertRowid]);
  return c.json({ item }, 201);
});

inventory.put('/:id', requireSuperAdmin(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.merged_into) {
    return c.json({ error: 'This item has been merged into another row. Unmerge it first.' }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const r = row({ ...existing, ...body });
  if (r[6] && r[6] !== existing.barcode) {
    const dup = await get(
      'SELECT id FROM inventory WHERE barcode = ? AND merged_into IS NULL AND id != ?',
      [r[6], id],
    );
    if (dup) return c.json({ error: 'Barcode already in use' }, 409);
  }
  await run(
    `UPDATE inventory SET
       name=?, category=?, unit=?,
       quantity=?, unit_price=?,
       supplier=?, barcode=?, notes=?,
       photo_url=?,
       updated_at = datetime('now')
     WHERE id=?`,
    [...r, id],
  );
  const item = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  return c.json({ item });
});

inventory.delete('/:id', requireDelete(), async (c) => {
  const info = await run('DELETE FROM inventory WHERE id = ?', [Number(c.req.param('id'))]);
  if (!info.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default inventory;