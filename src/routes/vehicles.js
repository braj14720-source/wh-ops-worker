// routes/vehicles.js — logistics / trip logs (Hono router).
import { Hono } from 'hono';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete, requireSuperAdmin } from '../middleware/auth.js';

const vehicles = new Hono();
vehicles.use('*', authRequired());

const STATUSES = new Set(['pending', 'in_transit', 'completed']);

function row(payload) {
  let status = payload.status ? String(payload.status).toLowerCase() : 'pending';
  if (!STATUSES.has(status)) status = 'pending';
  return [
    String(payload.vehicle_no || '').trim(),
    payload.driver_name ? String(payload.driver_name).trim() : null,
    payload.from_location ? String(payload.from_location).trim() : null,
    payload.to_location ? String(payload.to_location).trim() : null,
    payload.purpose ? String(payload.purpose).trim() : null,
    status,
    payload.departed_at || null,
    payload.arrived_at || null,
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

vehicles.get('/', async (c) => {
  const items = await all('SELECT * FROM vehicles ORDER BY datetime(updated_at) DESC, id DESC');
  return c.json({ items });
});

vehicles.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r[0]) return c.json({ error: 'vehicle_no is required' }, 400);
  const info = await run(
    `INSERT INTO vehicles (vehicle_no, driver_name, from_location, to_location,
                           purpose, status, departed_at, arrived_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    r,
  );
  const item = await get('SELECT * FROM vehicles WHERE id = ?', [info.lastInsertRowid]);
  return c.json({ item }, 201);
});

vehicles.put('/:id', requireSuperAdmin(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM vehicles WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const r = row({ ...existing, ...body });
  await run(
    `UPDATE vehicles SET
       vehicle_no=?, driver_name=?,
       from_location=?, to_location=?,
       purpose=?, status=?,
       departed_at=?, arrived_at=?,
       notes=?, updated_at=datetime('now')
     WHERE id=?`,
    [...r, id],
  );
  const item = await get('SELECT * FROM vehicles WHERE id = ?', [id]);
  return c.json({ item });
});

vehicles.delete('/:id', requireDelete(), async (c) => {
  const info = await run('DELETE FROM vehicles WHERE id = ?', [Number(c.req.param('id'))]);
  if (!info.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default vehicles;