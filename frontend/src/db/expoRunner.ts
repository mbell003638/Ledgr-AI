/**
 * expo-sqlite adapter implementing SqlRunner (Phase 2B, experimental).
 *
 * This is the APP-RUNTIME adapter. It is intentionally imported lazily so that
 * unit tests (which use the node:sqlite adapter instead) never pull in the
 * native expo-sqlite module.
 */

import { SqlRunner } from './schema';

let _dbPromise: Promise<SqlRunner> | null = null;

/** Open (once) the on-device SQLite database and wrap it as a SqlRunner. */
export function getExpoRunner(): Promise<SqlRunner> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    // Lazy require so tests / web bundles don't need the native module present.
    const SQLite = require('expo-sqlite');
    const db = await SQLite.openDatabaseAsync('ledgr.db');
    await db.execAsync('PRAGMA journal_mode = WAL;');
    const runner: SqlRunner = {
      exec: async (sql: string) => { await db.execAsync(sql); },
      run: async (sql: string, params: any[] = []) => { await db.runAsync(sql, params); },
      all: async <T = any>(sql: string, params: any[] = []) => (await db.getAllAsync(sql, params)) as T[],
      first: async <T = any>(sql: string, params: any[] = []) => ((await db.getFirstAsync(sql, params)) as T) ?? null,
    };
    return runner;
  })();
  return _dbPromise;
}
