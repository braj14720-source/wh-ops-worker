// routes/settings.js — per-user notification + alert preferences (Hono router).
import { Hono } from 'hono';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireSuperAdmin } from '../middleware/auth.js';

const settings = new Hono();
settings.use('*', authRequired());

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function ensureRow(userId) {
  const exists = await get('SELECT user_id FROM user_settings WHERE user_id = ?', [userId]);
  if (!exists) await run('INSERT INTO user_settings (user_id) VALUES (?)', [userId]);
}

function rowToDto(r) {
  return {
    user_id: r.user_id,
    attendance_remind: r.attendance_remind === 1,
    remind_time: r.remind_time,
    low_stock_alerts: r.low_stock_alerts === 1,
    low_stock_threshold: r.low_stock_threshold,
    push_token: r.push_token || null,
  };
}

settings.get('/', async (c) => {
  const user = c.get('user');
  await ensureRow(user.id);
  const row = await get('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
  return c.json({ settings: rowToDto(row) });
});

settings.put('/', requireSuperAdmin(), async (c) => {
  const user = c.get('user');
  await ensureRow(user.id);
  const body = await c.req.json().catch(() => ({}));
  const attendance_remind = body.attendance_remind === undefined ? 1 : (body.attendance_remind ? 1 : 0);
  const remind_time = TIME_RE.test(body.remind_time || '') ? body.remind_time : '09:00';
  const low_stock_alerts = body.low_stock_alerts === undefined ? 1 : (body.low_stock_alerts ? 1 : 0);
  const low_stock_threshold =
    Number.isFinite(Number(body.low_stock_threshold)) && Number(body.low_stock_threshold) >= 0
      ? Math.floor(Number(body.low_stock_threshold))
      : 5;
  const push_token = typeof body.push_token === 'string' ? body.push_token.slice(0, 256) : null;
  await run(
    `UPDATE user_settings SET
       attendance_remind=?, remind_time=?,
       low_stock_alerts=?, low_stock_threshold=?, push_token=?
     WHERE user_id=?`,
    [attendance_remind, remind_time, low_stock_alerts, low_stock_threshold, push_token, user.id],
  );
  const row = await get('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
  return c.json({ settings: rowToDto(row) });
});

settings.get('/low-stock', async (c) => {
  const user = c.get('user');
  await ensureRow(user.id);
  const s = await get('SELECT * FROM user_settings WHERE user_id = ?', [user.id]);
  if (s.low_stock_alerts !== 1) return c.json({ items: [], enabled: false });
  const items = await all(
    'SELECT id, name, quantity, unit FROM inventory WHERE quantity <= ? ORDER BY quantity ASC',
    [s.low_stock_threshold],
  );
  return c.json({ enabled: true, threshold: s.low_stock_threshold, items });
});

export default settings;