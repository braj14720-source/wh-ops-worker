// routes/labor.js — worker profiles + standard daily wages (Hono router).
import { Hono } from 'hono';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete } from '../middleware/auth.js';

const labor = new Hono();
labor.use('*', authRequired());

function row(payload) {
  return [
    String(payload.name || '').trim(),
    payload.role ? String(payload.role).trim() : null,
    payload.phone ? String(payload.phone).trim() : null,
    Number(payload.daily_wage ?? 0),
    payload.active === undefined ? 1 : (payload.active ? 1 : 0),
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

labor.get('/', async (c) => {
  const items = await all('SELECT * FROM labor ORDER BY active DESC, name ASC');
  return c.json({ items });
});

labor.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r[0]) return c.json({ error: 'name is required' }, 400);
  const info = await run(
    `INSERT INTO labor (name, role, phone, daily_wage, active, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    r,
  );
  const item = await get('SELECT * FROM labor WHERE id = ?', [info.lastInsertRowid]);
  return c.json({ item }, 201);
});

labor.put('/:id', requireWrite(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM labor WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const r = row({ ...existing, ...body });
  await run(
    `UPDATE labor SET
       name=?, role=?, phone=?, daily_wage=?,
       active=?, notes=?, updated_at=datetime('now')
     WHERE id=?`,
    [...r, id],
  );
  const item = await get('SELECT * FROM labor WHERE id = ?', [id]);
  return c.json({ item });
});

labor.delete('/:id', requireDelete(), async (c) => {
  const info = await run('DELETE FROM labor WHERE id = ?', [Number(c.req.param('id'))]);
  if (!info.changes) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default labor;