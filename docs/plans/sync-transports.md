# Multi-device sync: Wi-Fi P2P and personal cloud drive

**Written to be picked up cold.** If you have never seen this repository, everything
you need is here. Do not assume prior context.

- **Status:** proposed, not started.
- **Applies to:** `Manus-on-device-ai` and `Manus` (richest sync UI); `codex-sol*`
  has a subset — see §2.2.
- **Last updated:** 2026-09-06.

**Goal.** Keep the self-hosted server exactly as it is, and add two transports that
need no server at all, so a shop owner who cannot rent a VPS can still sync two
devices and keep an off-device backup.

---

## 1. Why this is smaller than it sounds

Sync is not being rebuilt. The hard parts already exist and are transport-agnostic:

| Piece | Where | Reused |
|---|---|---|
| Operation log, hashing, validation | `src/sync/protocol.ts` | as-is |
| Outbox with retry and conflict states | `src/sync/outbox.ts` | as-is |
| Conflict detection and resolution | `src/sync/conflicts.ts`, `app/sync-conflicts.tsx` | as-is |
| Projection / replay into state | `src/sync/projection.ts` | as-is |
| Recovery and book epochs | `src/sync/recovery.ts` | as-is |
| **AES envelope + integrity hash** | `src/utils/backupEncryption.ts` | **as-is** |
| QR pairing payload | `src/sync/qrEnrollment.ts`, `app/sync-scan.tsx` | extended |

`backupEncryption.ts` already exports `encryptBackup`, `decryptBackup`,
`backupIntegrityHash` and `verifyBackupIntegrity`. The zero-knowledge encryption a
cloud transport needs is **already written and tested** — this work adds transports,
not cryptography.

**The entire server surface is four calls**, all issued through one `request()`
helper at `src/sync/coordinator.ts:226`:

| Call | Line |
|---|---|
| `GET /v1/sync/pull?bookId&deviceId&after=<cursor>&limit` | 257 |
| `POST /v1/sync/push {bookId, operations}` | 389 |
| `GET /v1/sync/conflicts?bookId&deviceId&status=open` | 323 |
| `POST /v1/sync/conflicts/resolve` | 347 |

That single call site is the seam. Everything below hangs off replacing it with an
interface.

---

## 2. Orientation

### 2.1 Commands

From `frontend/`: `npx tsc --noEmit`, `npm run lint:ci`, `npx jest`.
Baseline at time of writing: `Manus-on-device-ai` — 114 suites / 800 tests.

### 2.2 Branch differences

`Manus*` carries the full sync UI — `sync-scan`, `sync-admin`, `sync-health`,
`private-sync-guide`, `private-sync-migration`. `codex-sol*` has only
`sync-settings`, `sync-conflicts`, `sync-conflict-correction`. Do the work on Manus
first, then port the UI per branch, as `advanced-settings.tsx` already had to be.

---

## 3. The one hard problem: ordering without a server

Every operation already carries `deviceId`, `deviceSequence`, `baseRevision`,
`dependencies` and `payloadHash`. What the **server** adds is `bookSequence` — one
total order every device agrees on (`CanonicalSyncOperation` in `protocol.ts`).

Neither Google Drive nor a phone on Wi-Fi can assign that. Drive is a dumb file store
with no atomic compare-and-swap; a peer is just another device with no more authority
than yours.

### D1. Per-device append-only logs, merged deterministically

Each device writes **only its own** log — `book-<bookId>/device-<deviceId>.log` — and
never another device's. Since no two writers ever touch the same object, there is no
lock to take and no race to lose.

Every device reads all logs and derives the same order locally:

```
sort by (clientCreatedAt, deviceId, deviceSequence)
```

All three fields are already on `SyncOperation`, and the triple is unique. Every
device computes an identical sequence from identical inputs, so `bookSequence`
becomes *locally derived* rather than server-assigned, and projection replays exactly
as it does today.

**What this costs, stated plainly.** With a server, "accepted" means the server
agreed. Without one, it means "ordered by a rule every device shares". Two devices
editing the same aggregate offline will both succeed locally and reconcile on merge —
which is precisely what `conflicts.ts` already exists to handle. Server mode is
unchanged and remains the strictest; that is a reason to keep it, not to replace it.

---

## 4. Decisions

### D2. One transport interface, not three sync engines

```ts
export type SyncTransport = {
  id: 'server' | 'drive' | 'p2p';
  pull(after: number, limit: number): Promise<CanonicalSyncOperation[]>;
  push(operations: SyncOperation[]): Promise<{ opId: string; bookSequence: number }[]>;
  listConflicts(): Promise<unknown[]>;
  resolveConflict(input: { conflictId: string; resolutionType: string; resolutionOpId?: string }): Promise<void>;
};
```

`coordinator.ts` keeps its logic and calls a transport instead of `fetch`. The
existing HTTP code becomes `serverTransport`, unchanged, so **the audited path keeps
behaving exactly as it does today** and the new transports cannot regress it.

### D3. Cloud drive: Google Drive only, and `appDataFolder`

**iCloud is not deliverable and should not be advertised.** CloudKit has no usable
third-party Android API, and this app is Android-only (`abiFilters "arm64-v8a"`, an
Android-only native module). Ship Drive; revisit iCloud only if an iOS build happens.
Naming iCloud in the UI would promise something the app cannot do.

Use the **`drive.appdata`** scope, not full Drive:

- a hidden per-app folder, so nothing clutters the user's own Drive
- **not a Google "restricted scope"**, so it avoids the security assessment that makes
  full-Drive access slow and expensive to ship
- the user still owns the bytes, and uninstalling removes them

Every log is encrypted with the existing `encryptBackup` before upload, keyed from a
passphrase the user sets. **Google stores ciphertext only.** Losing the passphrase
loses the data — say so at setup, and offer a recovery code.

### D4. P2P: carry the address in the QR, skip mDNS

Discovery is the expensive part of P2P, and Expo ships no mDNS. Skip it — the QR flow
already exists for enrollment, so **put the peer's LAN address in the QR payload**:

```
scan QR -> ws://192.168.1.42:8765 + bookId + one-time pairing secret
```

Same three taps as discovery, none of the native dependency. Add mDNS later only if
pairing by QR proves annoying in practice.

The pairing secret authenticates the peer and derives the session key, so someone else
on the same café Wi-Fi cannot join by guessing an address.

### D5. Transports are not exclusive

A book may use Drive *and* P2P at once: P2P when both devices are on the same network,
Drive as the always-available path and the off-device backup. Because both are just
operation logs merged by the same rule, running both converges to the same state — D1
is what makes that safe rather than lucky.

---

## 5. Capability matrix — keep the UI honest

| | Self-hosted | Google Drive | Wi-Fi P2P |
|---|---|---|---|
| Setup | VPS, DNS, Docker | **one tap** | **scan a QR** |
| Works away from home | yes | **yes** | no |
| Off-device backup | yes | **yes** | **no** |
| Propagation | near-instant | on open / periodic poll | instant, same LAN |
| Multi-user roles, audit trail | **yes** | no | no |
| Ongoing cost | VPS | none | none |

**Drive is not slow in a way that matters here.** A ledger is small; the constraint is
*propagation* — without a server there are no push notifications, so the app polls —
not throughput. Sync landing within a minute is indistinguishable from instant for
bookkeeping. P2P has no backup story at all, which is why Drive is the default of the
two.

---

## 6. Phases

**Phase 1 — the transport seam.** Extract `SyncTransport`, move the existing HTTP into
`serverTransport`, route `coordinator.ts` through it. No behaviour change. Green tests
here are what prove the audited path is intact.

**Phase 2 — deterministic merge.** Implement D1 as a pure function over operation
lists, assigning a local `bookSequence`. Property-test it: any interleaving of the
same operations, from any device, in any arrival order, produces an identical result.

**Phase 3 — Drive transport.** OAuth with `drive.appdata`; per-device encrypted log
objects; pull merges all peer logs; push appends to your own. Passphrase setup,
recovery code, and a first-run explanation that Google sees ciphertext only.

**Phase 4 — P2P transport.** QR carrying address plus pairing secret; a small
WebSocket listener on the host device; exchange logs; merge with the Phase 2 function.

**Phase 5 — UI.** Transport picker in `sync-settings.tsx` presenting §5 in plain
words; per-transport status; the conflict inbox unchanged.

Phases 1 and 2 are pure logic and fully testable under jest. Phases 3 and 4 need real
devices.

---

## 7. Risks

- **Passphrase loss is unrecoverable** by design. Mitigate with a recovery code at
  setup and a plain warning; do not bury it in help text.
- **Drive quota exhausted or access revoked** must degrade to "sync paused", never to
  data loss. The local book stays authoritative at all times.
- **Clock skew** affects the `clientCreatedAt` sort. Ties break on `deviceId` and
  `deviceSequence`, so ordering stays deterministic, but a badly wrong clock can order
  operations oddly. Consider a monotonic counter alongside the wall clock.
- **P2P on public Wi-Fi**: the pairing secret is the only thing preventing a stranger
  connecting. Never accept an unpaired peer, and expire pairing codes quickly.
- **Scope creep**: none of this should touch the server path. If a change would alter
  server behaviour, it belongs in separate work.
