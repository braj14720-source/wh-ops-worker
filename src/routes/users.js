// routes/users.js — admin user management (Hono router).
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { all, get, run } from '../lib/db.js';
import {
  authRequired,
  requireManagement,
  requireSuperAdmin,
  ROLE_RANK,
} from '../middleware/auth.js';

const users = new Hono();
users.use('*', authRequired());

const ALLOWED_ROLES = new Set(['super_admin', 'admin', 'employee', 'in_house_labour']);

function rolesAllowedFor(actorRole) {
  if (actorRole === 'super_admin') return ALLOWED_ROLES;
  if (actorRole === 'admin') return new Set(['employee', 'in_house_labour']);
  return new Set();
}

function publicUser(r) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    designation: r.designation || null,
    active: r.active ?? 1,
    created_at: r.created_at,
  };
}

users.get('/', requireManagement(), async (c) => {
  const rows = await all(
    'SELECT id, email, name, role, designation, active, created_at FROM users ORDER BY created_at DESC',
  );
  return c.json({ items: rows.map(publicUser) });
});

users.post('/', requireManagement(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, password, name, role, designation } = body || {};
  if (!email || !password || !name) {
    return c.json({ error: 'email, password and name are required' }, 400);
  }
  if (String(password).length < 6) {
    return c.json({ error: 'password must be at least 6 characters' }, 400);
  }
  const user = c.get('user');
  const actorRole = user.role;
  const assignable = rolesAllowedFor(actorRole);
  if (!ALLOWED_ROLES.has(role || '')) {
    return c.json({ error: `role must be one of: ${[...ALLOWED_ROLES].join(', ')}` }, 400);
  }
  if (!assignable.has(role)) {
    return c.json({
      error: `Your role (${actorRole}) cannot create accounts with role ${role}.`,
    }, 403);
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
  if (existing) return c.json({ error: 'Email already registered' }, 409);
  const hash = bcrypt.hashSync(password, 10);
  const info = await run(
    'INSERT INTO users (email, password_hash, name, role, designation) VALUES (?, ?, ?, ?, ?)',
    [normalizedEmail, hash, name, role, designation ? String(designation).trim() : null],
  );
  const row = await get(
    'SELECT id, email, name, role, designation, active, created_at FROM users WHERE id = ?',
    [info.lastInsertRowid],
  );
  return c.json({ user: publicUser(row) }, 201);
});

users.put('/:id', requireManagement(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const user = c.get('user');
  const actorRole = user.role;
  const actorRank = ROLE_RANK[actorRole] || 0;
  const targetRank = ROLE_RANK[existing.role] || 0;
  if (actorRole !== 'super_admin' && targetRank >= ROLE_RANK.admin) {
    return c.json({
      error: 'You do not have permission to edit an account at that role level.',
    }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const updates = { ...existing, ...body };
  if (updates.role && !ALLOWED_ROLES.has(updates.role)) {
    return c.json({ error: 'role must be one of the allowed values' }, 400);
  }
  if (existing.role === 'super_admin' && (updates.role !== 'super_admin' || updates.active === 0)) {
    const cnt = await get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1");
    const saCount = cnt ? Number(cnt.n) : 0;
    if (saCount <= 1) return c.json({ error: 'Cannot demote or deactivate the last active super admin' }, 400);
    if (id === user.id) return c.json({ error: 'You cannot demote or deactivate yourself' }, 400);
  }
  if (updates.role && updates.role !== existing.role) {
    const assignable = rolesAllowedFor(actorRole);
    if (!assignable.has(updates.role)) {
      return c.json({ error: `Your role (${actorRole}) cannot assign role ${updates.role}.` }, 403);
    }
  }
  const hash = updates.password
    ? bcrypt.hashSync(String(updates.password), 10)
    : existing.password_hash;
  await run(
    `UPDATE users SET name=?, role=?, designation=?, active=?, password_hash=? WHERE id=?`,
    [
      String(updates.name).trim(),
      updates.role,
      updates.designation != null ? String(updates.designation).trim() : existing.designation,
      updates.active === undefined ? existing.active : (updates.active ? 1 : 0),
      hash,
      id,
    ],
  );
  const row = await get(
    'SELECT id, email, name, role, designation, active, created_at FROM users WHERE id = ?',
    [id],
  );
  return c.json({ user: publicUser(row) });
});

users.delete('/:id', requireSuperAdmin(), async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  if (id === user.id) return c.json({ error: 'You cannot delete yourself' }, 400);
  const existing = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.role === 'super_admin') {
    const cnt = await get("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND active = 1");
    const saCount = cnt ? Number(cnt.n) : 0;
    if (saCount <= 1) return c.json({ error: 'Cannot delete the last active super admin' }, 400);
  }
  await run('DELETE FROM users WHERE id = ?', [id]);
  return c.json({ ok: true });
});

export default users;