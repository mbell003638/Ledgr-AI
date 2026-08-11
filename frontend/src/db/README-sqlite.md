# SQLite storage architecture

SQLite is initialized at app startup and is the only accounting database. This
is a clean-install implementation: startup creates the current schema and does
not inspect, copy, or translate an older accounting store.

## Data boundary

- Normalized `v2_*` tables are authoritative for books, periods, accounts,
  parties, source documents, journals, inventory counts, and partner capital.
- The `settings` document stores business/UI preferences only. Accounting style
  is persisted in `v2_books`; balances and entries are never settings fields.
- Row-per-record collection tables are limited to non-posting documents and app
  records such as quotes and delivery notes. They are not a second ledger.

## Files

| File | Role |
|------|------|
| `schema.ts` | Current table DDL and `initSchema()` |
| `sqliteStore.ts` | Collection/preference primitives and atomic restore support |
| `expoRunner.ts` | Runtime adapter over `expo-sqlite` |
| `backend.ts` | Book selection and startup initialization |

Backups restore the current document collections, preferences, and normalized
V2 tables atomically. This is backup/restore of the current format, not a legacy
migration path.
