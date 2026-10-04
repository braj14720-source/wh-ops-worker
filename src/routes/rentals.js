// routes/rentals.js — PW-RENTAL: rental orders and per-rental materials.
//
// Endpoints:
//   GET    /api/rentals                       list rentals
//   POST   /api/rentals                       create a new rental
//   GET    /api/rentals/:id                   one rental + counts
//   PUT    /api/rentals/:id                   update a rental
//   DELETE /api/rentals/:id                   delete (super_admin) — refunds all materials
//   GET    /api/rentals/:id/materials         list materials (joined with inventory)
//   POST   /api/rentals/:id/materials         upsert one material
//   PUT    /api/rentals/:id/materials/:mid    update one material
//   DELETE /api/rentals/:id/materials         clear all materials (refunds each)
//   DELETE /api/rentals/:id/materials/:mid    remove one material (refunds net)
//   GET    /api/rentals/next-no              suggest next rental_no (e.g. PW-RENTAL-0007)

import { Hono } from 'hono';
import { all, get, run, transaction } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete, requireSuperAdmin } from '../middleware/auth.js';

const rentals = new Hono();
rentals.use('*', authRequired());

const RENTAL_STATUSES = new Set(['open', 'dispatched', 'returned', 'closed', 'cancelled']);
const MATERIAL_STATUSES = new Set(['reserved', 'dispatched', 'returned', 'damaged']);

function row(payload) {
  return {
    client_name: String(payload.client_name || '').trim(),
    client_phone: payload.client_phone ? String(payload.client_phone).trim() : null,
    event_name: payload.event_name ? String(payload.event_name).trim() : null,
    delivery_address: payload.delivery_address ? String(payload.delivery_address).trim() : null,
    start_date: payload.start_date ? String(payload.start_date).slice(0, 10) : null,
    end_date: payload.end_date ? String(payload.end_date).slice(0, 10) : null,
    status: RENTAL_STATUSES.has(payload.status) ? payload.status : 'open',
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

function publicRental(r) {
  if (!r) return null;
  return {
    id: r.id,
    rental_no: r.rental_no,
    client_name: r.client_name,
    client_phone: r.client_phone,
    event_name: r.event_name,
    delivery_address: r.delivery_address,
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function publicMaterial(m) {
  const q = Number(m.quantity || 0);
  const r = Number(m.returned_quantity || 0);
  return {
    id: m.id,
    rental_id: m.rental_id,
    inventory_id: m.inventory_id,
    inventory_name: m.inventory_name || null,
    inventory_category: m.inventory_category || null,
    inventory_unit: m.inventory_unit || null,
    inventory_photo_url: m.inventory_photo_url || null,
    inventory_quantity: m.inventory_quantity != null ? Number(m.inventory_quantity) : null,
    quantity: q,
    returned_quantity: r,
    net_quantity: Math.max(0, q - r),
    status: m.status,
    notes: m.notes,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

async function adjustInventory(inventoryId, delta) {
  if (!delta || delta === 0) return;
  await run(
    `UPDATE inventory
        SET quantity  = MAX(0, quantity + ?),
            updated_at = datetime('now')
      WHERE id = ?`,
    [delta, inventoryId],
  );
}

async function nextRentalNo() {
  const r = await get(
    `SELECT rental_no FROM rentals WHERE rental_no LIKE 'PW-RENTAL-%' ORDER BY id DESC LIMIT 1`,
  );
  let n = 1;
  if (r && r.rental_no) {
    const m = r.rental_no.match(/PW-RENTAL-(\d+)/);
    if (m) n = Number(m[1]) + 1;
  }
  return `PW-RENTAL-${String(n).padStart(4, '0')}`;
}

// ----- rental CRUD ----------------------------------------------------------

rentals.get('/', async (c) => {
  const rows = await all(
    `SELECT r.*,
            (SELECT COUNT(*) FROM rental_materials WHERE rental_id = r.id) AS material_count,
            (SELECT COALESCE(SUM(quantity - returned_quantity), 0)
               FROM rental_materials WHERE rental_id = r.id) AS qty_out
       FROM rentals r
      ORDER BY r.start_date DESC, r.id DESC`,
  );
  return c.json({
    items: rows.map((r) => ({
      ...publicRental(r),
      material_count: Number(r.material_count || 0),
      qty_out: Number(r.qty_out || 0),
    })),
  });
});

rentals.get('/next-no', async (c) => {
  return c.json({ rental_no: await nextRentalNo() });
});

rentals.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r.client_name) return c.json({ error: 'client_name is required' }, 400);
  const no = await nextRentalNo();
  const info = await run(
    `INSERT INTO rentals (rental_no, client_name, client_phone, event_name, delivery_address,
                          start_date, end_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [no, r.client_name, r.client_phone, r.event_name, r.delivery_address,
     r.start_date, r.end_date, r.status, r.notes],
  );
  const created = await get('SELECT * FROM rentals WHERE id = ?', [info.lastInsertRowid]);
  return c.json({ rental: publicRental(created) }, 201);
});

rentals.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const r = await get('SELECT * FROM rentals WHERE id = ?', [id]);
  if (!r) return c.json({ error: 'Rental not found' }, 404);
  const mats = await all(
    'SELECT COUNT(*) AS n FROM rental_materials WHERE rental_id = ?',
    [id],
  );
  const qty = await get(
    `SELECT COALESCE(SUM(quantity - returned_quantity), 0) AS q FROM rental_materials WHERE rental_id = ?`,
    [id],
  );
  return c.json({
    rental: publicRental(r),
    material_count: Number(mats?.n || 0),
    qty_out: Number(qty?.q || 0),
  });
});

rentals.put('/:id', requireWrite(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT * FROM rentals WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const r = row({ ...existing, ...body });
  if (!r.client_name) return c.json({ error: 'client_name is required' }, 400);
  await run(
    `UPDATE rentals
        SET client_name=?, client_phone=?, event_name=?, delivery_address=?,
            start_date=?, end_date=?, status=?, notes=?, updated_at=datetime('now')
      WHERE id=?`,
    [r.client_name, r.client_phone, r.event_name, r.delivery_address,
     r.start_date, r.end_date, r.status, r.notes, id],
  );
  const updated = await get('SELECT * FROM rentals WHERE id = ?', [id]);
  return c.json({ rental: publicRental(updated) });
});

rentals.delete('/:id', requireDelete(), async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await get('SELECT id FROM rentals WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const rows = await all(
    'SELECT inventory_id, quantity, returned_quantity FROM rental_materials WHERE rental_id = ?',
    [id],
  );
  await transaction(async () => {
    for (const r of rows) {
      const net = Math.max(0, Number(r.quantity || 0) - Number(r.returned_quantity || 0));
      await adjustInventory(r.inventory_id, net);
    }
    await run('DELETE FROM rentals WHERE id = ?', [id]);
  });
  return c.json({ ok: true, refunded: rows.length });
});

// ----- rental materials -----------------------------------------------------

rentals.get('/:id/materials', async (c) => {
  const id = Number(c.req.param('id'));
  const rows = await all(
    `SELECT m.*,
            i.name      AS inventory_name,
            i.category  AS inventory_category,
            i.unit      AS inventory_unit,
            i.photo_url AS inventory_photo_url,
            i.quantity  AS inventory_quantity
       FROM rental_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.rental_id = ?
      ORDER BY i.name ASC`,
    [id],
  );
  return c.json({ items: rows.map(publicMaterial) });
});

rentals.post('/:id/materials', requireWrite(), async (c) => {
  const rentalId = Number(c.req.param('id'));
  const existing_r = await get('SELECT id FROM rentals WHERE id = ?', [rentalId]);
  if (!existing_r) return c.json({ error: 'Rental not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const inventory_id = Number(body.inventory_id);
  if (!inventory_id) return c.json({ error: 'inventory_id is required' }, 400);
  const inv = await get('SELECT id, merged_into FROM inventory WHERE id = ?', [inventory_id]);
  if (!inv) return c.json({ error: 'Unknown inventory_id' }, 400);
  if (inv.merged_into) {
    return c.json({
      error: 'That item was merged into another row. Add the active row instead.',
      merged_into: inv.merged_into,
    }, 409);
  }
  const quantity = Math.max(0, Number(body.quantity ?? 1));
  const status = MATERIAL_STATUSES.has(body.status) ? body.status : 'reserved';
  const notes = body.notes ? String(body.notes).trim() : null;

  const existing = await get(
    'SELECT * FROM rental_materials WHERE rental_id = ? AND inventory_id = ?',
    [rentalId, inventory_id],
  );

  await transaction(async () => {
    const oldQ = existing ? Number(existing.quantity || 0) : 0;
    const delta = -(quantity - oldQ);
    await adjustInventory(inventory_id, delta);
    await run(
      `INSERT INTO rental_materials (rental_id, inventory_id, quantity, status, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(rental_id, inventory_id) DO UPDATE SET
         quantity   = excluded.quantity,
         status     = excluded.status,
         notes      = excluded.notes,
         updated_at = datetime('now')`,
      [rentalId, inventory_id, quantity, status, notes],
    );
  });

  const rowOut = await get(
    `SELECT m.*, i.name AS inventory_name, i.category AS inventory_category,
            i.unit AS inventory_unit, i.photo_url AS inventory_photo_url,
            i.quantity AS inventory_quantity
       FROM rental_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.rental_id = ? AND m.inventory_id = ?`,
    [rentalId, inventory_id],
  );
  return c.json({ material: publicMaterial(rowOut) }, 201);
});

rentals.put('/:id/materials/:mid', requireWrite(), async (c) => {
  const rentalId = Number(c.req.param('id'));
  const mid = Number(c.req.param('mid'));
  const existing = await get(
    'SELECT * FROM rental_materials WHERE id = ? AND rental_id = ?',
    [mid, rentalId],
  );
  if (!existing) return c.json({ error: 'Material not found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const oldQ = Number(existing.quantity || 0);
  const oldR = Number(existing.returned_quantity || 0);
  const quantity = body.quantity != null ? Math.max(0, Number(body.quantity)) : oldQ;
  const returned_quantity = body.returned_quantity != null
    ? Math.max(0, Math.min(Number(body.returned_quantity), quantity))
    : oldR;
  const status = body.status
    ? (MATERIAL_STATUSES.has(body.status) ? body.status : existing.status)
    : existing.status;
  const notes = body.notes != null
    ? (body.notes ? String(body.notes).trim() : null)
    : existing.notes;

  const qDelta = quantity - oldQ;
  const rDelta = returned_quantity - oldR;
  const inventoryDelta = -qDelta + rDelta;

  await transaction(async () => {
    await adjustInventory(existing.inventory_id, inventoryDelta);
    await run(
      `UPDATE rental_materials
          SET quantity=?, returned_quantity=?, status=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
      [quantity, returned_quantity, status, notes, mid],
    );
  });

  const rowOut = await get(
    `SELECT m.*, i.name AS inventory_name, i.category AS inventory_category,
            i.unit AS inventory_unit, i.photo_url AS inventory_photo_url,
            i.quantity AS inventory_quantity
       FROM rental_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.id = ?`,
    [mid],
  );
  return c.json({ material: publicMaterial(rowOut) });
});

rentals.delete('/:id/materials', requireWrite(), async (c) => {
  const rentalId = Number(c.req.param('id'));
  const rows = await all(
    'SELECT inventory_id, quantity, returned_quantity FROM rental_materials WHERE rental_id = ?',
    [rentalId],
  );
  await transaction(async () => {
    for (const r of rows) {
      const net = Math.max(0, Number(r.quantity || 0) - Number(r.returned_quantity || 0));
      await adjustInventory(r.inventory_id, net);
    }
    await run('DELETE FROM rental_materials WHERE rental_id = ?', [rentalId]);
  });
  return c.json({ ok: true, refunded: rows.length });
});

rentals.delete('/:id/materials/:mid', requireWrite(), async (c) => {
  const rentalId = Number(c.req.param('id'));
  const mid = Number(c.req.param('mid'));
  const existing = await get(
    'SELECT * FROM rental_materials WHERE id = ? AND rental_id = ?',
    [mid, rentalId],
  );
  if (!existing) return c.json({ error: 'Material not found' }, 404);
  await transaction(async () => {
    const net = Math.max(0, Number(existing.quantity || 0) - Number(existing.returned_quantity || 0));
    await adjustInventory(existing.inventory_id, net);
    await run('DELETE FROM rental_materials WHERE id = ?', [mid]);
  });
  return c.json({ ok: true });
});

export default rentals;