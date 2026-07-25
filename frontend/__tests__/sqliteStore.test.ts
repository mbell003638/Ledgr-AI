/**
 * Phase 2B SQLite storage tests — run the REAL SQL under node:sqlite.
 *
 * These exercise the schema, the row-per-record store (readColl/writeColl/
 * settings), transactional overwrite, and the non-destructive AsyncStorage
 * migration — the same code paths the app uses via expo-sqlite.
 */

import { initSchema, COLLECTIONS, SCHEMA_VERSION } from '../src/db/schema';
import {
  readColl,
  writeColl,
  readSettings,
  writeSettings,
  migrateFromAsyncStorage,
} from '../src/db/sqliteStore';
import { makeNodeRunner } from './helpers/nodeRunner';

describe('schema', () => {
  it('creates every collection table + settings + meta and stamps version', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const tables = await runner.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      );
      const names = tables.map((t) => t.name);
      for (const c of COLLECTIONS) expect(names).toContain(c);
      expect(names).toContain('settings');
      expect(names).toContain('meta');
      const v = await runner.first<{ value: string }>(`SELECT value FROM meta WHERE key='schema_version'`);
      expect(v?.value).toBe(String(SCHEMA_VERSION));
    } finally {
      close();
    }
  });
});

describe('readColl / writeColl', () => {
  it('round-trips records as individual rows with indexed date', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const sales = [
        { id: 's1', date: '2026-07-01', amount: 100 },
        { id: 's2', date: '2026-07-02', amount: 250.5 },
      ];
      await writeColl(runner, 'sales', sales);
      const back = await readColl(runner, 'sales');
      expect(back).toHaveLength(2);
      expect(back.find((x: any) => x.id === 's2')).toMatchObject({ amount: 250.5 });

      // date extracted into its own column for range queries
      const rows = await runner.all<{ id: string; date: string }>(
        `SELECT id, date FROM sales ORDER BY date`,
      );
      expect(rows[0]).toMatchObject({ id: 's1', date: '2026-07-01' });
    } finally {
      close();
    }
  });

  it('writeColl fully replaces prior contents (overwrite semantics)', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      await writeColl(runner, 'expenses', [{ id: 'e1', date: '2026-01-01', amount: 5 }]);
      await writeColl(runner, 'expenses', [{ id: 'e2', date: '2026-01-02', amount: 7 }]);
      const back = await readColl(runner, 'expenses');
      expect(back).toHaveLength(1);
      expect((back[0] as any).id).toBe('e2');
    } finally {
      close();
    }
  });

  it('falls back to created_at when no date field is present', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      await writeColl(runner, 'suppliers', [{ id: 'sup1', name: 'Acme', created_at: '2026-03-03T10:00:00Z' }]);
      const row = await runner.first<{ date: string }>(`SELECT date FROM suppliers WHERE id='sup1'`);
      expect(row?.date).toBe('2026-03-03T10:00:00Z');
    } finally {
      close();
    }
  });

  it('skips a single corrupt row instead of failing the whole read', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      await writeColl(runner, 'bills', [{ id: 'b1', date: '2026-05-05', amount: 10 }]);
      // inject a deliberately corrupt data blob
      await runner.run(`INSERT INTO bills(id, date, data) VALUES('bad', '2026-05-06', ?)`, ['{not json']);
      const back = await readColl(runner, 'bills');
      expect(back).toHaveLength(1);
      expect((back[0] as any).id).toBe('b1');
    } finally {
      close();
    }
  });
});

describe('settings store', () => {
  it('round-trips the settings document', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      expect(await readSettings(runner)).toEqual({});
      await writeSettings(runner, { currency: 'CAD', taxRate: 5 });
      expect(await readSettings(runner)).toEqual({ currency: 'CAD', taxRate: 5 });
      // upsert overwrites
      await writeSettings(runner, { currency: 'USD' });
      expect(await readSettings(runner)).toEqual({ currency: 'USD' });
    } finally {
      close();
    }
  });
});

describe('migrateFromAsyncStorage — non-destructive one-time import', () => {
  function fakeLegacy(store: Record<string, string>) {
    return async (key: string) => store[key] ?? null;
  }

  it('imports legacy collections + settings, exactly once', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const legacy = fakeLegacy({
        'ledgr:sales': JSON.stringify([{ id: 's1', date: '2026-07-01', amount: 100 }]),
        'ledgr:bills': JSON.stringify([{ id: 'b1', date: '2026-07-01', amount: 40 }]),
        'ledgr:settings': JSON.stringify({ currency: 'INR', openingCash: 500 }),
      });

      const first = await migrateFromAsyncStorage(runner, legacy, COLLECTIONS);
      expect(first.migrated).toBe(true);
      expect(first.imported.sales).toBe(1);
      expect(first.imported.bills).toBe(1);
      expect(await readSettings(runner)).toMatchObject({ currency: 'INR', openingCash: 500 });
      expect(await readColl(runner, 'sales')).toHaveLength(1);

      // Second run is a no-op (guarded by meta.migrated flag)
      const second = await migrateFromAsyncStorage(runner, legacy, COLLECTIONS);
      expect(second.alreadyDone).toBe(true);
      expect(second.migrated).toBe(false);
    } finally {
      close();
    }
  });

  it('never overwrites a SQLite table that already has rows', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      // pre-existing SQLite data
      await writeColl(runner, 'sales', [{ id: 'keep', date: '2026-06-01', amount: 999 }]);

      const legacy = fakeLegacy({
        'ledgr:sales': JSON.stringify([{ id: 'legacy', date: '2026-01-01', amount: 1 }]),
      });
      const res = await migrateFromAsyncStorage(runner, legacy, COLLECTIONS);
      // sales table was non-empty -> skipped, existing row preserved
      expect(res.imported.sales).toBe(0);
      const back = await readColl(runner, 'sales');
      expect(back).toHaveLength(1);
      expect((back[0] as any).id).toBe('keep');
    } finally {
      close();
    }
  });

  it('handles empty / malformed legacy data gracefully', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const legacy = fakeLegacy({
        'ledgr:sales': '{not valid json',
        'ledgr:bills': JSON.stringify([]),
      });
      const res = await migrateFromAsyncStorage(runner, legacy, COLLECTIONS);
      expect(res.migrated).toBe(true);
      expect(res.imported.sales).toBe(0);
      expect(res.imported.bills).toBe(0);
    } finally {
      close();
    }
  });
});
