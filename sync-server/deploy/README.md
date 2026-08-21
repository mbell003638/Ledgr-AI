# Ledgr private sync deployment

Ledgr supports two user-owned deployment profiles using the same semantic operation protocol. **Single-node** is the default small-business stack: PostgreSQL, the sync service, Caddy TLS, persistent volumes, restart policies, health checks, and encrypted backup status reporting. **Advanced** keeps the sync service and TLS edge on the operator’s host while PostgreSQL, backups, identity, and private networking are managed separately.

## Single-node

1. Copy `config.production.example` to `.env` and replace every example value.
2. Create `secrets/postgres_password`, `secrets/database_url`, and `secrets/metrics_token` with random values and mode `0600`.
3. Install Docker Engine and the Compose v2 plugin.
4. Run `./install.sh`.
5. Configure the encrypted `backup.sh` job from a locked-down maintenance environment and keep the age identity off-host.

The installer validates configuration before starting containers. PostgreSQL has no published host port and the private Docker network is internal. Caddy is the only public edge.

## Advanced PostgreSQL

Copy `config.advanced.example` to `.env`, create `secrets/database_url` and `secrets/metrics_token`, and verify that the external PostgreSQL endpoint is reachable only over a private network or VPN with TLS enabled. The database URL must declare `sslmode=require`, `verify-ca`, or `verify-full`. Then run:

```sh
./install-advanced.sh
```

The advanced installer performs the same fail-before-start checks, validates the external database URL’s TLS intent, and starts the sync service plus Caddy without exposing PostgreSQL from this package.

The external database must support PostgreSQL 16-compatible transactions, JSONB, advisory locks, and the migration statements in `../migrations/001_sync.sql`. No high-availability claim is made by this package; failover and restore evidence must be produced by the operator.

## Preflight and release gates

Run the no-start preflight before either deployment mode:

```sh
./preflight.sh single-node
# or
./preflight.sh advanced
```

Then follow [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) for minimum host resources, verified-backup gates, two-device smoke tests, upgrade evidence, and rollback. The preflight never starts or stops services.

## Operations

Use `/healthz` for liveness. Use the operations bearer token for `/readyz`, `/metrics`, and `/v1/ops/health`. The mobile Sync Health screen can display the protected response for one session-only token entry. Use `RUNBOOK.md` for backup, restore-drill, key rotation, upgrade, rollback, and production acceptance evidence.
