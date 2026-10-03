// routes/push.js — register / unregister device tokens (Hono router).
//
// FCM isn't supported on Cloudflare Workers (firebase-admin is Node-only).
// The push service is stubbed: registration is persisted in device_tokens, but
// sends are no-ops. Real-time notifications can be added later via Workers
// Web Push or Cloudflare Email Workers without changing this contract.
import { Hono } from 'hono';
import { run } from '../lib/db.js';
import { authRequired, requireSuperAdmin } from '../middleware/auth.js';

const push = new Hono();
push.use('*', authRequired());

const TOKEN_RE = /^[A-Za-z0-9_\-:]{20,}$/;

push.post('/register', requireSuperAdmin(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token, platform } = body || {};
  if (!token || !TOKEN_RE.test(token)) {
    return c.json({ error: 'invalid token' }, 400);
  }
  const p = (platform || '').toString().slice(0, 16) || null;
  const user = c.get('user');
  await run(
    `INSERT INTO device_tokens (user_id, token, platform, last_seen_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       last_seen_at = datetime('now')`,
    [user.id, token, p],
  );
  return c.json({ ok: true, enabled: false });
});

push.delete('/register', requireSuperAdmin(), async (c) => {
  const token = (await c.req.json().catch(() => ({}))).token || c.req.query('token');
  if (!token) return c.json({ error: 'token required' }, 400);
  const user = c.get('user');
  await run('DELETE FROM device_tokens WHERE token = ? AND user_id = ?', [token, user.id]);
  return c.json({ ok: true });
});

push.get('/status', (c) => c.json({ enabled: false }));

export default push;