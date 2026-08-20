# Offline-First Sync Scoped Implementation Audit

**Repository:** `mbell003638/Ledgr-AI`  
**Branch:** `codex-sol`  
**Scope of this audit:** only the implementation changes in the current working tree, not the entire offline-first sync plan.

## Scope verdict

This change implements and validates a focused subset of the remaining plan:

| Implemented scope | Status | Evidence |
|---|---|---|
| Route the previously identified opening-balance, closing-balance import, scan-import, inventory-count, manual-asset, manual-liability, and manual-balance write paths through `withSyncedMutation` | **Implemented** | The API methods now create semantic operation envelopes and execute the domain mutation inside the local mutation/outbox boundary.[1] |
| Replay those newly supported command types without generating a second outbox operation | **Implemented** | `applyRemoteSyncOperation` dispatches the new command types directly to the V2 service layer.[1] |
| Change the client coordinator to pull/apply before push, then pull/apply again | **Implemented** | `syncNow` now uses `pullAndApply` before and after the push phase, writing the cursor only after each local apply pass.[2] |
| Preserve offline-first behavior when sync is disabled or unavailable | **Retained** | The existing coordinator still returns to local mutation behavior when the profile is disabled, and startup/foreground synchronization remains best-effort.[2] |

> **This change does not complete the entire plan.** It completes the scoped command-boundary and coordinator-ordering slice only.

## Implementation details

The newly routed command types are `opening_balances.post`, `opening_balances.update`, `closing_balances.import`, `scan.transaction.import`, `inventory.count.record`, `manual.asset.create`, `manual.liability.create`, `manual.balance.delete`, and `manual.balance.update`.[1] Each local call uses the existing `withSyncedMutation` boundary, so the domain write and durable outbox insertion remain part of one SQLite savepoint when synchronization is enabled.[3]

Remote replay uses the same V2 service methods directly rather than calling the public API wrappers. This preserves the existing no-second-outbox rule during replay and provides a concrete handler for each newly supported command type.[1]

The coordinator now follows the plan’s intended sequence more closely. It first pulls and applies canonical events, pushes pending operations in device-sequence order, and pulls/applies again before returning. The cursor is persisted after each pull/apply pass, while applied-operation metadata continues to suppress duplicate replay.[2]

## Validation performed

| Validation | Result |
|---|---:|
| Frontend TypeScript check | **Passed** |
| Focused sync tests (`syncFoundation`, `syncContract`) | **8 passed** |
| Full frontend Jest suite | **79 suites passed; 599 tests passed** |
| Frontend lint with zero warnings | **Passed** |
| Sync-server build and tests | **9 passed; 0 failed** |
| `git diff --check` | **Passed** |

The focused tests cover deterministic protocol hashing, operation-envelope contracts, atomic local/outbox behavior, monotonic device sequences, accepted-operation metadata, rollback on local failure, immutable reversal lineage, and cross-book protection.[4] The full suite confirms that the new wrappers and coordinator changes did not regress the existing accounting behavior.

## Remaining work outside this scoped change

The following plan areas remain intentionally open and must not be inferred as complete from this audit:

| Remaining area | Current status |
|---|---|
| Full domain arbitration and audited correction workflows | Still incomplete for allocation lineage, inventory policy, capital ownership, location transfers, opening-balance conflicts, duplicate reversals, and broader financial aggregates. |
| Snapshot/bootstrap and checkpoint or projection-hash recovery | Still incomplete. Existing manual V2 backup/restore is not the sync snapshot workflow. |
| Reset/restore/delete epoch advancement and stale-outbox quarantine | Still incomplete. The destructive local paths do not yet implement server-authoritative epoch recovery. |
| Real multi-device PostgreSQL/OIDC end-to-end and crash/restart tests | Still incomplete. The passing server tests exercise the in-memory protocol slice. |
| Production operations | TLS termination, rate limiting, monitoring, encrypted backups, key rotation, retention, incident response, and disaster-recovery drills remain deployment work. |

Accordingly, the correct release statement after this change is: **the scoped command-bus coverage and pull/push/pull coordinator ordering are implemented and tested; the complete offline-first sync plan is not yet complete.**

## References

[1]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/src/api.ts "Accounting API mutation boundary and remote replay handlers"
[2]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/src/sync/coordinator.ts "Client sync coordinator"
[3]: https://github.com/mbell003638/Ledgr-AI/blob/codex-sol/frontend/src/sync/outbox.ts "Atomic local mutation and outbox helper"
[4]: https://github.com/mbell003638/Ledgr-AI/tree/codex-sol/frontend/__tests__ "Frontend test suite"

*Audit prepared by Manus AI.*
