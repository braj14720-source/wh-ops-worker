// routes/exports.js — CSV + XLSX exports for every module (Hono router).
//
// ExcelJS is included (Workers free tier allows 64 MiB uncompressed bundle).
// CSVs are the default; XLSX endpoints are kept for parity with the old backend.
import { Hono } from 'hono';
import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import { all } from '../lib/db.js';
import { authRequired } from '../middleware/auth.js';

const exportsRoute = new Hono();
exportsRoute.use('*', authRequired());

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ISO_TS = new Date().toISOString().slice(0, 10);

function fileHeaders(c, filename, mime) {
  c.header('Content-Type', mime);
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  return stringify(rows, { header: true });
}

async function rowsToXlsxBuffer(sheetName, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WH-OPS';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  if (rows.length) {
    ws.columns = Object.keys(rows[0]).map((key) => ({
      header: key,
      key,
      width: Math.min(48, Math.max(12, key.length + 4)),
    }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' },
    };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  // ExcelJS returns a Promise<ArrayBuffer> in browser-like environments (incl. Workers)
  return await wb.xlsx.writeBuffer();
}

// --- Inventory ---
exportsRoute.get('/inventory.csv', async (c) => {
  const items = await all('SELECT * FROM inventory ORDER BY name ASC');
  const rows = items.map((i) => ({
    name: i.name,
    category: i.category || '',
    unit: i.unit || '',
    quantity: i.quantity,
    unit_price: i.unit_price,
    supplier: i.supplier || '',
    notes: i.notes || '',
  }));
  fileHeaders(c, `inventory-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(rows));
});

exportsRoute.get('/inventory.xlsx', async (c) => {
  const items = await all('SELECT * FROM inventory ORDER BY name ASC');
  const rows = items.map((i) => ({
    Name: i.name,
    Category: i.category || '',
    Unit: i.unit || '',
    Quantity: i.quantity,
    'Unit Price (INR)': i.unit_price,
    Supplier: i.supplier || '',
    Notes: i.notes || '',
  }));
  const buf = await rowsToXlsxBuffer('Inventory', rows);
  fileHeaders(c, `inventory-${ISO_TS}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

// --- Labor ---
exportsRoute.get('/labor.csv', async (c) => {
  const items = await all('SELECT * FROM labor ORDER BY active DESC, name ASC');
  const rows = items.map((l) => ({
    name: l.name,
    role: l.role || '',
    phone: l.phone || '',
    daily_wage: l.daily_wage,
    active: l.active === 1 ? 'yes' : 'no',
    notes: l.notes || '',
  }));
  fileHeaders(c, `labor-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(rows));
});

exportsRoute.get('/labor.xlsx', async (c) => {
  const items = await all('SELECT * FROM labor ORDER BY active DESC, name ASC');
  const rows = items.map((l) => ({
    Name: l.name,
    Role: l.role || '',
    Phone: l.phone || '',
    'Daily Wage (INR)': l.daily_wage,
    Active: l.active === 1 ? 'yes' : 'no',
    Notes: l.notes || '',
  }));
  const buf = await rowsToXlsxBuffer('Labor', rows);
  fileHeaders(c, `labor-${ISO_TS}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

// --- Vehicles ---
exportsRoute.get('/vehicles.csv', async (c) => {
  const items = await all('SELECT * FROM vehicles ORDER BY updated_at DESC');
  const rows = items.map((v) => ({
    vehicle_no: v.vehicle_no,
    driver_name: v.driver_name || '',
    from_location: v.from_location || '',
    to_location: v.to_location || '',
    purpose: v.purpose || '',
    status: v.status,
    departed_at: v.departed_at || '',
    arrived_at: v.arrived_at || '',
    notes: v.notes || '',
  }));
  fileHeaders(c, `vehicles-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(rows));
});

exportsRoute.get('/vehicles.xlsx', async (c) => {
  const items = await all('SELECT * FROM vehicles ORDER BY updated_at DESC');
  const rows = items.map((v) => ({
    'Vehicle No': v.vehicle_no,
    Driver: v.driver_name || '',
    From: v.from_location || '',
    To: v.to_location || '',
    Purpose: v.purpose || '',
    Status: v.status,
    'Departed At': v.departed_at || '',
    'Arrived At': v.arrived_at || '',
    Notes: v.notes || '',
  }));
  const buf = await rowsToXlsxBuffer('Vehicles', rows);
  fileHeaders(c, `vehicles-${ISO_TS}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

// --- Attendance (raw log) ---
function buildAttendanceRows(rows) {
  return rows.map((r) => ({
    date: r.date,
    worker: r.worker,
    role: r.role || '',
    status: r.status,
    ot_hours: r.ot_hours,
    daily_wage: r.daily_wage,
    earned_inr:
      r.status === 'present' ? r.daily_wage
        : r.status === 'half_day' ? r.daily_wage / 2
        : 0,
    notes: r.notes || '',
  }));
}

function buildAttendanceXlsxRows(rows) {
  return rows.map((r) => ({
    Date: r.date,
    Worker: r.worker,
    Role: r.role || '',
    Status: r.status,
    'OT Hours': r.ot_hours,
    'Daily Wage (INR)': r.daily_wage,
    'Earned (INR)':
      r.status === 'present' ? r.daily_wage
        : r.status === 'half_day' ? r.daily_wage / 2
        : 0,
    Notes: r.notes || '',
  }));
}

async function fetchAttendanceRows(q_) {
  const clauses = [];
  const params = [];
  if (q_.from)     { clauses.push('a.date >= ?'); params.push(q_.from); }
  if (q_.to)       { clauses.push('a.date <= ?'); params.push(q_.to); }
  if (q_.labor_id) { clauses.push('a.labor_id = ?'); params.push(Number(q_.labor_id)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return await all(
    `SELECT a.date, l.name AS worker, l.role, a.status,
            a.overtime_hours AS ot_hours, l.daily_wage, a.notes
     FROM attendance a
     JOIN labor l ON l.id = a.labor_id
     ${where}
     ORDER BY a.date DESC, l.name`,
    params,
  );
}

exportsRoute.get('/attendance.csv', async (c) => {
  const rows = buildAttendanceRows(await fetchAttendanceRows(c.req.query()));
  fileHeaders(c, `attendance-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(rows));
});

exportsRoute.get('/attendance.xlsx', async (c) => {
  const rows = buildAttendanceXlsxRows(await fetchAttendanceRows(c.req.query()));
  const buf = await rowsToXlsxBuffer('Attendance', rows);
  fileHeaders(c, `attendance-${ISO_TS}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

// --- Payroll summary (per worker over a period) ---
function computePayrollRow(l, rows) {
  let full = 0, half = 0, absent = 0, ot = 0;
  for (const r of rows) {
    if (r.status === 'present') full++;
    else if (r.status === 'half_day') half++;
    else if (r.status === 'absent') absent++;
    ot += r.overtime_hours || 0;
  }
  const base = l.daily_wage * (full + 0.5 * half);
  const otRate = Math.round(l.daily_wage / 8);
  const overtime = ot * otRate;
  return { full, half, absent, ot, base, overtime, total: base + overtime };
}

async function buildPayrollSummaries(q_) {
  const dateClauses = [];
  const dateParams = [];
  if (q_.from) { dateClauses.push('date >= ?'); dateParams.push(q_.from); }
  if (q_.to)   { dateClauses.push('date <= ?'); dateParams.push(q_.to); }

  const workers = await all('SELECT * FROM labor ORDER BY name');
  const attSql = `SELECT * FROM attendance WHERE ${[...dateClauses, 'labor_id = ?'].join(' AND ')}`;
  const summaries = [];
  for (const l of workers) {
    const rows = await all(attSql, [...dateParams, l.id]);
    const c_ = computePayrollRow(l, rows);
    summaries.push({ worker: l, computed: c_ });
  }
  return summaries;
}

function payrollToCsvRow({ worker: l, computed: c_ }) {
  return {
    worker: l.name,
    role: l.role || '',
    phone: l.phone || '',
    daily_wage: l.daily_wage,
    full_days: c_.full,
    half_days: c_.half,
    absent_days: c_.absent,
    overtime_hours: c_.ot,
    base_inr: c_.base,
    overtime_inr: c_.overtime,
    total_payout_inr: c_.total,
  };
}

function payrollToXlsxRow({ worker: l, computed: c_ }) {
  return {
    Worker: l.name,
    Role: l.role || '',
    Phone: l.phone || '',
    'Daily Wage (INR)': l.daily_wage,
    'Full Days': c_.full,
    'Half Days': c_.half,
    'Absent Days': c_.absent,
    'Overtime Hours': c_.ot,
    'Base (INR)': c_.base,
    'Overtime (INR)': c_.overtime,
    'Total Payout (INR)': c_.total,
  };
}

exportsRoute.get('/payroll.csv', async (c) => {
  const q_ = c.req.query();
  const summaries = await buildPayrollSummaries(q_);
  fileHeaders(c, `payroll-${q_.from || 'all'}-to-${q_.to || 'all'}.csv`, 'text/csv');
  return c.body(rowsToCsv(summaries.map(payrollToCsvRow)));
});

exportsRoute.get('/payroll.xlsx', async (c) => {
  const q_ = c.req.query();
  const summaries = await buildPayrollSummaries(q_);
  const buf = await rowsToXlsxBuffer('Payroll', summaries.map(payrollToXlsxRow));
  fileHeaders(c, `payroll-${q_.from || 'all'}-to-${q_.to || 'all'}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

// --- Events ---
exportsRoute.get('/events.csv', async (c) => {
  const items = await all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
  const rows = items.map((e) => ({
    id: e.id,
    name: e.name,
    date: e.date || '',
    location: e.location || '',
    client_name: e.client_name || '',
    customer_phone: e.customer_phone || '',
    project_manager: e.project_manager || '',
    project_executive: e.project_executive || '',
    consultant: e.consultant || '',
    status: e.status,
    total_workers: e.total_workers,
    num_source_teams: e.num_source_teams,
    num_pm_teams: e.num_pm_teams,
    notes: e.notes || '',
    created_at: e.created_at,
  }));
  fileHeaders(c, `events-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(rows));
});

exportsRoute.get('/events.xlsx', async (c) => {
  const items = await all('SELECT * FROM events ORDER BY date DESC, created_at DESC');
  const rows = items.map((e) => ({
    Name: e.name,
    Date: e.date || '',
    Location: e.location || '',
    Client: e.client_name || '',
    'Customer Phone': e.customer_phone || '',
    'Project Manager': e.project_manager || '',
    'Project Executive': e.project_executive || '',
    Consultant: e.consultant || '',
    Status: e.status,
    'Total Workers': e.total_workers,
    'Source Teams': e.num_source_teams,
    'PM Teams': e.num_pm_teams,
    Notes: e.notes || '',
    Created: e.created_at,
  }));
  const buf = await rowsToXlsxBuffer('Events', rows);
  fileHeaders(c, `events-${ISO_TS}.xlsx`, XLSX_MIME);
  return c.body(buf);
});

exportsRoute.get('/event-allocations.csv', async (c) => {
  const rows = await all(
    `SELECT a.*,
            e.name         AS event_name,
            e.date         AS event_date,
            l.name         AS labor_name,
            l.role         AS labor_role,
            st.name        AS source_team_name
       FROM event_allocations a
       JOIN events e ON e.id = a.event_id
       LEFT JOIN labor l ON l.id = a.labor_id
       LEFT JOIN event_source_teams st ON st.id = a.source_team_id
      ORDER BY e.date DESC, a.pm_team ASC, l.name ASC`,
  );
  const out = rows.map((r) => ({
    event: r.event_name,
    event_date: r.event_date || '',
    labor: r.labor_name || '',
    role: r.labor_role || '',
    source_team: r.source_team_name || '',
    pm_team: r.pm_team == null ? '' : r.pm_team,
    alloc_role: r.role,
    notes: r.notes || '',
  }));
  fileHeaders(c, `event-allocations-${ISO_TS}.csv`, 'text/csv');
  return c.body(rowsToCsv(out));
});

export default exportsRoute;