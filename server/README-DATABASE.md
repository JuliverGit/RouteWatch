# RouteWatch – PostgreSQL database

RouteWatch keeps its persistent business data in PostgreSQL (users, sessions, buses, tracking devices,
bus stops, routes, route–stop order, bus–route assignments, audit log). The React client is unchanged and
never talks to the database; only the Node server does, with credentials read from environment variables.

## 1. Install PostgreSQL (version 14 or newer; tested on 16)

- Windows: installer from postgresql.org (keep the default port 5432, remember the `postgres` password).
- Ubuntu/Debian: `sudo apt install postgresql`
- macOS: `brew install postgresql@16 && brew services start postgresql@16`

## 2. Install the server dependencies

```
cd server
npm install        # adds "pg" (database driver) and "dotenv" (reads .env)
```

## 3. Create the database and two accounts

Two accounts keep the running web server at least privilege: an **owner** (creates tables, runs
migrations/import) and an **app** account (what `npm start` uses; it cannot create/drop tables and can only
INSERT/SELECT in `audit_logs`). Open `psql` as the `postgres` superuser and run (choose your own passwords –
do **not** reuse the placeholders):

```sql
CREATE ROLE routewatch_owner LOGIN PASSWORD '<choose-a-strong-password>';
CREATE ROLE routewatch_app   LOGIN PASSWORD '<choose-another-strong-password>';
CREATE DATABASE routewatch OWNER routewatch_owner;
REVOKE ALL ON DATABASE routewatch FROM PUBLIC;
GRANT CONNECT ON DATABASE routewatch TO routewatch_app;
```

## 4. Configure the environment

```
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `.env` and fill in `DB_PASSWORD` and `MIGRATE_DB_PASSWORD` with the passwords from step 3.
`.env` is in `.gitignore` – never commit it, never paste it into chat or screenshots.
For a database on another machine/host set `DB_SSL=verify-full` and `DB_SSL_CA=<path to CA certificate>`
(default is TLS **off** only for localhost and `require` for any other host).

## 5. Create the tables (migration)

```
npm run db:migrate
```

Applies `migrations/NNN_*.sql` once each (recorded in `schema_migrations` with a checksum; an already-applied
file that was edited is refused) and grants the app account its limited rights. Safe to run again.

## 6. Import the existing JSON data (only if you have data from the old version)

```
npm run db:import -- --dry-run     # validate only: prints what would be imported/corrected, writes nothing
npm run db:import                  # real import
npm run db:import -- --dir <folder>   # read the JSON files from another folder (default: server/data)
```

What it does, in order: (1) **backup** of every source file to `data/backups/pre-postgres-<time>/` with a
SHA-256 manifest; (2) **validation** – invalid rows are rejected or corrected by a fixed, documented policy;
(3) **load** in ONE transaction (all-or-nothing; existing rows are never overwritten); (4) **verification** –
counts, bcrypt password hashes, field values and relationships are compared with the source; (5) writes
`import-report.json` next to the backup. The original JSON files are **never modified or deleted**.

Correction policy (all listed in the report, nothing is dropped silently):

| Situation | Action |
|---|---|
| invalid/duplicate id or username, no valid bcrypt hash, bad coordinates, bad token hash | row **rejected** (reported) |
| unknown role | imported as **inactive passenger** (quarantine) |
| duplicate stop/route name | renamed with a `(ID)` suffix |
| bad status | set to `inactive` |
| bad capacity / plate / model | emptied |
| stop order with gaps/duplicates | renumbered 1..n |
| device pointing at an unregistered bus | bus record created |
| audit lines | imported only into an EMPTY `audit_logs`, secret-like keys scrubbed, damaged lines skipped and reported |

If the import fails verification, nothing is committed.

## 7. Create the first admin, start, verify

```
npm run seed-user            # asks for username / role / password (needed only for a brand-new database)
npm start                    # server on http://localhost:5000
npm run db:check             # prints target (no password), versions, privilege checks and row counts
```

On first start with an empty network the server seeds route R-01 and its stops (same as the old version).
At startup the server checks the connection and that the schema version matches; if not it exits with a
clear message instead of running half-broken. In another terminal: `cd ../client && npm run dev`.

## 8. Backup and recovery

```
pg_dump -Fc -h localhost -U routewatch_owner -d routewatch -f routewatch-YYYYMMDD.dump
# restore into an EMPTY database (create it as in step 3):
pg_restore -h localhost -U routewatch_owner -d routewatch --no-owner routewatch-YYYYMMDD.dump
npm run db:migrate       # re-applies the least-privilege grants for the app account
npm run db:check
```

Store dumps off the server and treat them as secret (they contain password hashes and the audit log).
Schedule `pg_dump` (cron / Task Scheduler) and test a restore periodically.

## 9. Tables

| Table | Purpose |
|---|---|
| `users` | accounts: username (PK), bcrypt `password_hash`, role (admin/dispatcher/conductor/passenger), active flag, timestamps |
| `sessions` | login sessions; only the SHA-256 of the token is stored; expiry; deleted with the user |
| `buses` | fleet: bus_id (PK), name, plate (unique, case/space-insensitive), capacity 1–120, model, status; `passenger_count` (NULL = not reported, CHECK 0 ≤ count ≤ capacity) and `occupancy_updated_at` (migration 002) |
| `tracking_devices` | simulated/real GPS devices: bus FK, source, active, token hash; at most one active device per bus |
| `stops` | bus stops: unique name, coordinates (range-checked), status |
| `routes` | routes: unique name, start/destination, status |
| `route_stops` | ordered stops of a route: PK (route, stop), unique position per route (deferrable so reorder works) |
| `conductor_assignments` | which conductor counts which bus (migration 002): conductor is the PK, bus is UNIQUE, so one bus per conductor and one conductor per bus; only an active conductor account on an active bus (trigger) |
| `bus_route_assignments` | one route per bus (bus_id is the PK); only an active bus on an active route (trigger) |
| `service_alerts` | service alerts (migration 003): title, description, category, severity, audience (public/staff), status draft/published/resolved, optional bus / route / stop (foreign keys), expiry, who created/published/resolved. Never deleted; "expired" is computed, not stored |
| `notifications` | one row per (user, alert): who was told about which alert and when they read it (`read_at`). Written by the server when an alert is published; the web account can change only `read_at` |
| `audit_logs` | append-only security/activity trail (UPDATE/DELETE blocked by trigger and by privileges) |
| `schema_migrations` | which migration files were applied (checksum guard) |

Migration 002 (passenger occupancy) adds one table and two columns; it changes no existing row (tested on a database holding users, buses, routes, stops and audit entries: every count was identical before and after).

Not created on purpose: a roles/permissions table (permissions are a fixed code table in `permissions.js`,
the DB only constrains the role value), a GPS history table (not required yet), a notifications table
(added in Phase 7 as `migrations/003_service_alerts.sql`).

## 10. What is still not in PostgreSQL

- **Latest bus positions** – in memory only: they change every 2 s and are meaningless after a restart.
  A bus shows as "no signal" until it reports again. A history table can be added later if needed.
- `data/sim.json` (simulator device tokens), `data/route-cache.json` (cached OSRM road path) – local
  runtime files, git-ignored.
- The old `users.json`, `buses.json`, `devices.json`, `network.json`, `audit.log` are no longer read by the
  server. Keep them until you are satisfied with the import; they are never touched by RouteWatch.

## 11. Troubleshooting

| Message | Meaning |
|---|---|
| `[db] cannot start: ...` at startup | PostgreSQL not running, wrong host/port/user/password, or TLS mismatch (`DB_SSL`); the server exits |
| `the database schema is out of date (version X, needs Y)` | run `npm run db:migrate` |
| API returns `503 The service is temporarily unavailable` | database unreachable while running; the technical details are only in the server log, never sent to the browser |

## 12. Passenger occupancy and the conductor role (migration 002)

```
npm run db:migrate          # applies 002_occupancy.sql once; safe to repeat; existing data is not touched
npm run seed-user -- cond1 conductor     # a conductor account (asks for a password)
```

Then, as administrator in the app:
1. **Buses** page: every bus that will be counted needs a **capacity** (the counter refuses a bus without one).
2. **Users** page: the new "Assigned bus" column appears for conductor accounts. One conductor counts one bus at a time and a bus has one conductor at a time.
3. The conductor signs in (phone is fine) and lands on **Passenger counter**: **Boarded** (+1), **Got off** (-1), and "Start new trip" (reset to 0).

Rules enforced by the server and by the database:
- Only the conductor assigned to a bus can change its count. Administrators and dispatchers can watch it but cannot change it.
- The browser says what happened ("board", "alight", "reset"); the server works out the new number inside a transaction with the bus row locked. The count can never go below 0 or above the capacity, even with many simultaneous taps.
- **NULL = "not reported"**: a bus without a conductor, or before the first tap, shows "Not reported", never a made-up 0. A bus that leaves service, or gets a different conductor, goes back to "not reported".
- An administrator cannot lower a bus's capacity below the passengers currently counted on it.
- Every change is in the audit log (`occupancy_board`, `occupancy_alight`, `occupancy_reset`, `occupancy_rejected`, `conductor_assigned`, `conductor_unassigned`, ...).
- Optional setting `OCCUPANCY_MAX_PER_MINUTE` (default 120 taps per conductor per minute).
- The old random "Empty / Few seats / Full" label that the simulator invented has been removed; only real counts are shown.

### Conductor dashboard and "MY BUS" (no database change)

After signing in a conductor lands on a **Dashboard** (assigned bus, plate, capacity, route, passengers, tracking), with **Passenger counter** and **Live map** in the menu. On the map the conductor's bus is marked **MY BUS**; "View my bus on Live Map" centres on it. Everything is read from the signed-in session and PostgreSQL through `GET /api/conductor/bus`; no migration is needed. Counting is still done only on the Passenger counter page.

## 13. Service alerts and notifications (migration 003, Phase 7)

```
npm run db:migrate          # applies 003_service_alerts.sql once; safe to repeat; existing data is not touched
```

No new package and no new account is needed. Optional settings in `.env`: `ALERT_MAX_PER_MINUTE` (default 30 alert changes per user per minute) and `SOCKET_RECHECK_SECONDS` (default 60; how often live connections are checked against the database so an ended session stops receiving).

**Who may do what**
- Administrator: create, edit, publish and resolve every alert. Dispatcher: the same for operational categories (bus delay, route disruption, route change, stop closure, service interruption); general announcements are administrator-only. Conductors and passengers cannot create, change, publish or delete anything (the server answers 403).
- An alert starts as a **draft** (nobody is notified). **Publish** makes it active and creates the notifications in the same database transaction. **Resolve** ends it (a draft can be discarded the same way). A published alert's title, category, audience and links can no longer change; its description, severity and expiry can. Resolved alerts are read-only history. An alert whose expiry time has passed is shown as **expired** and is never listed as active.

**Who is notified** (decided on the server from the database, never from the browser)
- Administrators and dispatchers: every published alert except their own.
- Conductors: general alerts, and alerts about their assigned bus, that bus's route, or a stop on that route.
- Passengers: public alerts only. There are no passenger subscriptions in RouteWatch, so every public alert reaches every active passenger account. Visitors without an account see public alerts on the map and dashboard.
- Inactive accounts are never notified. Offline users find their notifications (and read state) in PostgreSQL when they sign in again.

**Real time**: after the commit the server sends a `notification` event only to the recipient's own Socket.IO room (`user:<username>`, joined from the server-side session). A content-free `alerts:changed` event tells every open page to reload what it is allowed to see. Browsers cannot publish or join rooms.

**Undo (only if ever needed; this deletes every alert and notification, so take a `pg_dump` first)** — run as the owner account:
```
DROP TABLE notifications; DROP TABLE service_alerts;
DROP FUNCTION rw_alert_guard(); DROP FUNCTION rw_notification_guard();
DELETE FROM schema_migrations WHERE version = 3;
```
Then use the previous version of the code. `npm run db:migrate` re-applies 003 cleanly later.

## 14. Accounts: registration, password recovery, Google sign-in (migration 004)

```
npm run db:migrate          # applies 004_account_auth.sql once; existing users, passwords, roles and assignments are not changed
```

**What it adds**: `users.email` / `email_verified_at` / `google_sub` (all empty for existing accounts), `sessions.last_seen_at`
(idle expiry), and two short-lived tables: `pending_registrations` (sign-ups waiting for their email code) and
`password_reset_codes`. `password_hash` may now be empty for accounts created with Google; a CHECK requires every account to
have a password or a Google identity.

**Rules**
- Public sign-up (email or Google) always creates a **passenger**. Staff roles are still given only by an administrator.
- Email sign-up: the account is created only after the 6-digit code sent to the address is entered (together with the chosen password).
- Codes: random, stored as bcrypt hashes, valid 10 minutes, single use, 5 attempts; at most 1 per minute and 5 per hour per address.
- Answers about email addresses never reveal whether an account exists; the address owner is informed by email instead.
- Google: identified by Google's `sub` id. An existing account with the same email is **not** linked automatically (sign-in is refused with an explanation).
- Password recovery ends every session of the account. Accounts without an email (all accounts that existed before 004) are reset by an administrator with `npm run reset-password -- <username>`.
- Sessions end after `SESSION_MINUTES` (default 120) or `SESSION_IDLE_MINUTES` without user activity (default 30). Automatic page polling is not activity; clicks, typing, scrolling, taps and saved changes are.

**Settings** (`server/.env`, see `.env.example`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`; email delivery
`MAIL_TRANSPORT=smtp` + `SMTP_*` + `MAIL_FROM` (needs `npm install --save-exact nodemailer@10.3.1`). Without SMTP, development uses
`dev-outbox`: messages are written to `server/data/dev-outbox/` instead of being sent (never in production).
