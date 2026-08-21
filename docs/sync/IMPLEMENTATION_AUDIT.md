# Offline-First Sync Implementation Audit

**Repository:** `mbell003638/Ledgr-AI`

**Target branch:** `codex-sol`

**Audit date:** 2026-08-22
**Evidence state:** implementation review complete; local validation gate completed; production environment evidence remains outstanding

## Executive verdict

The working tree now contains the implementation for the planned optional,
self-hosted, offline-first synchronization architecture. Local SQLite remains
the application read/write authority while disconnected. Shared V2 accounting
mutations create deterministic semantic operations in a durable outbox inside
the same SQLite savepoint, and remote replay suppresses re-enqueueing.

The server provides immutable per-book ordering, epoch isolation, aggregate
revisions, durable conflicts, validated snapshots/checkpoints, stateful
accounting arbitration, OIDC and role authorization, and explicit device
lifecycle controls. The client provides opt-in enrollment, sync status,
snapshot recovery, projection verification, conflict review, audited
corrections, and device administration.

This is an implementation-complete working tree with the available local validation gate completed. It is not a production-acceptance claim: real PostgreSQL/OIDC staging, device convergence, crash/restart, encrypted restore, monitoring, rotation, and disaster-recovery evidence still require an operator-controlled environment.

## Gap closure

| Planned area | Working-tree implementation |
|---|---|
| Offline-first atomicity | Business mutation and outbox insertion share one SQLite savepoint; a process-wide mutation queue serializes local writes, device-sequence allocation, remote replay, snapshot recovery, and conflict decisions so savepoints cannot overlap; sync-off uses the normal local path. |
| Deterministic convergence | Immutable operation IDs seed V2 source/journal/allocation/stock/payroll IDs during local apply and replay. |
| Coordinator ordering | Bounded pull/apply, ordered push with per-operation results, then pull/apply; cursor commits only with durable replay. Last successful sync is persisted, and users can explicitly clear transient backoff with Retry now. |
| Durable server | PostgreSQL migrations and transactional event/recovery stores preserve events, epochs, revisions, conflicts, snapshots, checkpoints, hashes, memberships, and devices. |
| Concurrent edits | Base revisions and canonical dependencies prevent silent overwrite; base/local/canonical evidence is retained. Independent append-only events use operation identity, while updates/deletes remain source-revision sensitive. |
| Accounting arbitration | Snapshot-backed canonical state plus later events validates allocations, inventory, location cash/stock, capital, reversals, counts, opening/close barriers, and correction commands. |
| Conflict resolution | Keep canonical, permitted merge, and explicit balanced correction/reversal decisions preserve original intent and audit links. |
| Bootstrap/recovery | Strict one-book snapshots, payload and semantic projection hashes, server-computed checkpoint aggregate revisions, canonical catch-up, preserved-local replay, and epoch replacement are implemented. Empty-server enrollment requires an explicit user-confirmed initial snapshot publish before sync is enabled. |
| Security | Production fails closed without PostgreSQL, HTTPS OIDC/JWKS, explicit CORS, and metrics token; the client implements Authorization Code + PKCE and refresh rotation in SecureStore; every non-enrollment sync/admin call requires a current, non-revoked, non-expired device. |
| Operations | TLS proxy, rate/body limits, protected readiness/metrics, redacted logs, secret files, encrypted backup/restore scripts, automatic restored-count/hash reconciliation, and production runbook are present. |

## UI gap investigation and scoped fixes applied

The attached device screenshots exposed three sync-plan UI issues: the self-hosted sync title and subtitle wrapped into narrow fragments on the target portrait layout; the software keyboard could cover the manual access-token field and enrollment controls; and Self-hosted Sync was exposed both in main Settings and inside Advanced Settings → System & Workflows.

Only the sync-plan UI scope was changed in this work cycle:

| Screenshot finding | Scoped implementation change | Evidence |
|---|---|---|
| Self-hosted Sync header wraps awkwardly | Added a sync-specific compact header style with constrained title sizing, reduced header padding, and a flexible header layout that preserves the business-account pill area. | `frontend/app/sync-settings.tsx` |
| Keyboard covers manual access-token controls | Wrapped the form in `KeyboardAvoidingView`, enabled Android height behavior and iOS padding behavior, added keyboard dismissal on drag, increased bottom scroll padding, and scrolls to the form end when the manual-token field receives focus. | `frontend/app/sync-settings.tsx` |
| Duplicate Self-hosted Sync navigation entries | Removed the redundant main Settings tile while retaining the single sync entry in Advanced Settings → System & Workflows and retaining the separate conflict inbox entry. | `frontend/app/(tabs)/settings.tsx`, `frontend/app/advanced-settings.tsx` |
| UI regressions were not contract-tested | Added a focused UI contract suite covering keyboard avoidance, compact header styles, single-entry navigation, and conflict-inbox retention. | `frontend/__tests__/syncUiContracts.test.ts` |

The implementation intentionally does not change sync protocol, accounting commands, server arbitration, snapshot/recovery logic, device lifecycle, or deployment behavior. It is limited to the screenshot-confirmed navigation and enrollment-form presentation issues required by the codex-sol sync plan.

## UI-scope validation

| Check | Result |
|---|---:|
| Focused sync UI contract test | **Passed: 2 tests** |
| Frontend TypeScript check | **Passed** |
| Frontend lint with zero warnings | **Passed** |
| `git diff --check` | **Passed** |

These checks validate the source-level UI contracts. They do not replace device-level verification on the target Android screen, especially keyboard behavior across different IME sizes and screen widths.

## Validation evidence completed in this work cycle

| Check | Result | Evidence boundary |
|---|---:|---|
| Frontend unit/integration suite | **83 suites, 613 tests passed** | Local Jest environment; no physical-device runtime evidence. |
| Frontend TypeScript | **Passed** | `npx tsc --noEmit`. |
| Frontend lint | **Passed** | `npm run lint:ci` with zero warnings. |
| Expo Doctor | **18/18 checks passed** | Local project health check. |
| Frontend dependency audit | **Passed under repository policy** | Only the repository’s temporarily allowlisted Metro `image-size` advisories were reported. |
| Sync-server build and tests | **36 tests passed** | Includes protocol, arbitration, revisions, snapshots, epochs, devices, conflicts, and recovery tests. |
| Deployment asset checks | **Passed statically** | Required files exist, shell scripts pass `bash -n`, and migration markers are present. Docker was unavailable in the validation environment, so Compose/build execution was not claimed. |
| `git diff --check` | **Passed** | Working tree content has no whitespace errors. |
| Sync endpoint documentation | **Corrected** | Pull documentation now matches the implementation: `bookId`, required `deviceId`, `after`, and `limit`. |
| Automated release gate | **Added** | `.github/workflows/sync-release-gate.yml` runs frontend/server checks and Docker Compose/image validation on GitHub-hosted runners. |

## Remaining evidence gates

The following remain deliberately unclaimed:

1. Real PostgreSQL/OIDC two-device convergence, token rotation, membership changes,
   revocation, stale epochs, projection reconciliation, and crash/restart exercises.
2. The new GitHub Actions release gate must execute successfully in a Docker-enabled runner to close the Compose/image evidence gate.
3. Encrypted backup restoration, monitoring alerts, key rotation,
   incident-response, and disaster-recovery records in the production topology.
4. Physical or isolated-device verification of the Android enrollment layout,
   keyboard avoidance, and the single sync navigation entry across screen sizes.

The repository now contains the planned implementation and has passed the
available local validation gate. The remaining items are environment-dependent
release evidence, not unimplemented application code in this tree.
