# Offline-First Sync Production-Readiness Audit

**Repository:** `mbell003638/Ledgr-AI`  
**Branch:** `codex-sol`  
**Audit scope:** changes implemented in the current work cycle, plus the remaining release blockers identified by the offline-first sync plan.

## Executive verdict

The branch is materially safer than the previous production-oriented slice. The client now performs the planned **pull/apply → push → pull/apply** sequence, remote replay is applied inside one SQLite savepoint, failed replay leaves the cursor unchanged, and failed operations are retained as one open conflict record.[1] The server now assigns and checks aggregate revisions, rejects stale same-aggregate edits instead of silently applying last-write-wins, returns a canonical checkpoint hash, validates actor identity and several important accounting payload invariants, rejects mixed-device batches, and provides PostgreSQL device enrollment and revocation hooks.[2] [3] [4]

Destructive local reset, restore, and delete flows now quarantine pending outbox work and mark the profile as requiring explicit recovery/re-enrollment rather than allowing old pending work to continue silently.[5] The new tests cover two-device independent-operation convergence in the in-memory canonical store, stale aggregate conflicts, checkpoint responses, mixed-device batches, revoked-device rejection, atomic replay rollback, and strict coordinator ordering.[6] [7]

> **The implementation is still not production-ready for full multi-device accounting convergence.** The remaining blockers are now narrower and explicit: server-authoritative epoch advancement and bootstrap/snapshot installation, true projection-hash verification, domain-state arbitration and correction workflows, real PostgreSQL/OIDC end-to-end testing, crash/restart drills, and deployment operations/security controls.

## Gap-by-gap status

| Previously reported gap | Current status | Assessment |
|---|---|---|
| Client order was not exactly pull → push → pull | **Implemented** | `syncNow` pulls and applies canonical events before push, then pulls and applies again after push. The coordinator regression test asserts `GET`, `POST`, `GET` ordering.[1] [6] |
| Remote replay was not atomic and cursor could advance after failure | **Implemented for each pull batch** | All remote event applications, applied-operation metadata, checkpoint state, and cursor persistence occur inside one savepoint. On failure, the savepoint is rolled back, one conflict is recorded outside the savepoint, and the error is rethrown; the cursor therefore remains unchanged.[1] [6] |
| Server arbitration was only a baseline | **Improved but not complete** | Actor identity, revision-sensitive commands, balanced journals, period-close revisions, inventory count values, allocation references, stock quantities, location-transfer references, capital-entry shape, and reversal references are now checked deterministically.[2] Stateful checks such as remaining invoice balance, actual inventory availability, capital ownership, location balances, and period authority still require domain-state integration. |
| Conflict resolution only marked conflicts | **Still incomplete** | The branch retains source intent and conflict status safely, but does not yet implement user-driven “apply as audited correction” commands or policy-governed merged values. Historical journals are not silently edited, but correction workflows remain outstanding.[1] |
| Snapshot/bootstrap/checkpoint recovery was incomplete | **Partially improved** | Canonical event stores now return a deterministic event-history checkpoint hash and the client stores it in `sync_book_state`.[1] [3] This is not yet a validated projection hash, snapshot download/install, bootstrap reconciliation, or replay-after-snapshot workflow. |
| Reset/restore/delete lacked stale-work protection | **Locally improved; server epoch still incomplete** | Pending/retryable outbox entries are quarantined and the sync profile is disabled with a recovery-required reason before local restore/reset/delete operations.[5] The server still needs an epoch-advance protocol, stale-epoch re-enrollment exchange, and a guided recovery flow before this gate is complete. |
| Device revocation was incomplete | **Partially implemented** | PostgreSQL has `sync_devices`, automatic first-use enrollment, subject binding, revoked-device rejection on pull/push, a scoped revoke endpoint, and client device IDs are passed on pull requests.[2] [3] A complete operator UI, enrollment approval flow, and production OIDC/device-lifecycle end-to-end test remain outstanding. |
| No demonstrated two-device convergence test | **Improved in-memory coverage; production E2E remains absent** | The server suite now verifies independent operations from two devices converge to the same canonical sequence and that stale same-aggregate edits conflict.[7] This is not a real PostgreSQL/OIDC two-device environment. |
| Production operations were missing | **Still deployment work** | TLS termination, rate limiting, network policy, encrypted database/backups, key rotation, monitoring/alerting, retention, incident response, and disaster-recovery drills remain deployment and operations responsibilities.[8] |

## Implemented changes

### Client replay and cursor safety

The client’s pull helper now creates a uniquely named SQLite savepoint for the entire remote batch. A remote applier failure rolls back all projection writes and applied-operation rows from that batch. The cursor and checkpoint hash are written only after every event in the batch has succeeded. Conflict recording occurs after rollback and is de-duplicated by open `bookId`/`opId`, preventing repeated sync attempts from creating an unbounded conflict list.[1]

### Server revisions and deterministic arbitration

The in-memory store and PostgreSQL event store now assign `aggregateRevision` values and compare `baseRevision` under the existing per-book serialization boundary. Independent operations from different aggregates remain accepted, while stale same-aggregate edits are rejected with a conflict rather than resolved by timestamp.[2] [3] The default arbitrator additionally rejects actor impersonation unless the principal has an explicit `sync:act-as` scope and validates the shape and basic invariants of inventory, allocation, location, capital, reversal, journal, and period-close commands.[2]

### Checkpoints and device lifecycle

Pull responses now include a deterministic hash of canonical event identity, book sequence, and aggregate revision up to the returned cursor. The client persists that value as the current sync checkpoint.[1] [3] PostgreSQL migrations add aggregate revision indexing and `sync_devices`; the authorizer enrolls first-seen devices, binds them to the authenticated subject, rejects revoked devices, and exposes a `sync:device-admin`-protected revoke endpoint.[2] [4]

### Recovery quarantine

The client schema now stores `recovery_required` and `recovery_reason` on sync profiles. Before manual backup restore, accounting reset, or book deletion, pending and retryable operations are changed to `quarantined`, synchronization is disabled, and the profile records the reason. This preserves unsent intent for recovery review instead of allowing delayed old work to continue automatically.[5]

## Validation results

| Validation | Result |
|---|---:|
| Sync-server build | **Passed** |
| Sync-server tests | **16 passed, 0 failed** |
| Frontend TypeScript check | **Passed** |
| Focused coordinator/foundation/contract tests | **10 passed** |
| Full frontend Jest suite | **80 suites passed; 601 tests passed** |
| Frontend lint with zero warnings | **Passed** |
| Frontend audit check | **Passed**; only the existing temporarily allowlisted Metro `image-size` advisories were reported |
| Working-tree diff check | **Passed before publish review** |

## Remaining release blockers

The following items still prevent a full production-readiness claim:

| Release blocker | Required next step |
|---|---|
| Server-authoritative epoch recovery | Add an owner-authorized epoch-advance operation, preserve old history by epoch, quarantine stale outbox entries, and make explicit re-enrollment obtain the current epoch from the server. |
| Bootstrap and snapshots | Add validated snapshot creation/download/install, reconcile pre-existing local data, replay post-checkpoint outbox work, and verify projection hashes after installation. |
| Domain-state arbitration | Connect server validation to canonical accounting state for open invoice balances, stock availability, capital ownership, location balances, duplicate reversals, opening-balance policy, and period-close barriers. |
| Audited conflict corrections | Add explicit correction commands that create new audited postings or reversals without mutating historical source events, together with UI resolution choices and server authorization. |
| PostgreSQL/OIDC end-to-end | Run a real multi-device environment with PostgreSQL, OIDC JWTs, memberships, enrollment, revocation, retries, stale epochs, conflict resolution, and projection reconciliation. |
| Crash/restart and operations drills | Exercise process death, database interruption, restore, backup verification, key rotation, alerting, retention, and disaster recovery using the production deployment topology. |

Accordingly, the accurate release statement is: **the client replay/cursor safety, aggregate revision protection, deterministic arbitration baseline, checkpoint metadata, local recovery quarantine, and in-memory multi-device protocol tests are implemented and validated; full production convergence and readiness are still not complete.**

## References

[1]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/src/sync/coordinator.ts "Client replay, cursor, checkpoint, and recovery coordinator"
[2]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/sync-server/src/arbitration.ts "Deterministic server accounting arbitrator"
[3]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/sync-server/src/postgres.ts "PostgreSQL revisions, checkpoints, and device authorization"
[4]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/sync-server/src/server.ts "Sync HTTP endpoints"
[5]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/src/api.ts "Restore/reset/delete recovery quarantine integration"
[6]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/__tests__/syncCoordinator.test.ts "Client ordering and atomic replay regression tests"
[7]: https://github.com/mbell003638/Ledgr-AI/tree/codex-sol/sync-server/src/test "Server protocol, arbitration, revision, and multi-device tests"
[8]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/sync-server/src/index.ts "Production startup and deployment-boundary checks"

*Audit prepared by Manus AI.*
