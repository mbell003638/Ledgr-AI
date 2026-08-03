/**
 * Factory reset vs. the authoritative V2 SQLite store. [device-verified crash]
 *
 * Repro (screenshot): factory reset → "Get Started" on onboarding →
 * "UNIQUE constraint failed: v2_books.id". Root cause: the factory reset ran
 * resetAllV2AccountingData (which deliberately PRESERVES book identity rows —
 * v2_books/v2_accounts/v2_personas/v2_members) and deleted the
 * `v2_book_version:*` meta keys — so onboarding saw version==null, called
 * initializeV2Book with the same deterministic active-book id, and the
 * INSERT INTO v2_books collided with the orphaned row.
 *
 * These tests run the real SQL against node:sqlite:
 *   1. FACTORY WIPE: the full reset sequence must leave ZERO rows in EVERY
 *      v2_* table, and a same-name re-onboarding must produce a usable book.
 *   2. UPGRADE PATH: devices that factory-reset on an OLD build still carry the
 *      orphan rows — initializeV2Book itself must self-heal (idempotent).
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { V2_TABLES } from '../src/db/schema';
import { initializeV2Book, accountingBookVersion, V2_BOOK_VERSION } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { resetAllV2AccountingData, factoryResetV2Data } from '../src/accountingV2/resetBook';
import { defaultAccounts } from '../src/accountingV2/schema';

/** Onboarding's finish() bootstrap (app/onboarding.tsx) for the active book id. */
async function onboardingBootstrap(runner: any, bookId: string, name: string) {
  const year = 2026;
  return initializeV2Book(runner, {
    book: { id: bookId, name, style: 'standard', basis: 'accrual' },
    period: { id: `${bookId}:period:${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
    personas: ['custom'],
  });
}

/** The V2 meta-key teardown performed by backend.resetBooksAndActiveBook(). */
async function wipeV2MetaKeys(runner: any) {
  await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
  await runner.run("DELETE FROM meta WHERE key LIKE 'v2_book_version:%'");
}

async function rowCount(runner: any, table: string): Promise<number> {
  return Number((await runner.first(`SELECT COUNT(*) AS n FROM ${table}`))?.n || 0);
}

describe('factory reset → onboarding (v2_books UNIQUE crash)', () => {
  it('leaves ZERO rows in every v2_* table, then a same-name onboarding produces a fresh usable book', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      // 1. Onboard + use the app (post real activity, incl. opening balances).
      await onboardingBootstrap(runner, 'default', 'Sharma Electronics');
      const service = new V2AppService(runner);
      await service.postOpeningBalances({ date: '2026-01-01', cash: 500, inventory: 200 });
      await service.createSale({ date: '2026-07-01', amount: 25 });
      await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Customer' });

      // 2. Factory reset — the constituent calls behind api.factoryReset /
      //    advanced-settings doFactoryReset (clearAccountingData → v2 reset,
      //    backend.resetBooksAndActiveBook → meta keys, then the scorched-earth
      //    V2 wipe).
      await resetAllV2AccountingData(runner, '2026-08-03');
      await wipeV2MetaKeys(runner);
      await factoryResetV2Data(runner);

      // 3. EVERY v2_* table must be empty — no orphaned book/account/persona rows.
      for (const table of V2_TABLES) {
        expect({ table, rows: await rowCount(runner, table) }).toEqual({ table, rows: 0 });
      }
      expect(await runner.all("SELECT key FROM meta WHERE key='v2_active_book_id' OR key LIKE 'v2_book_version:%'")).toEqual([]);

      // 4. Re-run onboarding with the SAME active book id + name. This is the
      //    exact call that crashed on-device with UNIQUE constraint failed.
      const result = await onboardingBootstrap(runner, 'default', 'Sharma Electronics');
      expect(result).toMatchObject({ bookId: 'default', version: V2_BOOK_VERSION });
      await expect(accountingBookVersion(runner, 'default')).resolves.toBe(V2_BOOK_VERSION);

      // 5. The fresh book is fully usable: opening balance + a sale post cleanly.
      const fresh = new V2AppService(runner);
      await expect(fresh.postOpeningBalances({ date: '2026-01-01', cash: 100, inventory: 0 })).resolves.toBeTruthy();
      await expect(fresh.createSale({ date: '2026-08-03', amount: 10 })).resolves.toMatchObject({ source: { type: 'cash_sale' } });
      expect(await rowCount(runner, 'v2_books')).toBe(1);
    } finally { close(); }
  });

  it('wipes multiple books (secondary accounts) too, and rolls back atomically on failure', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await onboardingBootstrap(runner, 'default', 'Main');
      await onboardingBootstrap(runner, 'book_xyz', 'Technician');
      await new V2AppService(runner).createSale({ date: '2026-07-01', amount: 5 });

      // Atomicity: a mid-wipe failure must not leave a half-deleted store.
      await runner.exec("CREATE TRIGGER reject_book_wipe BEFORE DELETE ON v2_books BEGIN SELECT RAISE(ABORT, 'wipe rejected'); END;");
      await expect(factoryResetV2Data(runner)).rejects.toThrow(/wipe rejected/i);
      expect(await rowCount(runner, 'v2_books')).toBe(2);
      expect(await rowCount(runner, 'v2_accounts')).toBe(defaultAccounts('x').length * 2);

      await runner.exec('DROP TRIGGER reject_book_wipe');
      await factoryResetV2Data(runner);
      for (const table of V2_TABLES) {
        expect({ table, rows: await rowCount(runner, table) }).toEqual({ table, rows: 0 });
      }
    } finally { close(); }
  });
});

describe('initializeV2Book idempotency (upgrade path: orphan rows from an old build)', () => {
  it('self-heals when a factory reset on an OLD build left orphaned v2 rows without version meta', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      // A device that factory-reset on the buggy build: full book skeleton rows
      // remain (books/accounts/personas/members + the reset's fresh period),
      // but the v2_book_version meta key is gone.
      await initializeV2Book(runner, {
        book: { id: 'default', name: 'Old Shop', style: 'retail_partnership' },
        period: { startDate: '2026-01-01', endDate: '2026-12-31' },
        personas: ['retail'],
        members: [{ name: 'Amit', openingContribution: 100, profitSharePct: 100 }],
      });
      await resetAllV2AccountingData(runner, '2026-08-03');
      await wipeV2MetaKeys(runner); // ← the old build stopped HERE (no row wipe)
      expect(await rowCount(runner, 'v2_books')).toBe(1); // the orphan

      // Onboarding runs again → must NOT throw UNIQUE constraint failed.
      const result = await onboardingBootstrap(runner, 'default', 'New Shop');
      expect(result).toMatchObject({ bookId: 'default', periodId: 'default:period:2026', version: V2_BOOK_VERSION });

      // The orphan was replaced wholesale — fresh identity, no stale leftovers.
      expect(await runner.first('SELECT name,style FROM v2_books WHERE id=?', ['default'])).toEqual({ name: 'New Shop', style: 'standard' });
      expect(await rowCount(runner, 'v2_books')).toBe(1);
      expect(await rowCount(runner, 'v2_members')).toBe(0); // stale members purged
      expect(await runner.all("SELECT type FROM v2_personas WHERE book_id='default'")).toEqual([{ type: 'custom' }]);
      expect(Number((await runner.first("SELECT COUNT(*) AS n FROM v2_periods WHERE book_id='default' AND status='open'"))?.n)).toBe(1);
      await expect(accountingBookVersion(runner, 'default')).resolves.toBe(V2_BOOK_VERSION);

      // Fresh book is usable end-to-end.
      const service = new V2AppService(runner);
      await expect(service.postOpeningBalances({ date: '2026-01-15', cash: 50, inventory: 10 })).resolves.toBeTruthy();
      await expect(service.createSale({ date: '2026-08-03', amount: 12 })).resolves.toMatchObject({ source: { type: 'cash_sale' } });
    } finally { close(); }
  });

  it('tolerates a bare orphaned v2_books row (no children) without a UNIQUE violation', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const { initSchema } = require('../src/db/schema');
      await initSchema(runner);
      await runner.run('INSERT INTO v2_books(id,name,style,basis,created_at) VALUES(?,?,?,?,?)',
        ['default', 'Ghost', 'standard', 'accrual', '2025-01-01T00:00:00.000Z']);

      const result = await onboardingBootstrap(runner, 'default', 'Fresh Start');
      expect(result).toMatchObject({ bookId: 'default', version: V2_BOOK_VERSION });
      expect(await runner.first('SELECT name FROM v2_books WHERE id=?', ['default'])).toEqual({ name: 'Fresh Start' });
      expect(await rowCount(runner, 'v2_accounts')).toBe(defaultAccounts('default').length);
    } finally { close(); }
  });
});
