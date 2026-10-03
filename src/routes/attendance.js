// routes/attendance.js — daily attendance + auto-calculated salary (Hono router).
import { Hono } from 'hono';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireWrite } from '../middleware/auth.js';

const attendance = new Hono();
attendance.use('*', authRequired());

const VALID = new Set(['present', 'absent', 'half_day']);

function row(payload) {
  const date = String(payload.date || '').slice(0, 10);
  const status = VALID.has(payload.status) ? payload.status : 'present';
  return [
    Number(payload.labor_id),
    date,
    status,
    Number(payload.overtime_hours ?? 0),
    payload.notes ? String(payload.notes).trim() : null,
  ];
}

attendance.get('/', async (c) => {
  const q_ = c.req.query();
  const clauses = [];
  const params = [];
  if (q_.from)     { clauses.push('date >= ?'); params.push(q_.from); }
  if (q_.to)       { clauses.push('date <= ?'); params.push(q_.to); }
  if (q_.labor_id) { clauses.push('labor_id = ?'); params.push(Number(q_.labor_id)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = await all(
    `SELECT a.*, l.name AS labor_name, l.daily_wage
     FROM attendance a
     JOIN labor l ON l.id = a.labor_id
     ${where}
     ORDER BY date DESC, a.id DESC`,
    params,
  );
  return c.json({ items });
});

attendance.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r[0] || !r[1]) return c.json({ error: 'labor_id and date are required' }, 400);
  const laborRow = await get('SELECT id FROM labor WHERE id = ?', [r[0]]);
  if (!laborRow) return c.json({ error: 'Unknown labor_id' }, 400);

  const existing = await get(
    'SELECT id FROM attendance WHERE labor_id = ? AND date = ?',
    [r[0], r[1]],
  );
  if (existing) {
    await run(
      `UPDATE attendance SET status=?, overtime_hours=?, notes=? WHERE id=?`,
      [r[2], r[3], r[4], existing.id],
    );
  } else {
    await run(
      `INSERT INTO attendance (labor_id, date, status, overtime_hours, notes)
       VALUES (?, ?, ?, ?, ?)`,
      r,
    );
  }
  const rowOut = await get(
    `SELECT a.*, l.name AS labor_name, l.daily_wage
     FROM attendance a JOIN labor l ON l.id = a.labor_id
     WHERE a.labor_id = ? AND a.date = ?`,
    [r[0], r[1]],
  );
  return c.json({ item: rowOut }, 201);
});

attendance.get('/salary/:id', async (c) => {
  const laborId = Number(c.req.param('id'));
  const laborRow = await get('SELECT * FROM labor WHERE id = ?', [laborId]);
  if (!laborRow) return c.json({ error: 'Worker not found' }, 404);

  const q_ = c.req.query();
  const clauses = ['labor_id = ?'];
  const params = [laborId];
  if (q_.from) { clauses.push('date >= ?'); params.push(q_.from); }
  if (q_.to)   { clauses.push('date <= ?'); params.push(q_.to); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = await all(`SELECT * FROM attendance ${where} ORDER BY date ASC`, params);

  let fullDays = 0, halfDays = 0, absentDays = 0, overtimeHours = 0;
  for (const r of rows) {
    overtimeHours += r.overtime_hours || 0;
    if (r.status === 'present') fullDays++;
    else if (r.status === 'half_day') halfDays++;
    else if (r.status === 'absent') absentDays++;
  }
  const base = laborRow.daily_wage * (fullDays + 0.5 * halfDays);
  const overtime = overtimeHours * Math.max(0, Number(laborRow.overtime_rate ?? 0) || Math.round(laborRow.daily_wage / 8));
  const total = base + overtime;
  return c.json({
    labor: { id: laborRow.id, name: laborRow.name, role: laborRow.role, daily_wage: laborRow.daily_wage },
    period: { from: q_.from || null, to: q_.to || null },
    summary: { fullDays, halfDays, absentDays, overtimeHours },
    earnings: { base, overtime, total },
  });
});

export default attendance;