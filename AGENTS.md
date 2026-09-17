# Repository operating rules

These rules apply to every agent and contributor working in this repository.

## Sources of truth

Before starting any significant task, read the relevant root-level truth files:

- `PROJECT_STATE.md` for current status, decisions, risks, and verification.
- `ARCHITECTURE.md` for component boundaries and data flow.
- `DATABASE.md` for PostgreSQL/Supabase schema, migrations, RLS, and data safety.
- `WORKFLOWS.md` for user, development, and CI workflows.
- `SECURITY.md` for the threat model and mandatory controls.
- `DEPLOYMENT.md` for Windows, Docker, Supabase, and release procedures.
- `CHANGELOG.md` for significant repository changes.

At the end of every significant task, update every truth file affected by the work. Do not mark work complete while those files contradict the code, migrations, tests, or deployment configuration. Add a dated entry to `CHANGELOG.md` for user-visible, architectural, security, database, or operational changes.

## Safety and compatibility

- Preserve the Arabic RTL interface, map, boxes, search, images, QR/barcode behavior, inventory source files, and established workflows unless a task explicitly authorizes a change.
- Treat `warehouse-project/inputs`, committed migrations, and audit/loan history as append-only source records. Never run destructive migrations or mutate production data as part of routine development.
- Create database migrations with the Supabase CLI; do not edit migrations that have already been applied. Test schema behavior against an isolated database before any remote operation.
- Keep `SUPABASE_SERVICE_ROLE_KEY`, secret API keys, passwords, setup tokens, and session tokens out of browser code, Docker build arguments, logs, fixtures, and Git history.
- The browser may use only a Supabase publishable/legacy anon key. Privileged database access belongs to the Supabase Edge Function environment.
- Do not deploy the live site or modify `main` unless the task explicitly authorizes both actions.

## Required verification

For a normal code change, run at least:

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

For container or deployment changes, also run `docker compose --env-file .env.example config` and the Docker smoke test documented in `DEPLOYMENT.md` when Docker is available. Record any unavailable tool or unexecuted check in `PROJECT_STATE.md` and the handoff report.
