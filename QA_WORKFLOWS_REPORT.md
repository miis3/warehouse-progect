# Workflow upgrade QA — 2026-09-20

Branch: `codex/production-ready-windows`. Baseline commit: `bdb21524e5af56f7a8c74af39b44815f55553f5c`. No merge/main edits or live UI deployment.

## Environment separation

- `8003`: isolated disposable PGlite QA process with test fixtures only; no remote Supabase calls. This was used for mutating browser journeys.
- `8004`: new local static/proxy server, real existing Supabase staging (`gpiltdkbrryfhwqisioe`). No seed, no fake Auth, no operational data in Node/browser storage. TLS uses the Windows certificate store. Existing `8000` and `8002` processes were not restarted.
- Staging before/after migration: items258, units0, workers0, loans0, audit1. All imported item data remains intact. New settings row has no assumed overdue threshold; maintenance empty.

## Automated verification

- Baseline: install/check PASS, 19/19 tests PASS.
- Upgrade: check PASS, 27/27 tests PASS (Node, PGlite, HTTP, happy-dom, source inventory, RLS/FK, staff permissions and container source boundaries).
- New database coverage: initial stock required atomically; no periodic review; box issue and original snapshot; original members only on return after additional stock; bad-return maintenance links; sound repair; duplicate approvals/returns; stale pending approval under maintenance; worker/keeper/manager permissions; overdue setting and warning acknowledgement; no auto-rejection/auto-closure; immutable audit/maintenance; safe retirement.
- New local-server coverage: no startup API calls/seeding; same-origin Host/Origin boundaries; fixed HTTPS upstream; public key validation; session forwarding; no key in runtime config; forbidden methods.
- PGlite is not a concurrent multi-connection load test. The database uniqueness/lock guarantees are exercised, but production-scale load testing remains separate.

## Actual browser journeys (not just automated DOM tests)

| Scenario | Result |
|---|---|
| Worker sign-in, equipment search and exact location | PASS on8003; existing map/photos preserved |
| Single request → manager approval without retyping condition → worker custody | PASS |
| Bad return → removal from custody → automatic linked maintenance ticket | PASS; worker, receiving manager, return time and note visible |
| Close maintenance → sound/available | PASS |
| Manager overdue setting saved | PASS; 7-day value persisted in isolated QA only |
| One-time initial item data editor | PASS; subsequent UI offers actual added units, no recurring review |
| Whole box of six units → one approval → one custody group with snapshot | PASS |
| Reload/re-login → same whole-box custody | PASS |
| Whole-box return → one common sound condition → all six removed | PASS |
| Worker audit shows individual and box return/approval events | PASS |
| Console errors/warnings in worker and manager journeys | None |
| Overdue elapsed-time fixture and warning/authorization | Automated PostgreSQL PASS; not artificially backdated in operational Supabase |
| Existing Supabase public catalog via8004 | PASS after Windows CA fix; RB-001 originals and photos loaded |
| Real Supabase admin sign-in/mutating workflow | NOT RUN: requires existing admin password and truthful initial stock data; no invented identities/data |

Screenshots were captured in the task: linked maintenance ticket, six-unit box custody, and the pre-fix Windows connection error. No unresolved browser error occurred in the isolated mutating journeys.

## Failures found and resolved

1. New SQL function identifier ambiguity: caught by database/interface tests; corrected and retested before remote migration.
2. Local Node TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE`: fixed with `--use-system-ca`; verified actual Supabase catalog afterward, no TLS bypass.
3. Previous Caddy forwarded only apikey: actual gateway probe returned `401 UNAUTHORIZED_NO_AUTH_HEADER`. Added separate public anon JWT for verified gateway Authorization; never a service-role key. Docker cannot run on this Windows machine; CI validates/builds/smoke-tests the container.
4. Browser selector timing/label lookup during QA: re-observed UI and selected the existing stable inventory control; no product defect or console error.
5. Repeat-run interface test caught a login/map refresh race that could replace a quickly opened box. Login now unlocks only after initial navigation completes; map refresh hides stale interactive content while loading. Full tests and real browser login/search/box-opening were rerun after the fix.

## Remote verification

- Applied original production-index migration and new workflow migration to staging only. Migration metadata matched the original local versions after the tool initially generated application-time IDs; no migration SQL was rewritten.
- `warehouse-api` Edge version2 active, `verify_jwt=true` retained.
- RLS true for both new tables, anon cannot execute warehouse API, service_role cannot execute private core.
- Security advisor: only leaked-password-protection warning. [Remediation and plan requirements](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No paid setting changed.
- Performance advisor: unused-index INFO only, expected without activity; no missing-FK warning. Indexes retained.

## Readiness verdict

Implemented and validated for controlled staging trials. NOT signed off for live production: real authenticated staging journey still needs the owner's existing password, original stock quantities/conditions must be supplied truthfully, overdue threshold must be chosen by the manager, and multi-connection load/target-phone testing remain outstanding. Main and live site were not published.

Start on Windows (Node24): `npm ci --ignore-scripts`, then `npm start`, open `http://127.0.0.1:8004/`. Existing admin username: `admin`; use its current password, not the isolated preview fixture.
