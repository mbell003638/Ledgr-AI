# Offline-First Sync Implementation Audit

**Repository:** `mbell003638/Ledgr-AI`

**Target branch:** `codex-sol`

**Audit date:** 2026-08-20
**Evidence state:** implementation review complete; runtime validation deferred
at the user's request

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

This is an implementation-complete working tree, not a production-acceptance
claim. Tests and operational drills have not yet been run for this work cycle.

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

## Remaining evidence gates

The following are deliberately not marked passed:

1. Frontend tests, TypeScript, lint, Expo Doctor, and dependency audit.
2. Sync-server build, tests, migration checks, and security/recovery tests.
3. Container/configuration validation.
4. Real PostgreSQL/OIDC two-device convergence and crash/restart exercises.
5. Encrypted backup restoration, projection reconciliation, monitoring alert,
   token/key rotation, incident-response, and disaster-recovery records.

The first three begin only after the user authorizes testing. The final two
require an operator-controlled staging environment and remain release evidence,
not missing application code.
