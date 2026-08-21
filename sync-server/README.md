# Ledgr self-hosted sync server

This service coordinates Ledgr's optional offline-first semantic sync. Devices
continue to write their local SQLite database without a network connection and
retry immutable outbox operations. The server authenticates the caller and
enrolled device, validates accounting intent against canonical state, assigns a
per-book sequence, and preserves conflicts instead of using last-write-wins.

Never synchronize SQLite files directly.

## Development mode

Without PostgreSQL and OIDC configuration, the service uses the in-memory
reference store and anonymous development authentication:

```sh
npm install
npm test
npm start
```

Memory mode is not durable, multi-instance, or approved for real data.

## Production configuration

Set `NODE_ENV=production` and configure:

- `DATABASE_URL` or `DATABASE_URL_FILE` for PostgreSQL.
- `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL`; issuer and JWKS
  must use HTTPS.
- One explicit `CORS_ORIGIN`; wildcard production CORS is rejected.
- `METRICS_TOKEN` or `METRICS_TOKEN_FILE` for `/readyz` and `/metrics`.

Optional bounded settings are `PORT`, `HOST`, `DB_POOL_MAX`,
`DB_SSL=require`, `DB_SSL_REJECT_UNAUTHORIZED`,
`RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW_MS`, `MAX_BODY_BYTES`, and
`DEVICE_ENROLLMENT_TTL_DAYS` (90 by default).
Production startup fails closed when any required boundary is absent.

JWTs use `books`/`book_ids` claims and `scope`/`scp` permissions.
Database memberships provide Owner, Admin, Accountant, Editor, Viewer, and
Auditor roles. The first request for a device must use explicit enrollment;
push, pull, recovery, conflict, checkpoint, and administration calls reject an
unknown, revoked, wrong-subject, or stale-epoch device.
Enrollment also has a bounded server-side expiry and must be explicitly renewed.

The mobile client supports OIDC Authorization Code + PKCE at
`ledgr://sync-oidc`, stores access/refresh credentials only in SecureStore,
and automatically rotates a refresh token before an expired access token is
used. A manually pasted access token remains available only as a development
or operator fallback.

## Durable accounting boundary

PostgreSQL transactions serialize each book, enforce epoch and device
sequences, deduplicate `opId` plus payload hash, validate dependencies and
aggregate base revisions, and append complete immutable operations.

Production arbitration fails closed unless canonical accounting state can be
reconstructed from a validated active-epoch snapshot and the later event
stream. It validates balanced journals and audited corrections, invoice
allocation availability, stock and location availability, capital ownership,
duplicate reversals, inventory counts, opening policy, and period-close
barriers. Conflicts retain local and canonical evidence and can only be closed
through an authorized keep-canonical, permitted merge, or new audited
correction operation.

For the first device in an empty epoch, enrollment does not upload data. The
client remains disabled until the user explicitly publishes the initial
snapshot, and the server requires snapshot-administrator authority. The server
computes the snapshot aggregate-revision map from canonical active-epoch events
through the supplied checkpoint; it never accepts authoritative revisions from
the client.

## HTTP surface

- `GET /healthz`
- `GET /readyz`, `GET /metrics`, and `GET /v1/ops/health` with the operations bearer token
- `GET /v1/capabilities`
- `POST /v1/sync/enroll`
- `POST /v1/sync/enrollment-codes` and `POST /v1/sync/enroll-code/redeem` for short-lived, single-use device onboarding
- `POST /v1/sync/push`
- `GET /v1/sync/pull`
- `GET|POST /v1/sync/snapshot`
- `POST /v1/sync/checkpoints/verify`
- `POST /v1/sync/epoch/advance`
- `GET /v1/sync/devices`
- `POST /v1/sync/devices/revoke`
- `POST /v1/sync/devices/rename`
- `GET /v1/sync/memberships`
- `POST /v1/sync/memberships`
- `POST /v1/sync/memberships/remove`
- `POST /v1/sync/memberships/locations`
- `GET /v1/sync/conflicts`
- `POST /v1/sync/conflicts/resolve`

The app’s Sync Administration screen can issue a one-time code with an initial
role and location scope. The code is stored only as a SHA-256 digest, expires,
and is marked used in the same transaction as device enrollment. The Sync
Health screen combines local queue/error telemetry with optional protected
server diagnostics. The Conflict Inbox shows business-language consequences
and field differences before offering canonical, safe-merge, or audited-
correction outcomes.

All production sync endpoints require OIDC bearer authentication. Every
endpoint except enrollment also verifies the current enrolled device.

## Self-host deployment

The `deploy/` directory contains:

- PostgreSQL 16, the sync service, private networks, secrets, health checks,
  read-only runtime settings, and Caddy in `docker-compose.yml`.
- Automatic TLS and security headers in `Caddyfile`.
- An environment template plus age-encrypted backup and isolated restore-drill
  scripts. Each backup includes an encrypted reconciliation manifest whose
  canonical counts and hashes are automatically compared after restoration.
- `RUNBOOK.md` for rotation, monitoring, incident response, upgrades,
  rollback, and the evidence required before production onboarding.
- `install.sh` for fail-before-start single-node setup, `upgrade.sh` for a
  verified-backup-gated upgrade, and `docker-compose.advanced.yml` for the
  external-PostgreSQL profile. `deploy/README.md` explains when to use each.

Create `deploy/secrets/postgres_password`, `deploy/secrets/database_url`,
and `deploy/secrets/metrics_token` outside version control, copy
`config.production.example` to the host environment file, then follow the
runbook. The provided scripts and topology are implementation foundations;
operators must still execute and retain real staging and disaster-recovery
evidence.
