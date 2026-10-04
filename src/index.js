// src/index.js — Cloudflare Worker entry for WH-OPS.
//
// Renders the same REST API as the original Express backend, but on Workers +
// D1. Routes use Hono; the DB layer is a thin D1 adapter (see lib/db.js).
//
// Env (set in wrangler.toml [vars] and via `wrangler secret put`):
//   JWT_SECRET               — required (secret)
//   JWT_EXPIRES_IN           — optional, default '30d'
//   ALLOWED_LOGIN_EMAILS     — comma-separated allowlist (empty = allow all)
//   ALLOWED_ORIGINS          — comma-separated CORS allowlist (empty = allow all)
//   DISABLE_PUBLIC_SIGNUP    — 'true' (default) disables /api/auth/signup
//   BOOTSTRAP_OWNER_EMAIL    — optional, super_admin email to bootstrap
//   BOOTSTRAP_OWNER_PASSWORD — optional, super_admin initial password
//   BOOTSTRAP_OWNER_NAME     — optional, default 'Owner'
//   DB (D1 binding)          — required
//   R2 (R2 binding, optional)— for remote backups
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initDb, ensureSchema, maybeBootstrap } from './lib/db.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import inventoryRoutes from './routes/inventory.js';
import laborRoutes from './routes/labor.js';
import attendanceRoutes from './routes/attendance.js';
import vehiclesRoutes from './routes/vehicles.js';
import eventsRoutes from './routes/events.js';
import exportRoutes from './routes/exports.js';
import importRoutes from './routes/import.js';
import backupRoutes from './routes/backups.js';
import settingsRoutes from './routes/settings.js';
import pushRoutes from './routes/push.js';
import qrRoutes from './routes/qr.js';
import rentalsRoutes from './routes/rentals.js';

const app = new Hono();

// CORS allowlist. Empty = allow all (dev). Comma-separated list otherwise.
const ALLOWED_ORIGINS = (c) => (c.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', cors({
  origin: (origin, c) => {
    const allowList = ALLOWED_ORIGINS(c);
    if (allowList.length === 0) return origin || '*';
    if (!origin) return allowList[0]; // server-to-server / curl
    if (allowList.includes(origin)) return origin;
    // CORS lib passes a string back as the allowed origin; if we return a
    // string that doesn't match `origin`, the lib produces an error response.
    return ''; // empty → blocks
  },
  credentials: false,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
}));

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route('/api/auth', authRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/labor', laborRoutes);
app.route('/api/attendance', attendanceRoutes);
app.route('/api/vehicles', vehiclesRoutes);
app.route('/api/events', eventsRoutes);
app.route('/api/exports', exportRoutes);
app.route('/api/import', importRoutes);
app.route('/api/backups', backupRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/qr', qrRoutes);
app.route('/api/rentals', rentalsRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const status = Number(err && err.status) || 500;
  if (status >= 500) console.error('[error]', err);
  return c.json({ error: err.message || 'Internal server error' }, status);
});

export default {
  async fetch(request, env, ctx) {
    initDb(env.DB);
    await ensureSchema();
    await maybeBootstrap(env);
    return app.fetch(request, env, ctx);
  },
};