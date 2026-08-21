# Ledgr sync production runbook

This runbook covers the operator-controlled work that application code cannot
perform on its own. Complete every gate in an isolated staging environment
before enrolling a real Business Account.

## Initial deployment

1. Provision a host whose data volume is encrypted at rest and whose security
   updates are managed.
2. Copy `config.production.example` to a host-local configuration file. Never
   commit it or the files in `deploy/secrets/`.
3. Create long random values for the PostgreSQL password, full database URL,
   and metrics bearer token. Keep backup decryption identities outside the host.
4. Configure a production OIDC application with Authorization Code + PKCE,
   short access-token lifetime, rotating refresh tokens, and the documented
   book/scope claims. Register `ledgr://sync-oidc` as the mobile redirect URI.
   Set a bounded `DEVICE_ENROLLMENT_TTL_DAYS` and document the renewal policy.
5. Point the public DNS name at the host and start the compose stack. Caddy
   obtains and renews TLS certificates and proxies only to the private service.
6. Confirm `/healthz`, authenticated `/readyz`, and authenticated `/metrics`.
   Confirm wildcard CORS, anonymous authentication, and the memory store are
   rejected in production.

## Backup and restore

- Enter a write-maintenance window with `docker compose stop sync`, confirm no
  other database writers exist, and run `backup.sh` from a locked-down
  PostgreSQL maintenance container that also contains `age` with
  `SYNC_WRITES_QUIESCED=I_HAVE_STOPPED_ALL_SYNC_WRITERS`. The script also
  refuses to proceed while any other database session remains. Store the
  encrypted dump, encrypted reconciliation manifest, and both digest-only
  checksum files off-host, then restart the sync service.
- Keep the age identity offline and separate from both database and backup.
- Run `restore-drill.sh` against an isolated empty database on a schedule and
  after schema changes. The target database name must end in `_restore_drill`,
  must equal `EXPECTED_RESTORE_DATABASE`, and requires
  `ALLOW_DESTRUCTIVE_RESTORE_DRILL=I_UNDERSTAND_THIS_DROPS_OBJECTS`. Set
  `PRODUCTION_DATABASE_URL` as an additional equality guard. Never point a
  drill at production.
- The restore script fails unless its regenerated canonical counts and hashes
  exactly match the decrypted reconciliation manifest. After it passes, run
  server migrations, enroll test devices, and verify live projection hashes
  before declaring the drill complete.

## Key and token rotation

1. Rotate OIDC signing keys with an overlap period in the provider JWKS.
2. Rotate refresh tokens through the provider; revoke lost or decommissioned
   devices through the device administration endpoint.
3. Rotate PostgreSQL and metrics credentials one at a time, restart services,
   and verify readiness after each change.
4. Rotate the backup recipient by producing and restoring one backup encrypted
   to the new offline identity before retiring the old identity.

## Monitoring and incident response

- Alert on readiness failure, HTTP 5xx, authentication spikes, rejected sync
  operations, conflict growth, retry latency, and checkpoint mismatches.
- Logs contain request metadata only; do not add accounting payloads, bearer
  tokens, database URLs, or financial values.
- On suspected compromise, revoke affected devices and tokens, isolate the
  service, preserve logs, take an encrypted forensic backup, rotate credentials,
  and reconcile checkpoint/projection hashes before reopening synchronization.

## Upgrade and rollback

- Back up and complete a restore drill before each server or schema upgrade.
- Deploy a compatible server before clients that emit a new payload version.
- Do not downgrade once a migration or epoch advance has been accepted unless
  the documented migration explicitly supports it.
- Rollback means restoring the verified database backup and matching server
  image together. Never delete canonical events to force an older cursor.

## Production acceptance record

Record the date, operator, image digest, schema version, OIDC issuer/audience,
backup checksum, restore-drill result, two-device convergence result, revoked-
device result, stale-epoch result, and projection-hash result. Production sync is not approved until every item has evidence.

## Guided single-node installer

From the checked-out release package, create `.env` from `config.production.example`, replace every example value, create the three files in `deploy/secrets/` with mode `0600`, and run:

```text
cd sync-server/deploy
./install.sh
```

The installer fails before starting containers when Docker Compose, required environment values, production OIDC settings, explicit CORS, or secret files are missing. It validates the interpolated Compose configuration before building the stack. The PostgreSQL service is on an internal Docker network only; the public edge exposes the sync API through Caddy TLS.

## Operations and health

`GET /healthz` is liveness and is intentionally public. `GET /readyz`, `GET /metrics`, and `GET /v1/ops/health` require the operations bearer token. The health response separates process liveness, database readiness, sync metrics, identity configuration, storage, and encrypted-backup status. Configure `BACKUP_STATUS_FILE=/backups/status.json`; `backup.sh` writes this file atomically only after `pg_restore --list`, encryption, checksums, and the reconciliation manifest complete.

The device and access administration endpoints are protected by the authenticated book/device flow: `/v1/sync/devices`, `/v1/sync/devices/rename`, `/v1/sync/devices/revoke`, `/v1/sync/memberships`, `/v1/sync/memberships/remove`, and `/v1/sync/memberships/locations`. These endpoints do not delete historical accounting operations. Location scopes are explicit and must be enforced by the application’s domain authorization layer before accepting location-sensitive operations.

The mobile client’s Sync Health screen keeps the operations token session-only and displays local queue/error state even when the server is unavailable. The Sync Administration screen exposes device naming/revocation and role/location scope management only after the private sync profile is configured.

## Local-only to private-sync migration

Keep the source device in Local-only mode while creating and verifying an encrypted backup. Run `./preflight.sh single-node` or `./preflight.sh advanced`, then configure the Ledgr client with the user-owned server. The client enrolls the device, reports whether the server is empty or already canonical, and requires an explicit initial snapshot publication or validated snapshot installation. Pending local operations are preserved; raw SQLite files are never uploaded or copied over the server database. To leave private sync, use the app's Return to Local-only action; this disables the local profile without deleting the server or local book.

## Phase-10 release gate

Before upgrade, complete `RELEASE_CHECKLIST.md`, verify an encrypted backup and restore drill, and set `UPGRADE_BACKUP_CONFIRMED=I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL` for `upgrade.sh`. After restart, verify health, readiness, database state, backup freshness, two-device offline writes, queue drain, and an explicit conflict resolution. If any check fails, stop enrollment, preserve logs, restore the previous image or deployment artifact into a new database/volume when necessary, and never delete the PostgreSQL volume or overwrite it with a raw client SQLite file.
