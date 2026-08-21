# Specialist audit cycles 1–2: phases 11–12

**Branch:** `Manus`
**Scope:** Ledgr two-tier self-hosting roadmap
**Audit status:** Actionable implementation findings closed; host, credentials, signing, and physical-device checks remain owner-controlled release dependencies.

## Phase 11 — Architecture and deployment review

The deployment review checked the bundled single-node profile, advanced external-PostgreSQL profile, migration runner, secrets, TLS/CORS gates, private database topology, health endpoints, backup status, upgrade, rollback, and accidental dependence on a Ledgr-operated service.

| Finding | Severity | Remediation | Evidence | Status |
|---|---:|---|---|---|
| Upgrade required a confirmation phrase but did not itself run a fresh pre-upgrade backup. | High | `deploy/upgrade.sh` now runs the configured encrypted backup command, requires quiesced writers, verifies the atomic backup status file and timestamp, and only then rebuilds the stack. | Shell syntax check; release checklist; backup status gate | Closed |
| Client/server protocol compatibility was documented but not negotiated on sync requests. | High | Client sync and recovery requests now send protocol/payload headers; server rejects incompatible versions with HTTP 426 and an actionable upgrade message before semantic processing. | Server regression test: incompatible client version | Closed |
| Advanced deployment needed an explicit external-database TLS intent gate. | High | `install-advanced.sh` and `preflight.sh advanced` require `sslmode=require`, `verify-ca`, or `verify-full` and reject wildcard CORS. | Shell syntax check; advanced deployment guide | Closed |
| Operators needed a no-start preflight and a clear rollback decision record. | Medium | Added `preflight.sh`, `RELEASE_CHECKLIST.md`, and runbook upgrade/rollback evidence requirements. | Deployment documentation and script validation | Closed |
| No Ledgr-hosted dependency was introduced. | Critical check | Client remains local-first; private sync is an optional user-owned service; no hosted Ledgr URL or mandatory account was added. | Architecture review and source audit | Passed |

## Phase 12 — Accounting integrity, sync safety, and recovery review

The accounting/recovery review checked operation-level synchronization, journal arbitration, immutable history, closed periods, inventory and locations, POS/shop behavior, invoice allocation, multi-book isolation, replay, duplicate operations, stale revisions, device sequences, backup corruption, and recovery workflow behavior.

| Control | Result | Evidence |
|---|---|---|
| Double-entry balance arbitration | Pass | Sync-server accounting arbitration tests reject unbalanced journals and accept balanced journals. |
| Immutable posted history and audited corrections | Pass | Correction-lineage and historical-overwrite tests pass. |
| Period-close enforcement | Pass | Closed-period and canonical-sequence barrier tests pass. |
| Inventory, location, and transfer validation | Pass | Stock, allocation, location-transfer, and shop-scope arbitration tests pass. |
| POS/session and multi-location scope boundary | Pass | Server-side location-scope enforcement is applied before accepting location-bearing semantic operations. |
| Duplicate operation replay | Pass | Operation ID and payload-hash idempotency tests pass; reuse with another payload is rejected. |
| Stale aggregate and concurrent settlement protection | Pass | Stale-revision, concurrent mark-paid, invoice allocation, and stateful arbitration tests pass. |
| Device sequence and epoch safety | Pass | Revoked/expired-device, monotonic sequence, stale epoch, and re-enrollment tests pass. |
| Backup/recovery safety | Pass | Encrypted backup, wrong-passphrase, tamper, integrity, dry-run, wrong-book, and audit contracts pass. |
| Local-to-private migration safety | Pass | Migration requires integrity plus recent verified backup, preserves pending local operations, requires explicit publish/install, and does not copy raw SQLite files. |
| Protocol compatibility | Pass | Incompatible sync protocol regression returns HTTP 426 before processing. |

## Audit exit decision

No critical accounting or data-loss finding remains open in the implementation. The package is ready for owner-controlled clean-host deployment validation. A production release must still prove real Docker startup, PostgreSQL migration against the target version, encrypted backup and isolated restore drill, HTTPS/OIDC configuration, two-device offline convergence, and physical Android/iOS behavior. Those checks cannot be honestly simulated by the sandbox and are explicitly recorded as release dependencies rather than hidden gaps.
