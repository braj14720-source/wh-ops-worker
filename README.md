# WH-OPS Worker

Cloudflare Worker + D1 backend for **WH-OPS** (Panigrahana Weddings · Warehouse · Operations).

Replaces the previous Render-hosted Express backend at `https://decor-ops-api.onrender.com` (now retired/dormant).

## Live URLs

- **API**: https://wh-ops-api.braj14720.workers.dev
- **Frontend (PWA)**: https://qp0hlmpdi65fd.space.minimax.io
- **DB**: Cloudflare D1 `wh-ops` in APAC region, ID `26bca281-a7ca-47c6-9b55-383036232ad9`

## Cloudflare account

- Account ID: `6dc2f0f837c444e9219fdfc6443782e5` (braj14720@gmail.com)
- API token: see `~/tools/gh` or a password manager — never commit this

## Project structure

```
worker/
├── src/
│   ├── index.js              # Hono app entry + Worker fetch handler
│   ├── lib/db.js             # D1 adapter (run/get/all/exec/transaction)
│   ├── middleware/auth.js    # JWT + role guards (super_admin / admin / employee / in_house_labour)
│   └── routes/
│       ├── auth.js           # POST /signup (disabled), /login, GET /me
│       ├── users.js          # CRUD for users (requireManagement)
│       ├── inventory.js      # CRUD + barcode lookup
│       ├── labor.js          # Worker profiles
│       ├── attendance.js     # Daily attendance + salary summary
│       ├── vehicles.js       # Trip logs
│       ├── events.js         # Events + labour allocation + materials checklist (10 statuses)
│       ├── exports.js        # CSV + XLSX exports for every module
│       ├── import.js         # Google Sheets CSV import (preview + confirm)
│       ├── backups.js        # SQL dumps persisted in D1, optional R2 upload
│       ├── settings.js       # Per-user notification settings
│       └── push.js           # Device token registration (FCM stub)
├── schema.sql                # DDL — 12 tables, applied via `wrangler d1 execute`
├── wrangler.toml             # Worker config + D1 binding + env vars
├── package.json              # hono, bcryptjs, jsonwebtoken, csv-parse, csv-stringify, exceljs
└── README.md                 # this file
```

## Local dev

```bash
npm install
npx wrangler dev              # local emulator with hot reload
npx wrangler d1 execute wh-ops --file=schema.sql        # apply schema to local D1
```

## Deploy

```bash
# Make sure CLOUDFLARE_API_TOKEN is in your shell or .env
export CLOUDFLARE_API_TOKEN=...
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler d1 execute wh-ops --file=schema.sql --remote
```

## Schema

12 tables in SQLite-compatible SQL: users, inventory, user_settings, device_tokens, labor, attendance, vehicles, events, event_source_teams, event_materials, event_allocations, backups.

Run `wrangler d1 execute wh-ops --file=schema.sql --remote` after deploy to ensure schema is current.

## Environment

**Vars (in `wrangler.toml`):**
- `ALLOWED_LOGIN_EMAILS` — comma-separated allowlist (DB-existence fallback)
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist (empty = allow all)
- `DISABLE_PUBLIC_SIGNUP` — `'true'` keeps `/api/auth/signup` returning 403
- `JWT_EXPIRES_IN` — `'30d'` default
- `BOOTSTRAP_OWNER_NAME` — display name on first-boot super_admin

**Secrets (set via `wrangler secret put`):**
- `JWT_SECRET` — 64-char hex string, used to sign all tokens
- `BOOTSTRAP_OWNER_EMAIL` — super_admin email created on first request if users table empty
- `BOOTSTRAP_OWNER_PASSWORD` — bcrypt-hashed on bootstrap

**Bindings:**
- `DB` — D1 database `wh-ops`
- `R2` (optional) — R2 bucket for remote backups (POST /api/backups with `{upload:true}`)

## Smoke tests

```bash
cd .. # back to project root
API_BASE=https://wh-ops-api.braj14720.workers.dev bash test/smoke.sh
```

Last full run: **85 / 85 green** (login, CRUD, XLSX/CSV, materials, calculator, backups, CORS).