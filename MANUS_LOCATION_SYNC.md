# Manus Location Accounting Sync

This branch selectively integrates the location accounting work from codex-sol commit `6893894` into the persona-driven `Manus` branch.

## Included

The integration adds migration-safe `location_id` columns to V2 sources, journal lines, and stock moves; adds the per-book V2 locations table; propagates location provenance through sales, invoices, receipts, purchases, supplier payments, expenses, notes, COGS, product movements, and journal reversals; and adds journal-backed cash and stock transfers with source-location availability checks.

Reports and dashboards now support an optional shop filter. Home and Reports can show consolidated `All locations` totals or a selected shop, while preserving the consolidated ledger as the default. Location selection is controlled by the Manus `multi_location` capability rather than a legacy feature flag.

The Locations screen includes active shop selection, journal-backed cash transfers, stock transfers, and a POS-session entry point. The dedicated Stock Transfers screen also writes and reads authoritative V2 transfer records. POS sessions remain lightweight operational records because drawer lifecycle metadata is not itself a double-entry posting.

## Deliberately preserved

Manus’s persona/capability registry, focused onboarding, Book Health, AI review boundaries, fixed-asset register, fixed-asset tests, and existing multi-persona compatibility remain intact. The destructive fixed-asset removal and unrelated schema changes from the codex branch were not imported.

The schema version remains `8` for compatibility with existing Manus tests and migrations. The location columns are added with `addColumnIfMissing`, and fixed-asset tables remain in schema, backup, factory reset, and book deletion orders.

## Validation

The following checks passed on this branch:

- `npx tsc --noEmit`
- `npm run lint:ci`
- `npx jest --runInBand` — 75 suites and 566 tests passed
- `npx expo-doctor` — 18/18 checks passed
- `npx expo export --platform android --output-dir /tmp/manus-android-export --clear`
- `git diff --cached --check`
