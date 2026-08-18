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
      await runner.run(
        'INSERT INTO v2_locations(id,book_id,name,archived) VALUES(?,?,?,?)',
        ['loc1', 'bk1', 'Main Warehouse', 0],
      );
      await runner.run(
        `INSERT INTO v2_employees(id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived)
         VALUES(?,?,?,?,?,?,?,?)`,
        ['emp1', 'bk1', 'Rina', 'Manager', 30, 12, '2026-01-15', 0],
      );
      await runner.run(
        'INSERT INTO v2_pay_runs(id,book_id,period_id,date,notes,source_id) VALUES(?,?,?,?,?,?)',
        ['run1', 'bk1', 'bk1:p', '2026-07-31', 'July payroll', null],
      );
      await runner.run(
        'INSERT INTO v2_payslips(id,pay_run_id,employee_id,gross,tax_withheld,net,notes) VALUES(?,?,?,?,?,?,?)',
        ['slip1', 'run1', 'emp1', 1200, 144, 1056, 'Monthly payroll'],
      );
      await runner.run(
        'INSERT INTO v2_products(id,book_id,sku,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,?,?)',
        ['prod1', 'bk1', 'SKU-1', 'Widget', 'each', 4, 9, 15, 0],
      );
      await runner.run(
        `INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id,location_id)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        ['move1', 'bk1', 'prod1', '2026-07-03', 15, 4, 'opening', null, 'loc1'],
      );

      const before = await countAll(runner);
      // Sanity: seeding actually populated the ledger tables.
      expect(before.v2_books).toBe(1);
      expect(before.v2_sources).toBeGreaterThanOrEqual(2);
      expect(before.v2_journal_entries).toBeGreaterThanOrEqual(2);
      expect(before.v2_journal_lines).toBeGreaterThanOrEqual(4);
      expect(before.v2_members).toBe(1);
      expect(before.v2_employees).toBe(1);
      expect(before.v2_pay_runs).toBe(1);
      expect(before.v2_payslips).toBe(1);
      expect(before.v2_products).toBe(1);
      expect(before.v2_stock_moves).toBe(1);
      expect(before.v2_locations).toBe(1);

      // Capture a sample journal line to compare after the round-trip.
      const sampleLine = await runner.first<any>(
        'SELECT journal_id, account_id, debit, credit FROM v2_journal_lines ORDER BY id LIMIT 1');
      const sourceRows = await runner.all<any>('SELECT id,type,date FROM v2_sources ORDER BY id');
      const payrollRelationship = await runner.first<any>(
        `SELECT s.id, r.book_id, r.period_id, s.employee_id
         FROM v2_payslips s JOIN v2_pay_runs r ON r.id=s.pay_run_id WHERE s.id='slip1'`,
      );
      const stockRelationship = await runner.first<any>(
        `SELECT m.id, m.product_id, m.location_id, p.book_id
         FROM v2_stock_moves m JOIN v2_products p ON p.id=m.product_id WHERE m.id='move1'`,
      );

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
      expect(await runner.first<any>(
        `SELECT s.id, r.book_id, r.period_id, s.employee_id
         FROM v2_payslips s JOIN v2_pay_runs r ON r.id=s.pay_run_id WHERE s.id='slip1'`,
      )).toEqual(payrollRelationship);
      expect(await runner.first<any>(
        `SELECT m.id, m.product_id, m.location_id, p.book_id
         FROM v2_stock_moves m JOIN v2_products p ON p.id=m.product_id WHERE m.id='move1'`,
      )).toEqual(stockRelationship);

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

  it('migrates a complete V2 schema-v1 payload and initializes new module tables', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk3', name: 'Shop 3' },
        period: { id: 'bk3:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const payload = await exportV2Data(runner);
      payload.schemaVersion = 1;
      for (const table of [
        'v2_employees', 'v2_pay_runs', 'v2_payslips',
        'v2_products', 'v2_stock_moves', 'v2_locations',
      ]) delete payload.tables[table];

      const result = await withImportTransaction(runner, async () => importV2Data(runner, payload));
      expect(result.restored).toBe(true);
      expect(result.warnings).toContain('Migrated V2 backup schema v1 to v2.');
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(1);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_products'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects newer schemas and data-bearing unknown tables/columns before wiping live data', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'compat', name: 'Compatibility Shop' },
        period: { id: 'compat:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const payload = await exportV2Data(runner);

      await expect(withImportTransaction(runner, async () => importV2Data(runner, {
        ...payload,
        schemaVersion: V2_BACKUP_VERSION + 1,
      }))).rejects.toThrow(/Unsupported V2 backup schema/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(1);

      (payload.tables as any).v2_future_table = [{ id: 'future-row' }];
      await expect(withImportTransaction(runner, async () => importV2Data(runner, payload)))
        .rejects.toThrow(/data-bearing unknown V2 backup table/i);
      delete (payload.tables as any).v2_future_table;
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(1);

      payload.tables.v2_books[0].future_required_value = 0;
      await expect(withImportTransaction(runner, async () => importV2Data(runner, payload)))
        .rejects.toThrow(/data-bearing unknown V2 backup column/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(1);
    } finally { close(); }
  });

  it('refuses export when preserved legacy Fixed Asset Register tables contain data', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'assets', name: 'Asset Shop' },
        period: { id: 'assets:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      await runner.exec('CREATE TABLE v2_fixed_assets (id TEXT PRIMARY KEY, name TEXT)');
      await runner.run('INSERT INTO v2_fixed_assets(id,name) VALUES(?,?)', ['asset1', 'Delivery Van']);

      await expect(exportV2Data(runner)).rejects.toThrow(/legacy Fixed Asset Register data/i);
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

  it('replaces managed identity metadata and removes references to books absent from the restore', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'bk5', name: 'Shop 5' },
        period: { id: 'bk5:p', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const payload = await exportV2Data(runner);
      payload.meta.v2_active_book_id = 'missing-book';
      payload.meta['v2_book_version:missing-book'] = String(V2_BOOK_VERSION);
      (payload.meta as Record<string, string>).unmanaged_key = 'must-not-import';

      await runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_book_version:stale-local',?)", ['2']);
      const result = await withImportTransaction(runner, async () => importV2Data(runner, payload));

      expect(result.warnings).toEqual(expect.arrayContaining([
        'Removed invalid active V2 book reference: missing-book',
        'Removed invalid V2 book version reference: missing-book',
      ]));
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_active_book_id'")).toBeNull();
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_book_version:missing-book'")).toBeNull();
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_book_version:stale-local'")).toBeNull();
      expect(await runner.first("SELECT value FROM meta WHERE key='unmanaged_key'")).toBeNull();
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_book_version:bk5'")).toEqual({ value: String(V2_BOOK_VERSION) });
    } finally {
      close();
    }
  });
});
