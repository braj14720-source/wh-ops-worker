// routes/inventory.js — CRUD for materials (Hono router).
import { Hono } from 'hono';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete } from '../middleware/auth.js';

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
  const items = await all('SELECT * FROM inventory ORDER BY datetime(updated_at) DESC, id DESC');
  return c.json({ items });
});

inventory.get('/by-barcode/:code', async (c) => {
  const code = String(c.req.param('code') || '').trim();
  if (!code) return c.json({ error: 'barcode is required' }, 400);
  const item = await get(
    'SELECT * FROM inventory WHERE barcode = ? ORDER BY id DESC LIMIT 1',
    [code],
  );
  if (!item) return c.json({ error: 'No item with that barcode' }, 404);
  return c.json({ item });
});

inventory.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r[0]) return c.json({ error: 'name is required' }, 400);
  if (r[6]) {
    const dup = await get('SELECT id FROM inventory WHERE barcode = ?', [r[6]]);
    if (dup) return c.json({ error: 'Barcode already in use' }, 409);
  }
  const info = await run(
    `INSERT INTO inventory ${COLS} VALUES ${PLACEHOLDERS}`,
    r,
  );
  const item = await get('SELECT * FROM inventory WHERE id = ?', [info.lastInsertRowid]);
  return c.json({ item }, 201);
});

inventory.put('/:id', requireWrite(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM inventory WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const r = row({ ...existing, ...body });
  if (r[6] && r[6] !== existing.barcode) {
    const dup = await get('SELECT id FROM inventory WHERE barcode = ? AND id != ?', [r[6], id]);
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