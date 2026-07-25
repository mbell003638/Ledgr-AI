# Phase 2B — SQLite storage backend (ACTIVE)

> **Status: ACTIVE (opt-in wired in at startup).** The app now activates SQLite at
> launch via `initStorage()` in `app/_layout.tsx`. If SQLite fails to initialize
> for any reason, the app automatically falls back to the proven AsyncStorage
> layer — it can never hard-break. Your AsyncStorage data is preserved as a
> fallback (the migration is non-destructive), so `feature/html-parity` remains a
> clean revert target.

## Why

The AsyncStorage layer stores each collection as a **single JSON blob**. That's
simple and fast at a small shop's scale, but has structural limits:

- A corrupt write can poison an entire collection (all sales, all bills…).
- Every read/write serialises the *whole* collection, not just the changed row.
- Date-range reports scan the full in-memory array every time.

This backend stores **one row per record** in real SQLite tables (`id`, `date`,
`data`) with an index on `date`, giving row-level integrity, transactional
multi-row writes, and indexed range queries.

## What's here

| File | Role |
|------|------|
| `schema.ts` | `SqlRunner` interface, table DDL, `initSchema()` |
| `sqliteStore.ts` | `readColl`/`writeColl`/`readSettings`/`writeSettings` + non-destructive migration |
| `expoRunner.ts` | App-runtime adapter over `expo-sqlite` |
| `sqliteBootstrap.ts` | Opt-in entry point (`bootstrapSqlite()`) — **not called by the app yet** |
| `../../__tests__/sqliteStore.test.ts` | Real SQL tests via Node's built-in `node:sqlite` |
| `../../__tests__/helpers/nodeRunner.ts` | Test adapter over `node:sqlite` |

## Safety design

- **Non-destructive migration.** `migrateFromAsyncStorage()` copies legacy data
  into SQLite and **leaves AsyncStorage untouched** as a fallback.
- **Idempotent.** Guarded by a `migrated` flag in the `meta` table — runs once.
- **Never clobbers.** A collection is imported only if its SQLite table is empty,
  so re-running can't overwrite newer SQLite data.
- **Row-level resilience.** A single corrupt row is skipped, not fatal.

## How it was tested

All SQL runs for real under Node 22's built-in `node:sqlite` (no native build,
no mocks). `npm test` covers: schema creation, row round-trips, overwrite
semantics, `created_at` date fallback, corrupt-row skipping, settings upsert,
one-time migration, the "never overwrite non-empty table" guard, and malformed
legacy data. **53/53 tests pass** (money + accounting + sqlite suites).

## Activating it later (on-device, deliberate)

1. In app startup, call `await bootstrapSqlite()` once and log the returned
   import counts.
2. Verify on a device that your data appears correctly under SQLite.
3. Point `local.ts`'s four storage primitives at `sqliteStorage` (from
   `sqliteBootstrap.ts`) — all report/accounting logic stays unchanged.
4. Keep AsyncStorage data as a fallback until you're fully confident.

Because the app can't be runtime-tested on the build host (Raspberry Pi, no
emulator), step 2 is your on-device confidence gate before any switch-over.
