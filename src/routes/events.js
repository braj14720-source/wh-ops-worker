// routes/events.js — Events with labour allocation + per-event material checklist (Hono).
//
// Endpoints:
//   GET    /api/events                            list events
//   POST   /api/events                            create event (+ optional source_teams)
//   GET    /api/events/:id                        get one with source_teams, materials, counts
//   PUT    /api/events/:id                        update event (incl. customer/project fields)
//   DELETE /api/events/:id                        delete (cascades to source teams, allocations, materials)
//   GET    /api/events/:id/source-teams           list source teams
//   POST   /api/events/:id/source-teams           add source team
//   PUT    /api/events/:id/source-teams/:stid     update source team
//   DELETE /api/events/:id/source-teams/:stid     remove source team
//   GET    /api/events/:id/allocations            list allocations (joined with labor + source_team)
//   POST   /api/events/:id/allocations            bulk upsert allocations
//   DELETE /api/events/:id/allocations            clear all allocations for event
//   DELETE /api/events/:id/allocations/:aid      remove one allocation
//   POST   /api/events/:id/calculate             pure-math calculator
//   GET    /api/events/:id/materials              list material checklist (joined with inventory)
//   POST   /api/events/:id/materials              add or update a material
//   PUT    /api/events/:id/materials/:mid         update a single material
//   DELETE /api/events/:id/materials              clear all materials
//   DELETE /api/events/:id/materials/:mid         remove one material

import { Hono } from 'hono';
import { all, get, run, transaction } from '../lib/db.js';
import { authRequired, requireWrite, requireDelete } from '../middleware/auth.js';

const events = new Hono();
events.use('*', authRequired());

const EVENT_STATUSES = new Set(['planning', 'active', 'completed', 'cancelled']);
const ALLOC_ROLES = new Set(['worker', 'supervisor']);

const MATERIAL_STATUSES = new Set([
  'planning_pending',
  'po_raised',
  'ready_for_procurement',
  'procurement_approval_required',
  'segregated',
  'bom_finalized',
  'dispatched',
  'delivered_at_warehouse',
  'installed',
  'returned',
]);

const MATERIAL_STATUS_LABEL = {
  planning_pending: 'Planning Pending',
  po_raised: 'Po Raised',
  ready_for_procurement: 'Ready for Procurement',
  procurement_approval_required: 'Procurement Approval Required',
  segregated: 'Segregated',
  bom_finalized: 'BOM Finalized',
  dispatched: 'Dispatched',
  delivered_at_warehouse: 'Delivered At Warehouse',
  installed: 'Installed',
  returned: 'Returned',
};

// ----- helpers --------------------------------------------------------------

function row(payload) {
  return {
    name: String(payload.name || '').trim(),
    date: payload.date ? String(payload.date).slice(0, 10) : null,
    location: payload.location ? String(payload.location).trim() : null,
    client_name: payload.client_name ? String(payload.client_name).trim() : null,
    customer_phone: payload.customer_phone ? String(payload.customer_phone).trim() : null,
    project_manager: payload.project_manager ? String(payload.project_manager).trim() : null,
    project_executive: payload.project_executive ? String(payload.project_executive).trim() : null,
    consultant: payload.consultant ? String(payload.consultant).trim() : null,
    status: EVENT_STATUSES.has(payload.status) ? payload.status : 'planning',
    total_workers: Number(payload.total_workers ?? 0),
    num_source_teams: Number(payload.num_source_teams ?? 0),
    num_pm_teams: Number(payload.num_pm_teams ?? 0),
    notes: payload.notes ? String(payload.notes).trim() : null,
  };
}

function publicEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    date: r.date,
    location: r.location,
    client_name: r.client_name,
    customer_phone: r.customer_phone,
    project_manager: r.project_manager,
    project_executive: r.project_executive,
    consultant: r.consultant,
    status: r.status,
    total_workers: r.total_workers,
    num_source_teams: r.num_source_teams,
    num_pm_teams: r.num_pm_teams,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function publicSourceTeam(r) {
  return {
    id: r.id,
    event_id: r.event_id,
    name: r.name,
    worker_count: r.worker_count,
    supervisor_count: r.supervisor_count,
    created_at: r.created_at,
  };
}

function publicAllocation(r) {
  return {
    id: r.id,
    event_id: r.event_id,
    labor_id: r.labor_id,
    labor_name: r.labor_name || null,
    source_team_id: r.source_team_id,
    source_team_name: r.source_team_name || null,
    pm_team: r.pm_team,
    role: r.role,
    notes: r.notes,
    created_at: r.created_at,
  };
}

function publicMaterial(r) {
  const quantity = Number(r.quantity || 0);
  const returned = Number(r.returned_quantity || 0);
  return {
    id: r.id,
    event_id: r.event_id,
    inventory_id: r.inventory_id,
    inventory_name: r.inventory_name || null,
    inventory_category: r.inventory_category || null,
    inventory_unit: r.inventory_unit || null,
    inventory_photo_url: r.inventory_photo_url || null,
    inventory_quantity: r.inventory_quantity != null ? Number(r.inventory_quantity) : null,
    quantity,
    returned_quantity: returned,
    net_quantity: Math.max(0, quantity - returned), // consumed / still out at the event
    status: r.status,
    status_label: MATERIAL_STATUS_LABEL[r.status] || r.status,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ----- inventory deduction helpers ------------------------------------------

// Apply a signed delta to inventory.quantity for a given inventory row.
// Caller is expected to be inside a transaction.
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

function calculate({ total_workers, supervisor_count, num_pm_teams }) {
  total_workers = Math.max(0, Number(total_workers) || 0);
  supervisor_count = Math.max(0, Number(supervisor_count) || 0);
  num_pm_teams = Math.max(0, Number(num_pm_teams) || 0);
  const balance = Math.max(0, total_workers - supervisor_count);
  let distribution = [];
  let summary = '';
  if (num_pm_teams === 0) {
    summary = `${supervisor_count} supervisors, ${balance} balance labour (no PM teams defined yet)`;
  } else {
    const base = Math.floor(balance / num_pm_teams);
    const remainder = balance - base * num_pm_teams;
    distribution = Array.from({ length: num_pm_teams }, (_, i) =>
      i < remainder ? base + 1 : base,
    );
    const big = distribution.filter((n) => n === base + 1).length;
    const small = distribution.filter((n) => n === base).length;
    summary = `${big} × ${base + 1} + ${small} × ${base}`;
  }
  return {
    total_workers,
    supervisor_count,
    num_pm_teams,
    balance,
    distribution,
    summary,
    pm_team_count: supervisor_count,
  };
}

async function recomputeEventTotals(eventId) {
  const srcTeams = await all(
    'SELECT worker_count, supervisor_count FROM event_source_teams WHERE event_id = ?',
    [eventId],
  );
  const totalWorkers = srcTeams.reduce((acc, t) => acc + (t.worker_count || 0), 0);
  const totalSupervisors = srcTeams.reduce((acc, t) => acc + (t.supervisor_count || 0), 0);
  await run(
    `UPDATE events
        SET total_workers = ?,
            num_source_teams = ?,
            num_pm_teams = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
    [totalWorkers, srcTeams.length, totalSupervisors, eventId],
  );
}

// ----- events CRUD ----------------------------------------------------------

events.get('/', async (c) => {
  const rows = await all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
  return c.json({ items: rows.map(publicEvent) });
});

events.post('/', requireWrite(), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r.name) return c.json({ error: 'name is required' }, 400);
  const result = await run(
    `INSERT INTO events (name, date, location, client_name, customer_phone,
                         project_manager, project_executive, consultant,
                         status, total_workers, num_source_teams, num_pm_teams, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.name, r.date, r.location, r.client_name, r.customer_phone,
      r.project_manager, r.project_executive, r.consultant,
      r.status, r.total_workers, r.num_source_teams, r.num_pm_teams, r.notes,
    ],
  );
  const eventId = Number(result.lastInsertRowid);
  if (Array.isArray(body.source_teams)) {
    for (const st of body.source_teams) {
      await run(
        `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
         VALUES (?, ?, ?, ?)`,
        [
          eventId,
          String(st.name || '').trim() || 'Unnamed team',
          Math.max(0, Number(st.worker_count) || 0),
          Math.max(0, Number(st.supervisor_count) || 0),
        ],
      );
    }
    await recomputeEventTotals(eventId);
  }
  const created = await get('SELECT * FROM events WHERE id = ?', [eventId]);
  return c.json({ event: publicEvent(created) }, 201);
});

events.get('/:id', async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  const source_teams = await all(
    'SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC',
    [eventId],
  );
  const allocCountRow = await get(
    'SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ?',
    [eventId],
  );
  const supCountRow = await get(
    "SELECT COUNT(*) AS n FROM event_allocations WHERE event_id = ? AND role = 'supervisor'",
    [eventId],
  );
  const matCountRow = await get(
    'SELECT COUNT(*) AS n FROM event_materials WHERE event_id = ?',
    [eventId],
  );
  const totalSupervisors = source_teams.reduce((a, t) => a + (t.supervisor_count || 0), 0);
  return c.json({
    event: publicEvent(ev),
    source_teams: source_teams.map(publicSourceTeam),
    counts: {
      source_team_count: source_teams.length,
      allocation_count: Number(allocCountRow ? allocCountRow.n : 0),
      supervisor_allocations: Number(supCountRow ? supCountRow.n : 0),
      source_team_supervisor_total: totalSupervisors,
      material_count: Number(matCountRow ? matCountRow.n : 0),
    },
  });
});

events.put('/:id', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const r = row(body);
  if (!r.name) return c.json({ error: 'name is required' }, 400);
  await run(
    `UPDATE events
        SET name=?, date=?, location=?, client_name=?, customer_phone=?,
            project_manager=?, project_executive=?, consultant=?,
            status=?, notes=?, updated_at=datetime('now')
      WHERE id=?`,
    [
      r.name, r.date, r.location, r.client_name, r.customer_phone,
      r.project_manager, r.project_executive, r.consultant,
      r.status, r.notes, eventId,
    ],
  );
  const updated = await get('SELECT * FROM events WHERE id = ?', [eventId]);
  return c.json({ event: publicEvent(updated) });
});

events.delete('/:id', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT * FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  await run('DELETE FROM events WHERE id = ?', [eventId]);
  return c.json({ ok: true });
});

// ----- source teams ---------------------------------------------------------

events.get('/:id/source-teams', async (c) => {
  const eventId = Number(c.req.param('id'));
  const rows = await all(
    'SELECT * FROM event_source_teams WHERE event_id = ? ORDER BY id ASC',
    [eventId],
  );
  return c.json({ items: rows.map(publicSourceTeam) });
});

events.post('/:id/source-teams', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT id FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  const worker_count = Math.max(0, Number(body.worker_count) || 0);
  const supervisor_count = Math.max(0, Number(body.supervisor_count) || 0);
  const result = await run(
    `INSERT INTO event_source_teams (event_id, name, worker_count, supervisor_count)
     VALUES (?, ?, ?, ?)`,
    [eventId, name, worker_count, supervisor_count],
  );
  await recomputeEventTotals(eventId);
  const created = await get('SELECT * FROM event_source_teams WHERE id = ?', [result.lastInsertRowid]);
  return c.json({ source_team: publicSourceTeam(created) }, 201);
});

events.put('/:id/source-teams/:stid', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const stid = Number(c.req.param('stid'));
  const st = await get(
    'SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?',
    [stid, eventId],
  );
  if (!st) return c.json({ error: 'Source team not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = body.name != null ? String(body.name).trim() : st.name;
  if (!name) return c.json({ error: 'name is required' }, 400);
  const worker_count = body.worker_count != null
    ? Math.max(0, Number(body.worker_count) || 0)
    : st.worker_count;
  const supervisor_count = body.supervisor_count != null
    ? Math.max(0, Number(body.supervisor_count) || 0)
    : st.supervisor_count;
  await run(
    `UPDATE event_source_teams SET name=?, worker_count=?, supervisor_count=? WHERE id=?`,
    [name, worker_count, supervisor_count, stid],
  );
  await recomputeEventTotals(eventId);
  const updated = await get('SELECT * FROM event_source_teams WHERE id = ?', [stid]);
  return c.json({ source_team: publicSourceTeam(updated) });
});

events.delete('/:id/source-teams/:stid', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const stid = Number(c.req.param('stid'));
  const st = await get(
    'SELECT * FROM event_source_teams WHERE id = ? AND event_id = ?',
    [stid, eventId],
  );
  if (!st) return c.json({ error: 'Source team not found' }, 404);
  await run('DELETE FROM event_source_teams WHERE id = ?', [stid]);
  await recomputeEventTotals(eventId);
  return c.json({ ok: true });
});

// ----- allocations ----------------------------------------------------------

events.get('/:id/allocations', async (c) => {
  const eventId = Number(c.req.param('id'));
  const rows = await all(
    `SELECT a.*,
            l.name   AS labor_name,
            st.name  AS source_team_name
       FROM event_allocations a
       LEFT JOIN labor l ON l.id = a.labor_id
       LEFT JOIN event_source_teams st ON st.id = a.source_team_id
      WHERE a.event_id = ?
      ORDER BY a.pm_team ASC, l.name ASC`,
    [eventId],
  );
  return c.json({ items: rows.map(publicAllocation) });
});

events.post('/:id/allocations', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT id FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return c.json({ error: 'items[] is required' }, 400);

  const laborIds = [...new Set(items.map((it) => Number(it.labor_id)).filter(Boolean))];
  if (laborIds.length) {
    const placeholders = laborIds.map(() => '?').join(',');
    const found = (await all(`SELECT id FROM labor WHERE id IN (${placeholders})`, laborIds))
      .map((r) => r.id);
    const missing = laborIds.filter((id) => !found.includes(id));
    if (missing.length) {
      return c.json({ error: `Unknown labor_id(s): ${missing.join(', ')}` }, 400);
    }
  }

  await transaction(async () => {
    for (const it of items) {
      if (!it.labor_id) continue;
      await run(
        `INSERT INTO event_allocations (event_id, labor_id, source_team_id, pm_team, role, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, labor_id) DO UPDATE SET
           source_team_id = excluded.source_team_id,
           pm_team        = excluded.pm_team,
           role           = excluded.role,
           notes          = excluded.notes`,
        [
          eventId,
          Number(it.labor_id),
          it.source_team_id ? Number(it.source_team_id) : null,
          it.pm_team != null ? Number(it.pm_team) : null,
          ALLOC_ROLES.has(it.role) ? it.role : 'worker',
          it.notes ? String(it.notes).trim() : null,
        ],
      );
    }
  });

  await recomputeEventTotals(eventId);

  const rows = await all(
    `SELECT a.*,
            l.name   AS labor_name,
            st.name  AS source_team_name
       FROM event_allocations a
       LEFT JOIN labor l ON l.id = a.labor_id
       LEFT JOIN event_source_teams st ON st.id = a.source_team_id
      WHERE a.event_id = ?
      ORDER BY a.pm_team ASC, l.name ASC`,
    [eventId],
  );
  return c.json({ items: rows.map(publicAllocation) }, 201);
});

events.delete('/:id/allocations', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  await run('DELETE FROM event_allocations WHERE event_id = ?', [eventId]);
  await recomputeEventTotals(eventId);
  return c.json({ ok: true });
});

events.delete('/:id/allocations/:aid', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const aid = Number(c.req.param('aid'));
  const alloc = await get(
    'SELECT * FROM event_allocations WHERE id = ? AND event_id = ?',
    [aid, eventId],
  );
  if (!alloc) return c.json({ error: 'Allocation not found' }, 404);
  await run('DELETE FROM event_allocations WHERE id = ?', [aid]);
  await recomputeEventTotals(eventId);
  return c.json({ ok: true });
});

// ----- materials (procurement workflow) -------------------------------------

events.get('/:id/materials', async (c) => {
  const eventId = Number(c.req.param('id'));
  const rows = await all(
    `SELECT m.*,
            i.name      AS inventory_name,
            i.category  AS inventory_category,
            i.unit      AS inventory_unit,
            i.photo_url AS inventory_photo_url,
            i.quantity  AS inventory_quantity
       FROM event_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.event_id = ?
      ORDER BY m.status ASC, i.name ASC`,
    [eventId],
  );
  return c.json({ items: rows.map(publicMaterial) });
});

events.post('/:id/materials', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const ev = await get('SELECT id FROM events WHERE id = ?', [eventId]);
  if (!ev) return c.json({ error: 'Event not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const inventory_id = Number(body.inventory_id);
  if (!inventory_id) return c.json({ error: 'inventory_id is required' }, 400);
  const inv = await get(
    'SELECT id, merged_into FROM inventory WHERE id = ?',
    [inventory_id],
  );
  if (!inv) return c.json({ error: 'Unknown inventory_id' }, 400);
  if (inv.merged_into) {
    return c.json({
      error: 'That item was merged into another row. Add the active row instead.',
      merged_into: inv.merged_into,
    }, 409);
  }
  const quantity = Math.max(0, Number(body.quantity ?? 1));
  const status = MATERIAL_STATUSES.has(body.status) ? body.status : 'planning_pending';
  const notes = body.notes ? String(body.notes).trim() : null;

  // Look up any existing row so we can compute the inventory delta.
  const existing = await get(
    'SELECT * FROM event_materials WHERE event_id = ? AND inventory_id = ?',
    [eventId, inventory_id],
  );

  await transaction(async () => {
    // Net effect on inventory: subtract the new reserved amount, then add back
    // any amount already reserved (the old row). The algebra is the same as
    // for an update below.
    const oldQ = existing ? Number(existing.quantity || 0) : 0;
    const delta = -(quantity - oldQ); // negative = deduct from inventory
    await adjustInventory(inventory_id, delta);

    await run(
      `INSERT INTO event_materials (event_id, inventory_id, quantity, status, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id, inventory_id) DO UPDATE SET
         quantity   = excluded.quantity,
         status     = excluded.status,
         notes      = excluded.notes,
         updated_at = datetime('now')`,
      [eventId, inventory_id, quantity, status, notes],
    );
  });

  const rowOut = await get(
    `SELECT m.*, i.name AS inventory_name, i.category AS inventory_category, i.unit AS inventory_unit,
            i.photo_url AS inventory_photo_url, i.quantity AS inventory_quantity
       FROM event_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.event_id = ? AND m.inventory_id = ?`,
    [eventId, inventory_id],
  );
  return c.json({ material: publicMaterial(rowOut) }, 201);
});

events.put('/:id/materials/:mid', requireWrite(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const mid = Number(c.req.param('mid'));
  const existing = await get(
    'SELECT * FROM event_materials WHERE id = ? AND event_id = ?',
    [mid, eventId],
  );
  if (!existing) return c.json({ error: 'Material not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const oldQ = Number(existing.quantity || 0);
  const oldR = Number(existing.returned_quantity || 0);

  const quantity = body.quantity != null
    ? Math.max(0, Number(body.quantity))
    : oldQ;
  const returned_quantity = body.returned_quantity != null
    ? Math.max(0, Math.min(Number(body.returned_quantity), quantity))
    : oldR;
  const status = body.status
    ? (MATERIAL_STATUSES.has(body.status) ? body.status : existing.status)
    : existing.status;
  const notes = body.notes != null
    ? (body.notes ? String(body.notes).trim() : null)
    : existing.notes;

  // Net inventory change:
  //   • if quantity grew by Δq, deduct Δq
  //   • if returned grew by Δr, add Δr (items came back to warehouse)
  const qDelta = quantity - oldQ;          // + = user added more to BOM
  const rDelta = returned_quantity - oldR; // + = user marked more as returned
  const inventoryDelta = -qDelta + rDelta; // negative = deduct, positive = refund

  await transaction(async () => {
    await adjustInventory(existing.inventory_id, inventoryDelta);
    await run(
      `UPDATE event_materials
          SET quantity=?, returned_quantity=?, status=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
      [quantity, returned_quantity, status, notes, mid],
    );
  });

  const rowOut = await get(
    `SELECT m.*, i.name AS inventory_name, i.category AS inventory_category, i.unit AS inventory_unit,
            i.photo_url AS inventory_photo_url, i.quantity AS inventory_quantity
       FROM event_materials m
       LEFT JOIN inventory i ON i.id = m.inventory_id
      WHERE m.id = ?`,
    [mid],
  );
  return c.json({ material: publicMaterial(rowOut) });
});

events.delete('/:id/materials', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  // Refund every item's net consumption back to inventory before wiping.
  const rows = await all(
    'SELECT inventory_id, quantity, returned_quantity FROM event_materials WHERE event_id = ?',
    [eventId],
  );
  await transaction(async () => {
    for (const r of rows) {
      const net = Math.max(0, Number(r.quantity || 0) - Number(r.returned_quantity || 0));
      await adjustInventory(r.inventory_id, net);
    }
    await run('DELETE FROM event_materials WHERE event_id = ?', [eventId]);
  });
  return c.json({ ok: true, refunded: rows.length });
});

events.delete('/:id/materials/:mid', requireDelete(), async (c) => {
  const eventId = Number(c.req.param('id'));
  const mid = Number(c.req.param('mid'));
  const existing = await get(
    'SELECT * FROM event_materials WHERE id = ? AND event_id = ?',
    [mid, eventId],
  );
  if (!existing) return c.json({ error: 'Material not found' }, 404);
  await transaction(async () => {
    // Refund the net consumption (still at the event) back to inventory.
    const net = Math.max(0, Number(existing.quantity || 0) - Number(existing.returned_quantity || 0));
    await adjustInventory(existing.inventory_id, net);
    await run('DELETE FROM event_materials WHERE id = ?', [mid]);
  });
  return c.json({ ok: true });
});

// ----- calculator -----------------------------------------------------------

events.post('/:id/calculate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(calculate({
    total_workers: body.total_workers,
    supervisor_count: body.supervisor_count,
    num_pm_teams: body.num_pm_teams,
  }));
});

export default events;