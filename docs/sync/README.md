# Optional self-hosted sync

This document is the contract for adding optional, self-hosted synchronization
to Ledgr while keeping the current offline-first behavior. It describes the
boundary between the device's authoritative local SQLite database and a
self-hosted coordination service. It is intentionally implementation-neutral:
the API and storage can evolve as long as these invariants remain true.

## Current implementation status

The current `codex-sol` working tree implements the local sync schema,
deterministic semantic command/outbox boundary, client coordinator, conflict
inbox and audited correction flow, validated snapshot recovery, server-
authoritative epochs, PostgreSQL persistence, OIDC JWT verification, explicit
device enrollment/revocation, stateful accounting arbitration, and the
self-hosted deployment/runbook foundation. The in-memory server remains for
development and automated tests only.

Implementation is not the same as production acceptance. The available local
validation gate has passed: frontend tests, TypeScript, lint, Expo Doctor,
dependency audit, sync-server build/tests, migration markers, deployment asset
checks, shell syntax, and diff checks. Docker Compose/image validation could not
run because Docker is unavailable in the validation environment. A real operator
must still record the PostgreSQL/OIDC multi-device, encrypted backup/restore,
key-rotation, monitoring, and disaster-recovery evidence described in
`sync-server/deploy/RUNBOOK.md` before onboarding production data.

## Current boundary

Ledgr starts with one local SQLite accounting database. The normalized `v2_*`
tables are authoritative for books, periods, accounts, parties, source
documents, journals, allocations, inventory, capital and locations. The
row-per-record collections are non-posting documents. See
`frontend/src/db/README-sqlite.md` and `frontend/src/db/schema.ts` for the
current storage boundary.

The existing JSON backup is an atomic restore/replace operation. It is a
recovery and migration mechanism, not a merge protocol. Sync must never copy a
SQLite file, replace a whole table, or treat a backup as a set of concurrent
edits.

## Offline-first guarantees

Sync is opt-in per Business Account/book. Turning it off must leave today's app
fully functional.

1. A normal sale, invoice, receipt, bill, payment, expense, capital operation,
   inventory move, party edit or configuration change commits locally without
   network access.
2. The local read model remains the source used by screens and reports. A
   server outage must not blank or stale-lock the app.
3. The business mutation and its durable outbox entry commit in one SQLite
   transaction/savepoint. A write cannot be locally visible but unsyncable.
4. Pending work survives process death, restart, connectivity changes and
   retry failures. Background execution is a latency optimization, not a
   correctness requirement.
5. Downloaded operations are applied with outbox capture disabled, so a remote
   event is not uploaded again.
6. Replays are idempotent. A timeout after server commit is safe to retry.
7. A user can always export the existing manual backup before enrollment or
   recovery.

## Semantic operation envelope

The unit of synchronization is a validated domain operation, not a database
row. One accounting action may create a source, journal header, journal lines,
allocations and stock moves; those rows must travel and apply atomically.

Every operation has this shape (field names are part of the wire contract):

```ts
type SyncOperation = {
  protocolVersion: number;
  payloadVersion: number;
  opId: string;                 // globally unique, immutable retry key
  bookId: string;               // never inferred from active UI state
  bookEpoch: string;            // changes after owner reset/restore/delete
  deviceId: string;
  deviceSequence: number;      // monotonic per device/book
  actorId: string;
  commandType: string;          // e.g. transaction.create, party.patch
  aggregateId: string;
  baseRevision: number | null;  // revision observed before this command
  dependencies: string[];       // operation IDs that must precede it
  payload: unknown;
  payloadHash: string;
  clientCreatedAt: string;      // audit information only; never ordering
  businessDate?: string;
};
```

`opId` is idempotency scoped to a book epoch. Reusing an `opId` with a different
payload hash is rejected. The server assigns the canonical, monotonically
increasing `bookSequence`; device clocks never decide accounting order.

The command type must identify intent, for example:

- `transaction.create`, `transaction.replace`, `transaction.reverse`
- `receipt.allocate` and `receipt.unallocate`
- `party.create`, `party.patch`, `party.archive`
- `product.patch`, `stock.move`, `inventory.count.record`
- `location.create`, `location.patch`, `location.archive`
- `book.config.patch`, `period.close`, `book.epoch.advance`

Commands are versioned and validated before touching the local read model. A
new client must reject an unknown command/payload version without dropping the
outbox item.

## Device data model

The local schema should add tables equivalent to:

- `sync_profiles`: opt-in state, self-host URL, account identity and protocol
  capabilities (credentials belong in SecureStore, not SQLite).
- `sync_outbox`: `op_id`, book/epoch, sequence, command, payload, hash, status,
  attempt count, next retry time and last error.
- `sync_applied_ops`: accepted `op_id` and canonical `book_sequence` for
  deduplication.
- `sync_book_state`: server cursor, epoch, snapshot/checkpoint hash and schema
  versions.
- `sync_entity_revisions`: accepted revision per aggregate.
- `sync_conflicts`: base/local/canonical operation references and resolution
  state.
- `sync_tombstones`: retained identity for archive/delete semantics.

Table names may differ, but the following properties are mandatory: durable
outbox, idempotency records, a per-book cursor, conflict records and tombstone
retention. Remote apply must be atomic and resumable.

## Push/pull protocol

The correctness path is cursor-based push/pull over HTTPS. A future WebSocket
may notify the app that data is available, but it must not replace pull.

`POST /v1/sync/push` accepts an ordered batch and returns, for each operation,
one of `accepted`, `duplicate`, `conflict`, `rejected` or `retryable`, together
with the canonical sequence or conflict ID. `GET /v1/sync/pull?bookId=...&deviceId=...&after=...&limit=...`
returns canonical events after the last committed cursor. The `deviceId` is required
so the server can enforce explicit enrollment, expiry, and revocation. A batch is applied
only after all dependency IDs are present; dependency gaps are retried rather
than partially applied.

For each accepted operation the server transaction authenticates the actor and
device, checks membership, deduplicates `opId`, locks the affected aggregate or
book barrier, validates the base revision and accounting invariants, appends a
canonical event, updates projections/revisions and assigns `bookSequence`.

Client sync order is:

1. Pull and apply remote events up to a safe cursor.
2. Push pending local operations in `deviceSequence` order (batching is fine).
3. Pull again to receive canonical events generated by this device and other
   devices.
4. Commit the cursor only after the local transaction and all dependent
   projections are durable.

Network retries use bounded exponential backoff with jitter. HTTP 401/403,
epoch mismatch and permanent validation errors are surfaced to the user; they
are not retried forever.

## Bootstrap and recovery

Enrollment must identify one Business Account/book and one `bookEpoch`.
When the server epoch is empty, enrollment records only the server-issued epoch
and keeps sync disabled. The user must review the self-hosted destination and
explicitly choose **Publish initial snapshot** before any local accounting data
is uploaded or sync is enabled. A new device joining a populated epoch downloads
a validated snapshot, installs it atomically, then replays any local outbox
created after snapshot creation.

The server derives each snapshot's aggregate-revision map from canonical events
in the active epoch at or before its checkpoint; a client-supplied map is never
trusted. Snapshot installation restores those revisions atomically with the
one-book projection so later edits compare against the correct canonical base.

An owner reset, restore or delete advances the epoch. Devices holding the old
epoch must stop pushing and pulling until re-enrolled; stale outbox entries are
kept for audit/recovery and cannot resurrect old data. Never raw-merge two
populated databases. A guided import may create a separate book or create
explicit, audited commands.

## Shared versus device-local state

Shared state includes V2 accounting operations, Business Accounts, Customers,
Suppliers, Capital Accounts, Products, stock moves, Locations, periods,
close-book results and enabled shared feature configuration.

Device-local state includes active Location, theme/UI preferences, app lock and
biometric settings, AI credentials, refresh tokens, transient navigation and
Ask AI history unless separately specified. In particular, `enabledFeatures`
may be shared while `activeLocationId` remains device-local.

## Security baseline

The self-hosted deployment is the initial trust boundary: the server must read
operations to validate balanced journals, allocations, period close and
permissions. Use OAuth 2.1 Authorization Code + PKCE (or a documented OIDC
provider), short-lived access tokens, rotating refresh tokens in Expo
SecureStore, HTTPS outside local development, expiring device enrollment, and
owner-visible device revocation. Encrypt server volumes and backups; keep key
material separate from backup archives. Never sync API keys, refresh tokens,
app-lock secrets or biometric material.

Server authorization is book-scoped and role-aware (Owner, Admin, Accountant,
Viewer, Auditor, and optionally Close Books). Revocation blocks future sync but
cannot remotely erase data already downloaded to a device; this limitation
must be disclosed.

## Compatibility and observability

The server advertises supported protocol/payload versions. Clients negotiate
before enrollment and preserve unknown fields for forward compatibility where
possible. Structured logs must redact payload secrets and financial details
unless explicitly configured. Expose health/readiness, sync latency, rejected
operation counts, conflict counts and projection/checkpoint hashes.

## Exit criteria for the first release

- Sync off is indistinguishable from the current offline-only behavior.
- Local mutation and outbox insertion are atomic.
- Independent offline entries converge exactly once on two devices.
- Same-record financial edits never silently overwrite; conflicts are audited.
- Reports, trial balance, allocations, stock and capital projections reconcile
  on every converged device.
- Snapshot recovery preserves unsent local work.
- Revoked devices and cross-book access are rejected server-side.
- Manual backup remains available and has been restored in an automated drill.
