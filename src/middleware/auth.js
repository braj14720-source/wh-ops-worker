// middleware/auth.js — JWT bearer-token auth + role guards (Hono style).
//
// Roles (in order of privilege):
//   super_admin     — full control, including DELETE on operational data
//   admin           — can create/manage employee & in_house_labour accounts, edit data, NO delete
//   employee        — can edit data, NO delete
//   in_house_labour — read-only access
//
// Semantic shortcuts:
//   requireSuperAdmin   — super_admin only
//   requireManagement   — super_admin OR admin  (for user management endpoints)
//   requireStaff        — super_admin, admin, OR employee (operational writes)
//   requireWrite        — alias for requireStaff
//   requireDelete       — alias for requireSuperAdmin

import jwt from 'jsonwebtoken';

const ROLE_RANK = {
  super_admin: 40,
  admin: 30,
  employee: 20,
  in_house_labour: 10,
};

export function authRequired() {
  return async (c, next) => {
    const header = c.req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return c.json({ error: 'Missing token' }, 401);
    try {
      const payload = jwt.verify(token, c.env.JWT_SECRET);
      c.set('user', payload);
      await next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  };
}

function requireRole(...roles) {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}

function requireAtLeast(minRole) {
  const min = ROLE_RANK[minRole] || 0;
  return async (c, next) => {
    const user = c.get('user');
    const r = user && ROLE_RANK[user.role];
    if (!r || r < min) return c.json({ error: 'Forbidden' }, 403);
    await next();
  };
}

export const requireSuperAdmin = () => requireRole('super_admin');
export const requireManagement = () => requireRole('super_admin', 'admin');
export const requireStaff      = () => requireRole('super_admin', 'admin', 'employee');
export const requireWrite      = requireStaff;
export const requireDelete     = requireSuperAdmin;

export { ROLE_RANK };