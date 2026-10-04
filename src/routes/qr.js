// routes/qr.js — QR code generation for inventory items.
//
// Strategy: QRs are cached in D1 (qr_png BLOB + qr_payload TEXT) per item.
//   - GET  /api/qr/inventory/:id/qr          — returns PNG for one item
//                                                (regenerates on first request, then cached)
//   - /api/qr/inventory/all                 — DEPRECATED. Use /api/qr/inventory/batch
//   - GET  /api/qr/inventory/batch?from=ID&limit=25
//                                              — generates up to 25 QRs at a time,
//                                                stores in D1, returns summary.
//                                                Call repeatedly until "remaining=0".
//   - POST /api/qr/inventory/regenerate      — wipes cache so all QRs get rebuilt
//                                                (e.g. after payload scheme changes)
import { Hono } from 'hono';
import QRCode from 'qrcode/lib/server.js';
import { all, get, run } from '../lib/db.js';
import { authRequired, requireSuperAdmin } from '../middleware/auth.js';

const qr = new Hono();
qr.use('*', authRequired());

function fileHeaders(c, filename, mime) {
  c.header('Content-Type', mime);
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');
}

async function generateQrPng(payload) {
  const buf = await QRCode.toBuffer(payload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function payloadFor(item) {
  return item.barcode || `id:${item.id}`;
}

function pngFromBlob(blob) {
  // D1 returns BLOBs as Uint8Array (Workers runtime).
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

// GET /api/qr/inventory/:id/qr — single QR (uses cache, generates on miss)
qr.get('/inventory/:id/qr', async (c) => {
  const id = Number(c.req.param('id'));
  const item = await get(
    'SELECT id, name, barcode, qr_png, qr_payload FROM inventory WHERE id = ?',
    [id],
  );
  if (!item) return c.json({ error: 'Not found' }, 404);

  const wanted = payloadFor(item);

  // Cache hit?
  if (item.qr_png && item.qr_payload === wanted) {
    const safeSku = (item.barcode || `item_${id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    fileHeaders(c, `${safeSku}.png`, 'image/png');
    return c.body(pngFromBlob(item.qr_png));
  }

  // Generate + persist
  const png = await generateQrPng(wanted);
  await run(
    'UPDATE inventory SET qr_png = ?, qr_payload = ?, updated_at = updated_at WHERE id = ?',
    [png, wanted, id],
  );
  const safeSku = (item.barcode || `item_${id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  fileHeaders(c, `${safeSku}.png`, 'image/png');
  return c.body(png);
});

// GET /api/qr/inventory/batch?from=ID&limit=25
//   - Finds items without qr_png or with stale qr_payload
//   - Generates up to `limit` QRs (default 25)
//   - Returns summary; repeat until remaining=0
qr.get('/inventory/batch', async (c) => {
  const q_ = c.req.query();
  const from = Number(q_.from_id || 0);
  const limit = Math.min(Number(q_.limit || 25), 50); // cap at 50/CPU bound
  const category = q_.category ? String(q_.category) : null;

  // Find candidate items: either no qr_png OR qr_payload doesn't match current payload
  // Simpler: just fetch items where qr_png IS NULL (anything with a cache hit is skipped).
  // We rebuild payload key from barcode + id and compare to qr_payload — if different, regen.
  const params = [from];
  let where = 'id > ?';
  if (category) { where += ' AND category LIKE ?'; params.push(`${category}%`); }
  const items = await all(
    `SELECT id, name, barcode FROM inventory WHERE ${where}
       AND qr_png IS NULL
     ORDER BY id ASC LIMIT ?`,
    [...params, limit],
  );

  const processed = [];
  for (const it of items) {
    const payload = payloadFor(it);
    try {
      const png = await generateQrPng(payload);
      await run(
        'UPDATE inventory SET qr_png = ?, qr_payload = ? WHERE id = ?',
        [png, payload, it.id],
      );
      processed.push({ id: it.id, name: it.name, payload });
    } catch (e) {
      processed.push({ id: it.id, name: it.name, error: e.message });
    }
  }

  // Total remaining without cache (rough)
  const remRow = await get(
    category
      ? 'SELECT COUNT(*) AS n FROM inventory WHERE qr_png IS NULL AND category LIKE ?'
      : 'SELECT COUNT(*) AS n FROM inventory WHERE qr_png IS NULL',
    category ? [`${category}%`] : [],
  );
  const remaining = remRow ? Number(remRow.n) : 0;

  return c.json({
    processed: processed.length,
    remaining,
    next_from_id: processed.length ? String(processed[processed.length - 1].id) : null,
    items: processed,
  });
});

// POST /api/qr/inventory/regenerate  — wipe cache so all QRs rebuild
qr.post('/inventory/regenerate', requireSuperAdmin(), async (c) => {
  await run('UPDATE inventory SET qr_png = NULL, qr_payload = NULL', []);
  return c.json({ ok: true, message: 'QR cache cleared — call /api/qr/inventory/batch to rebuild' });
});

export default qr;