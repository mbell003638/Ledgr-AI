/**
 * node:sqlite adapter implementing SqlRunner — TEST ONLY.
 *
 * Node 22 ships a built-in synchronous SQLite (`node:sqlite`, DatabaseSync).
 * We wrap its sync API in async methods so it satisfies the same SqlRunner
 * contract the app's expo-sqlite adapter implements. This lets the real SQL
 * (schema, queries, transactions, migration) run under Jest without any native
 * build step and without mocking the database.
 */

import { SqlRunner } from '../../src/db/schema';

// node:sqlite is experimental; require dynamically so TS doesn't need its types.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

export function makeNodeRunner(): { runner: SqlRunner; close: () => void } {
  const db = new DatabaseSync(':memory:');

  const runner: SqlRunner = {
    exec: async (sql: string) => { db.exec(sql); },
    run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params); },
    all: async <T = any>(sql: string, params: any[] = []) => db.prepare(sql).all(...params) as T[],
    first: async <T = any>(sql: string, params: any[] = []) => {
      const r = db.prepare(sql).get(...params);
      return (r ?? null) as T | null;
    },
  };

  return { runner, close: () => db.close() };
}
