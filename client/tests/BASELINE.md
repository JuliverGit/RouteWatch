# RouteWatch frontend baseline

The reference point for the frontend refactor. A refactoring phase should keep every result below unless a change is intended.

## Run the tests

```powershell
cd client
npm run test:smoke             # all suites
npm run test:smoke -- roles    # one suite
npm run build
```

Needs PostgreSQL running with the migrated database, `server/.env`, and Microsoft Edge (`EDGE_PATH` if it is not in the default
location). No test dependency is installed.

The tests start their own API (:5098) and client (:5175), refuse a non-local database or `NODE_ENV=production`, and use temporary
`rwt-*` accounts that are deleted afterwards. Their audit rows stay, because `audit_logs` is append-only.

## Baseline (application code of commit `cdec670`)

Recorded 2026-11-24 on Windows 11, Node 24.15.0, Microsoft Edge 158.0.4370.33, PostgreSQL 16.16.

### Production build: passed

| Output | Size | Gzip |
|---|---:|---:|
| `index.html` | 0.35 kB | 0.26 kB |
| `assets/index-D8Xvjvng.css` | 42.04 kB | 12.34 kB |
| `assets/index-CEHcU-G2.js` | 485.71 kB | 141.67 kB |

### Smoke tests: 117 passed, 0 failed, 2 known issues reproduced

| Area | Covered |
|---|---|
| Server authorization | 17 read endpoints and 9 refused write endpoints, per role; dashboard data tiers; no private fields in the user list |
| Admin, Dispatcher, Conductor, Passenger, Guest | Real sign-in (guest entry), exact menu, every allowed page, role-specific map panels, live marker updates, one Socket.IO connection, no JavaScript errors |
| Members | Session survives a refresh; log out; still signed out after a refresh |
| Passenger | No location request before consent, blue dot, Nearby Buses list |

Not covered: a conductor **assigned** to a bus (the test conductor is unassigned, so real assignments are not disturbed), real Google
sign-in, real email delivery, Firefox, Safari, and physical phones.

### Known issues (reproduced, not fixed)

1. Returning to the Live map replays the last "show on map" alert focus.
2. After log out, the next user in the same tab inherits the previous user's map focus. Cause: `mapFocus` in `App` is not cleared.
