# Ledgr optional offline-first self-hosted sync plan

## 1. Objective

Add an opt-in synchronization service for Ledgr Business Accounts while
preserving the existing offline-first experience. A device must remain useful
when disconnected, and synchronization must never require copying or merging
SQLite database files.

The system synchronizes versioned business operations, not rows. Each device
continues to use its local SQLite read model for screens and reports. A
self-hosted service authenticates devices, orders accepted operations, stores a
canonical event stream, and helps devices converge.

## 2. Non-negotiable guarantees

1. Sync is disabled by default and can be turned off without disabling any
   existing accounting workflow.
2. A local business mutation and its outbox record commit in one SQLite
   transaction/savepoint.
3. Pending operations survive app restarts, process death, offline periods,
   retry failures, and temporary server outages.
4. Remote replay is atomic, idempotent, and does not create a second outbox
   operation.
5. Server ordering is authoritative; device clocks never determine accounting
   order.
6. Independent offline operations are both retained. Same-record financial
   edits are never silently resolved with last-write-wins.
7. Existing manual backup/export remains available before enrollment, restore,
   reset, or recovery.
8. Book reset, restore, or deletion advances an epoch so delayed old-device
   operations cannot resurrect data.

## 3. Trust and data boundaries

### 3.1 Local authority

The local V2 SQLite database remains the source used by the UI and reports.
Shared data includes accounting operations, Business Accounts, Customers,
Suppliers, Capital Accounts, Products, stock movements, Locations, periods,
close-book results, and shared feature configuration.

Device-local data is not synchronized: active Location, theme and UI settings,
app-lock/biometric settings, AI credentials, refresh tokens, transient
navigation state, and Ask AI history unless explicitly designed later.

### 3.2 Server authority

The server is the trust boundary for authentication, book membership, epoch
checks, idempotency, canonical sequence assignment, and accounting validation.
It stores an immutable event history and conflict records. It does not replace
the device read model or receive raw SQLite files.

## 4. Semantic operation contract

Every operation is validated before it changes a read model:

```ts
type SyncOperation = {
  protocolVersion: number;
  payloadVersion: number;
  opId: string;                 // immutable retry/idempotency key
  bookId: string;
  bookEpoch: string;
  deviceId: string;
  deviceSequence: number;      // monotonic per device/book
  actorId: string;
  commandType: string;
  aggregateId: string;
  baseRevision: number | null;
  dependencies: string[];
  payload: unknown;
  payloadHash: string;
  clientCreatedAt: string;      // audit data only
  businessDate?: string;
};
```

`opId` is idempotent within a book epoch. Reusing it with another payload hash
is rejected. The server assigns `bookSequence`; `deviceSequence` only orders a
single device's pending work. Unknown protocol or payload versions remain in
the outbox and are surfaced for upgrade/review rather than discarded.

Example command types are `transaction.create`, `transaction.reverse`,
`receipt.allocate`, `party.patch`, `product.patch`, `stock.move`,
`inventory.count.record`, `location.patch`, `book.config.patch`,
`period.close`, and `book.epoch.advance`.

## 5. Phased implementation plan

### Phase 0 - Baseline and invariants

- Inventory every accounting mutation and identify its aggregate, revision,
  dependencies, and posting invariants.
- Keep manual JSON backup/restore as a separate recovery mechanism.
- Define shared versus device-local settings and the book/epoch identity.
- Add contract tests for balanced journals, immutable reversals, allocations,
  stock projections, capital projections, and report reconciliation.

### Phase 1 - Durable local sync state

- Add schema migrations for sync profile, outbox, applied operations, book
  cursor/epoch, entity revisions, conflicts, and tombstones.
- Store access/refresh credentials in Expo SecureStore, never SQLite.
- Capture each supported command and its outbox entry atomically with the
  business write.
- Persist status, attempt count, next retry time, last error, and permanent
  failure reason.
- Ensure remote replay suppresses outbox capture and can resume after a crash.

### Phase 2 - Versioned protocol and client coordinator

- Implement canonical serialization and payload hashing.
- Validate operation envelopes before enqueueing or replaying.
- Implement cursor-based push/pull over HTTPS with bounded exponential backoff
  and jitter.
- Sync in this order: pull/apply, push pending device-sequence operations,
  pull again, then commit the cursor only after local projections are durable.
- Classify 401/403, epoch mismatch, dependency gaps, validation errors, and
  transient network/database errors separately.
- Expose status, manual sync, retry, and conflict-list APIs to the UI.

### Phase 3 - Development server and protocol tests

- Provide an in-memory server for fast contract and integration tests only.
- Add `healthz`, capabilities, push, and pull endpoints.
- Verify duplicate retry handling, payload-hash mismatch rejection, sequence
  monotonicity, dependency ordering, cursor pagination, and epoch rejection.
- Test two simulated devices operating while disconnected and reconnecting in
  either order.

### Phase 4 - Durable self-hosted server

- Add PostgreSQL migrations for books, members, canonical events, idempotency,
  revisions, conflicts, tombstones, and checkpoints.
- Use a transaction and per-book lock for sequence assignment and aggregate
  validation.
- Add OIDC/JWT verification, book-scoped membership and role authorization,
  device enrollment/revocation, and explicit CORS configuration.
- Fail closed in production when database, OIDC, or CORS settings are absent.
- Keep anonymous/in-memory mode limited to development and automated tests.

### Phase 5 - Deterministic concurrency and conflict handling

- Accept independent append-only events from both devices.
- Validate `baseRevision` for same-aggregate edits and persist base/local/
  canonical references for conflicts.
- Auto-merge only commutative/disjoint field patches.
- Treat edit-versus-delete, divergent financial values, duplicate reversals,
  over-allocation, opening-balance changes, and inventory counts as explicit
  conflicts.
- Never edit historical journals in place; resolve accounting conflicts with a
  new posting, reversal, replacement, or other audited correction.
- Preserve rejected or superseded intent in the audit history.

### Phase 6 - Optional user controls and conflict inbox

- Add a self-host enrollment screen with server URL, Business Account/book,
  actor identity, and access token flow.
- Keep the feature opt-in; show enabled/disabled state, last sync, cursor,
  pending count, and last error.
- Add “Sync now”, retry, disable, sign out/revoke-device, and backup-before-
  recovery actions.
- Add a conflict inbox with aggregate, business date, actor/device, base
  revision, local operation, canonical version, and resolution status.
- Allow “keep canonical”, “apply as audited correction”, or an explicit merged
  value only where policy permits. Resolution must never delete source events.

### Phase 7 - Accounting command-bus rollout

- Route every accounting mutation through the same command/outbox boundary,
  including less-common imports, adjustments, allocations, inventory counts,
  payroll, period close, configuration, and administrative actions.
- Version each payload and define deterministic replay handlers.
- Add domain arbitrators for journal balance, invoice/receipt lineage,
  inventory availability or explicit negative-stock policy, capital ownership,
  location transfers, and close-book barriers.
- Add correction workflows that preserve the existing V2 audit/reversal model.

### Phase 8 - Bootstrap, snapshots, restore, and epoch recovery

- Enroll against exactly one Business Account/book and current epoch.
- Reconcile existing local data before accepting a server snapshot.
- Download and atomically install a validated snapshot, then replay local
  outbox operations created after the snapshot checkpoint.
- On reset/restore/delete, advance the epoch, quarantine old outbox entries,
  and require explicit re-enrollment.
- Add checkpoint/projection hashes and a guided recovery path that never raw-
  merges two populated databases.

### Phase 9 - Production operations and security

- Terminate TLS outside the Node process; use network policy and rate limits.
- Encrypt database volumes and backups, separate key material, and test key
  rotation and restore procedures.
- Retain audit logs with payload redaction, expose readiness/health, and track
  sync latency, retry rates, rejected operations, conflicts, and checkpoint
  mismatches.
- Document token lifetime, refresh rotation, device revocation, membership
  changes, data deletion limits, and incident response.
- Run at least one multi-device PostgreSQL/OIDC end-to-end environment before
  onboarding production data.

### Phase 10 - Release gates

- Sync-off regression suite passes with no network dependency.
- Atomic local-write/outbox tests pass under crash/restart simulation.
- Two-device independent operations converge exactly once.
- Same-record financial edits produce an auditable conflict, never silent
  overwrite.
- Trial balance, reports, allocations, stock, capital, and locations reconcile
  after replay and conflict resolution.
- Snapshot recovery preserves unsent local work.
- Revoked devices, wrong-book access, stale epochs, and malformed operations
  are rejected server-side.
- Backup restore has passed an automated drill and production runbook review.

## 6. Concurrent edit policy

| Concurrent situation | Default behavior |
| --- | --- |
| Two independent sales, invoices, bills, expenses, payments, or capital entries | Accept both as separate canonical events. |
| Same source edited on two devices | Keep the canonical event and create an auditable conflict for the other intent. |
| Disjoint Customer/Supplier/Product fields | Auto-merge field patches. |
| Same field changed differently | Conflict; do not choose by timestamp. |
| Edit versus archive/delete | Conflict with a retained tombstone. |
| Two reversals of one source | Accept one; retain the other as a duplicate/reversal conflict. |
| Receipt allocations competing for remaining invoice balance | Serialize against canonical open amount; excess becomes reviewable conflict. |
| Concurrent stock moves | Accept valid moves and recompute stock; show negative-stock exception if policy allows it. |
| Two counts for the same product/location/date | Conflict; never average or overwrite. |
| Period close versus an unseen offline posting | Close at a canonical sequence barrier; preserve the late entry and require a current-period correction/annotation. |
| Reset/restore/delete | Advance book epoch; old-epoch devices stop syncing until re-enrolled. |

## 7. Reference sync sequence

```mermaid
sequenceDiagram
  participant A as Device A SQLite
  participant S as Self-hosted service
  participant B as Device B SQLite
  A->>A: Commit business command + outbox atomically
  B->>B: Commit offline command + outbox atomically
  A->>S: Pull after cursor
  A->>S: Push ordered operations
  S->>S: Authenticate, authorize, lock book, validate, assign sequence
  S-->>A: Accepted / duplicate / conflict / rejected
  A->>S: Pull canonical events
  S-->>A: Apply remote events atomically; advance cursor
  B->>S: Push its pending operations
  S-->>B: Canonical events and explicit conflicts
  B->>B: Replay without creating a second outbox entry
```

## 8. Current status (2026-08-20)

### Implemented in the `codex-sol` working tree

- **Phases 0-3:** shared/device-local boundaries, semantic operation contract,
  schema v14 sync state, atomic local write plus outbox capture, deterministic
  replay IDs, a process-wide SQLite mutation queue that prevents overlapping
  local/replay/recovery/conflict savepoints and device-sequence races,
  pull/apply -> push -> pull coordination, retry classification,
  cursor/checkpoint handling, and the in-memory reference server.
- **Phase 4:** PostgreSQL event, membership, device, conflict, snapshot,
  checkpoint, projection-hash, and epoch history storage; transactional
  per-book serialization; OIDC/JWT validation; role/book authorization;
  explicit device enrollment/revocation; production fail-closed configuration.
- **Phases 5-6:** durable base/local/canonical conflict evidence; same-aggregate
  revision checks; keep-canonical, policy-limited merge, and balanced audited
  correction decisions; conflict detail UI; optional enrollment/settings,
  status, manual sync, snapshot, backup, device, and recovery controls.
  Sync Settings supports OIDC Authorization Code + PKCE, secure refresh-token
  rotation, and an explicitly labeled manual-token development fallback.
- **Phase 7:** API-facing V2 accounting mutations, including transactions,
  allocation/reversal mutations, parties, cash, capital, products, stock,
  locations, inventory counts, opening/closing imports, scan imports, payroll,
  period close, shared persona/features, and manual balances, use the semantic
  command/outbox boundary and deterministic remote handlers. Stateful server
  arbitration reconstructs canonical accounting state from a validated
  snapshot plus later events and checks allocations, stock, cash/location,
  capital ownership, reversals, opening/close barriers, counts, and corrections.
- **Phase 8:** one-book enrollment, server-authoritative epochs, old-history
  preservation, snapshot publish/download, strict payload/projection/checkpoint
  verification, FK-safe atomic install, canonical catch-up, deterministic replay
  of preserved local intent, stale-epoch quarantine, guided re-enrollment, and
  owner-authorized epoch replacement. An empty server epoch leaves sync disabled
  until the user explicitly reviews the destination and publishes the initial
  canonical snapshot; enrollment never uploads local accounting data by itself.
  Snapshot aggregate revisions are computed from canonical active-epoch events
  through the checkpoint by the server and restored atomically by clients.
- **Phase 9 implementation:** Caddy TLS boundary, internal PostgreSQL network,
  application and proxy request limits, rate limiting, metadata-only logs,
  protected readiness/metrics, least-privilege container settings, secret-file
  configuration, encrypted backup and isolated restore-drill scripts, and an
  operator runbook covering rotation, retention, incident response, upgrade,
  rollback, and production acceptance.
- Security hardening requires an explicitly enrolled current-epoch device on
  every sync/recovery/administration request except enrollment itself. Revoked
  or expired devices cannot continue through pull, push, conflict, epoch,
  checkpoint, or device-admin endpoints with an otherwise valid token.
- Independent append-only entries use operation-scoped aggregate identity, so
  two offline devices can add unrelated accounting events without a false
  same-record revision conflict. Updates and deletes remain source-aggregate
  revision sensitive and never use last-write-wins.

### What is left

- **Validation is intentionally pending user approval.** No test, typecheck,
  lint, build, Expo Doctor, audit, Docker, or restore-drill command has been run
  for this work cycle. Historical pass counts are not evidence for this tree.
- After approval, run the complete Phase 10 automated gate: frontend unit and
  integration tests, TypeScript, lint, Expo Doctor, dependency audit, server
  build/tests, migration checks, and focused two-device, conflict, snapshot,
  epoch, authorization, and crash/retry suites.
- Production acceptance additionally requires operator-controlled evidence from
  a real PostgreSQL/OIDC staging topology: two physical or isolated devices,
  TLS/DNS, membership and token rotation, revocation, stale epochs, projection
  reconciliation, encrypted backup/restore, alerting, key rotation, and
  disaster-recovery drills. Code cannot truthfully pre-complete those external
  operational records.
- Commit and push remain pending until the approved validation gate completes
  successfully.

Therefore, all planned implementation phases are represented in the working
tree, while Phase 10 validation and the real-environment portion of Phase 9
remain unclaimed until their evidence is produced.
