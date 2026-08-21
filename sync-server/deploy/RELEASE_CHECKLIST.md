# Ledgr private sync release checklist

This package is a **user-owned private sync service**. It is not a hosted Ledgr ERP and it does not receive data unless the business owner deploys it and connects Ledgr clients. Local-only operation remains supported without any server.

## Minimum requirements

| Deployment | Minimum tested baseline | Recommended for production |
| --- | --- | --- |
| Bundled single-node | 2 CPU, 2 GB RAM, 20 GB free disk, Docker Engine 24+, Compose v2 | 4 CPU, 4 GB RAM, SSD, daily encrypted backup copied off-host |
| Advanced PostgreSQL | 1 sync node with 1 CPU / 1 GB RAM, PostgreSQL 16-compatible database with TLS, 10 GB service disk | 2 CPU, 2 GB RAM, managed PostgreSQL with automated point-in-time recovery and a tested standby |

The public edge must be HTTPS through Caddy or an equivalent reverse proxy. PostgreSQL must stay on a private network or private database endpoint. Use an explicit `CORS_ORIGIN`; wildcard CORS is rejected by the advanced installer. Store database, metrics, and OIDC secrets outside the image with file permissions `0600`.

## Before the first release

Create and verify an encrypted Ledgr backup, run the restore drill, record its result, and confirm `/healthz`, authenticated `/readyz`, and authenticated `/v1/ops/health`. Confirm that the health response reports the expected database and backup state. Enroll two test devices with different names, perform one offline write on each, reconnect them, verify the queue drains, and intentionally exercise a safe conflict before production enrollment.

## Upgrade gate

Run the upgrade only after setting the exact confirmation phrase required by `upgrade.sh`:

```sh
export UPGRADE_BACKUP_CONFIRMED=I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL
./upgrade.sh
```

After the containers restart, verify the migration logs, liveness, readiness, protected operations health, one-device pull, two-device push/pull, and the backup status timestamp. Keep the previous deployment directory or image digest until this smoke test is complete.

## Rollback procedure

If the smoke test fails, stop new device enrollment and keep clients in offline-first mode. Preserve logs and the health response, then restore the previous deployment artifact or image digest using the operator's version-control or image registry procedure. Do not delete the PostgreSQL volume and do not restore raw SQLite files over the server database. If a migration is not backward compatible, restore the verified PostgreSQL backup into a new database or a new volume, point the previous application version at that destination, and run the two-device smoke test again. Record the failed version, rollback version, backup identifier, and verification result before reopening operations.

## Go/no-go boundaries

A release is **no-go** when the database is not ready, the backup is stale or unverified, the OIDC issuer/audience/JWKS configuration is incomplete, the HTTPS certificate is invalid, an enrolled device is revoked but can still sync, location scopes are not enforced, or the conflict inbox cannot produce an explicit audited outcome. A healthy process alone is not sufficient for release.

## Separation of concepts

An encrypted backup is a portable recovery artifact. Private sync is an operation-level coordination service running on infrastructure owned by the business. A future full hosted ERP would be a different deployment and data-ownership product; this package makes no such claim.
