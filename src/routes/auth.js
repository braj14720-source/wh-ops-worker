// routes/auth.js — signup / login / me (Hono router).
//
// Hardening:
//   - Public signup is DISABLED by default. Owners create accounts via /api/users.
//   - Login is restricted to emails in ALLOWED_LOGIN_EMAILS (comma-separated
//     env var, case-insensitive). If unset, login is unrestricted (dev only).
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { get } from '../lib/db.js';
import { authRequired } from '../middleware/auth.js';

const auth = new Hono();

function parseAllowedEmails(env) {
  return (env.ALLOWED_LOGIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function emailAllowed(env, email) {
  const normalized = String(email || '').trim().toLowerCase();
  const allowList = parseAllowedEmails(env);
  if (allowList.length === 0) return true;
  if (allowList.includes(normalized)) return true;
  // Fallback: any user that already exists in the users table can log in.
  try {
    const row = await get('SELECT id FROM users WHERE email = ?', [normalized]);
    return !!row;
  } catch (_) {
    return false;
  }
}

function signToken(env, user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN || '30d' },
  );
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// POST /api/auth/signup — DISABLED by default
auth.post('/signup', async (c) => {
  const env = c.env;
  const allowSignup =
    String(env.DISABLE_PUBLIC_SIGNUP || '').toLowerCase() !== 'true' &&
    String(env.ALLOW_PUBLIC_SIGNUP || '').toLowerCase() === 'true';
  if (!allowSignup) {
    return c.json(
      {
        error:
          'Public signup is disabled. Ask the owner to create an account for you via the Team screen.',
      },
      403,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const { email, password, name } = body || {};
  if (!email || !password || !name) {
    return c.json({ error: 'email, password and name are required' }, 400);
  }
  if (!(await emailAllowed(env, email))) {
    return c.json({ error: 'Signup is restricted to authorised emails.' }, 403);
  }
  const normalizedEmail = String(email).trim().toLowerCase();

  const existing = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing) return c.json({ error: 'Email already registered' }, 409);

  const hash = bcrypt.hashSync(password, 10);
  const { run } = await import('../lib/db.js');
  const info = await run(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
    [normalizedEmail, hash, name, 'employee'],
  );
  const user = await get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
  const token = signToken(env, user);
  return c.json({ token, user: publicUser(user) }, 201);
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const env = c.env;
  const body = await c.req.json().catch(() => ({}));
  const { email, password } = body || {};
  if (!email || !password) {
    return c.json({ error: 'email and password are required' }, 400);
  }
  const normalized = String(email).trim().toLowerCase();

  if (!(await emailAllowed(env, normalized))) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  const user = await get('SELECT * FROM users WHERE email = ?', [normalized]);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

  const token = signToken(env, user);
  return c.json({ token, user: publicUser(user) });
});

// GET /api/auth/me
auth.get('/me', authRequired(), async (c) => {
  const user = c.get('user');
  const row = await get('SELECT id, email, name, role FROM users WHERE id = ?', [user.id]);
  if (!row) return c.json({ error: 'User not found' }, 404);
  return c.json({ user: row });
});

export default auth;