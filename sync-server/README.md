# Ledgr self-hosted sync server

This service provides the server side of Ledgr's offline-first semantic sync protocol. Devices continue to write SQLite locally and retry durable outbox operations; the server assigns an immutable per-book sequence and deduplicates retries by `opId` and `payloadHash`.

## Development mode

Without `DATABASE_URL` and OIDC settings, `npm start` uses the in-memory store and anonymous access. This mode is for protocol tests and local development only:

```sh
npm install
npm test
npm start
```

## Self-hosted PostgreSQL + OIDC mode

Set all of the following in the runtime environment:

- `DATABASE_URL` (PostgreSQL 14+; migrations run automatically at startup)
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` (signed bearer JWT verification)
- `CORS_ORIGIN` (an explicit app origin; wildcard CORS is not accepted in production)
- `NODE_ENV=production`

Optional settings include `PORT`, `HOST`, `DB_POOL_MAX`, `DB_SSL=require`, and `DB_SSL_REJECT_UNAUTHORIZED=false` only for a deliberately configured private CA. Production startup fails closed if the database, OIDC, or CORS settings are missing. The OIDC token must contain a `books` or `book_ids` claim (or `sync:*` scope) for book membership; `scope`/`scp` claims are accepted for pull/push permissions.

The PostgreSQL adapter (`src/postgres.ts`) uses a transaction and row lock per book, enforces the book epoch, device-sequence uniqueness, and aggregate `baseRevision` checks, and stores the complete canonical operation plus `aggregate_revision` in `sync_events`. Pull responses include a deterministic event-history checkpoint hash. `PostgresBookAuthorizer` can enforce the `sync_memberships` table and enroll or reject revoked devices through `sync_devices` (token book/scope claims remain a bootstrap/admin fast path). Apply `migrations/001_sync.sql` through the startup migration runner; take backups and test restore before onboarding real data.

## Accounting arbitration boundary

`DefaultAccountingArbitrator` rejects malformed or unbalanced `journal.create`/`journal.post` operations, actor impersonation, missing revisions for revision-sensitive commands, invalid inventory counts, malformed allocations, invalid location transfers, malformed capital entries, invalid reversals, and period-close operations without a base revision. It remains a deterministic payload baseline: canonical invoice open amounts, inventory availability, capital ownership, location balances, period authority, and audited correction workflows still require domain-state integration behind `AccountingArbitrator` before production accounting rollout. The HTTP layer returns `409 accounting_conflict` and never silently overwrites a concurrent operation.

## Endpoints

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/sync/push` with `{ "bookId": "...", "operations": [...] }`
- `GET /v1/sync/pull?bookId=...&deviceId=...&after=0&limit=100`
- `POST /v1/sync/devices/revoke` with `{ "bookId": "...", "deviceId": "..." }` for principals with the `sync:device-admin` scope

All sync endpoints require a bearer token in OIDC mode. TLS termination, rate limiting, encrypted backups, audit log retention, and network policy belong at the deployment boundary (for example Caddy or a cloud load balancer). Never synchronize SQLite files directly.

## Docker

```sh
docker build -t ledgr-sync-server .
docker run --rm -p 8787:8787 --env-file .env ledgr-sync-server
```

The image contains the compiled service and migration file. The in-memory mode remains available for automated tests, but it is not a durable or multi-instance deployment.
