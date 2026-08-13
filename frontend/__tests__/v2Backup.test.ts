/**
 * V2 ledger backup/restore round-trip. [C1]
 *
 * Runs the REAL SQL under node:sqlite (same runner the other v2 tests use).
 * Seeds a V2 book with a sale + invoice (populating v2_sources,
 * v2_journal_entries, v2_journal_lines, v2_accounts, v2_periods, v2_parties,
 * meta), exports it, wipes every v2 table, imports the payload back, and asserts
 * row counts + a sample journal line survive intact.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book, V2_BOOK_VERSION } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2_TABLES } from '../src/db/schema';
import { DELETE_ORDER, INSERT_ORDER, exportV2Data, importV2Data, V2_BACKUP_VERSION } from '../src/db/v2Backup';
import { V2_COLLECTIONS } from '../src/accountingV2/types';
import { withImportTransaction } from '../src/db/sqliteStore';

async function countAll(runner: any): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of V2_TABLES) {
    const row = (await runner.first(`SELECT COUNT(*) AS n FROM ${t}`)) as { n: number } | undefined;
    out[t] = Number(row?.n || 0);
  }
  return out;
}

describe('v2Backup table coverage', () => {
  it('DELETE_ORDER and INSERT_ORDER cover every V2_TABLES table', () => {
    expect(new Set(DELETE_ORDER)).toEqual(new Set(V2_TABLES));
    expect(new Set(INSERT_ORDER)).toEqual(new Set(V2_TABLES));
  });

  it('V2_COLLECTIONS matches schema V2_TABLES', () => {
    expect(new Set(V2_COLLECTIONS)).toEqual(new Set(V2_TABLES));
  });
});

describe('v2Backup export/import', () => {
  it('round-trips every v2 table + meta with row counts and a journal line intact', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk1', name: 'Round Trip Shop', style: 'retail_partnership' },
        period: { id: 'bk1:p', startDate: '2026-01-01', endDate: '2026-12-31' },
        personas: ['retail', 'custom'],
        members: [{ name: 'Amit', openingContribution: 100, profitSharePct: 50 }],
      });
      const service = new V2AppService(runner);
      await service.createSale({ date: '2026-07-01', amount: 25 });
      await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Acme' });

      const before = await countAll(runner);
      // Sanity: seeding actually populated the ledger tables.
      expect(before.v2_books).toBe(1);
      expect(before.v2_sources).toBeGreaterThanOrEqual(2);
      expect(before.v2_journal_entries).toBeGreaterThanOrEqual(2);
      expect(before.v2_journal_lines).toBeGreaterThanOrEqual(4);
      expect(before.v2_members).toBe(1);

      // Capture a sample journal line to compare after the round-trip.
      const sampleLine = await runner.first<any>(
        'SELECT journal_id, account_id, debit, credit FROM v2_journal_lines ORDER BY id LIMIT 1');
      const sourceRows = await runner.all<any>('SELECT id,type,date FROM v2_sources ORDER BY id');

      const payload = await exportV2Data(runner);
      expect(payload.schemaVersion).toBe(V2_BACKUP_VERSION);
      expect(payload.meta['v2_active_book_id']).toBe('bk1');
      expect(payload.meta['v2_book_version:bk1']).toBe(String(V2_BOOK_VERSION));

      // Wipe + restore inside one transaction (as the app does).
      const result = await withImportTransaction(runner, async () => importV2Data(runner, payload));
      expect(result.restored).toBe(true);
      expect(result.warnings).toEqual([]);

      const after = await countAll(runner);
      expect(after).toEqual(before);

      // Meta restored.
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_active_book_id'")).toEqual({ value: 'bk1' });
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_book_version:bk1'")).toEqual({ value: String(V2_BOOK_VERSION) });

      // Sample journal line survived byte-for-byte.
      const sampleAfter = await runner.first<any>(
        'SELECT journal_id, account_id, debit, credit FROM v2_journal_lines ORDER BY id LIMIT 1');
      expect(sampleAfter).toEqual(sampleLine);

      // Sources round-trip identically.
      expect(await runner.all<any>('SELECT id,type,date FROM v2_sources ORDER BY id')).toEqual(sourceRows);

      // Ledger still balances after the restore.
      const bal = await runner.first<{ d: number; c: number }>(
        `SELECT SUM(l.debit) AS d, SUM(l.credit) AS c FROM v2_journal_lines l
         JOIN v2_journal_entries e ON e.id=l.journal_id WHERE e.book_id='bk1'`);
      expect(Number(bal?.d)).toBeCloseTo(Number(bal?.c), 5);
    } finally { close(); }
  });

  it('is idempotent — a second import of the same payload yields identical counts', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk2', name: 'Shop 2' },
        period: { id: 'bk2:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      await new V2AppService(runner).createSale({ date: '2026-03-01', amount: 10 });
      const payload = await exportV2Data(runner);
      const before = await countAll(runner);

      await withImportTransaction(runner, async () => importV2Data(runner, payload));
      await withImportTransaction(runner, async () => importV2Data(runner, payload));

      expect(await countAll(runner)).toEqual(before);
    } finally { close(); }
  });

  it('tolerates unknown extra columns/tables gracefully (skips + warns)', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk3', name: 'Shop 3' },
        period: { id: 'bk3:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const payload = await exportV2Data(runner);
      // Inject an unknown table and an unknown column on a known table.
      (payload.tables as any).v2_future_table = [{ id: 'x', mystery: 1 }];
      payload.tables.v2_books = payload.tables.v2_books.map((r: any) => ({ ...r, unknown_col: 'ignore-me' }));

      const result = await withImportTransaction(runner, async () => importV2Data(runner, payload));
      expect(result.restored).toBe(true);
      expect(result.warnings.some((w) => w.includes('v2_future_table'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('v2_books.unknown_col'))).toBe(true);
      // The known row still restored despite the unknown column.
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(1);
    } finally { close(); }
  });

  it('restores journal reversals (self-referential reversal_of) in a safe order', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk4', name: 'Shop 4' },
        period: { id: 'bk4:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      // Post a sale then delete it (deletion posts a reversal journal referencing the original).
      const sale = await new V2AppService(runner).createSale({ date: '2026-05-01', amount: 15 });
      await new V2AppService(runner).deleteSale(sale.source.id);
      const reversalCount = Number((await runner.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n);
      expect(reversalCount).toBeGreaterThanOrEqual(1);

      const payload = await exportV2Data(runner);
      const result = await withImportTransaction(runner, async () => importV2Data(runner, payload));
      expect(result.restored).toBe(true);
      expect(Number((await runner.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n)).toBe(reversalCount);
    } finally { close(); }
  });
});
