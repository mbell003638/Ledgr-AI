/**
 * Opt-in bootstrap for the experimental SQLite storage backend (Phase 2B).
 *
 * IMPORTANT: This is NOT wired into the running app by default. The app still
 * uses the battle-tested AsyncStorage layer in `local.ts`. This module exists so
 * the SQLite path can be activated deliberately, on-device, once you're ready to
 * verify it against real data — without risking the working storage layer.
 *
 * The migration is non-destructive: your AsyncStorage data is copied into
 * SQLite and left intact as a fallback. Nothing is deleted.
 *
 * To activate (later, when you want to test on a device):
 *   import { bootstrapSqlite } from '@/src/db/sqliteBootstrap';
 *   const report = await bootstrapSqlite();   // migrates once, returns counts
 * then progressively point local.ts's readColl/writeColl at the SQLite store.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLLECTIONS } from './schema';
import { getExpoRunner } from './expoRunner';
import {
  migrateFromAsyncStorage,
  readColl as sqlReadColl,
  writeColl as sqlWriteColl,
  readSettings as sqlReadSettings,
  writeSettings as sqlWriteSettings,
} from './sqliteStore';

/** Run the one-time migration from AsyncStorage into SQLite. Safe to call repeatedly. */
export async function bootstrapSqlite() {
  const runner = await getExpoRunner();
  return migrateFromAsyncStorage(runner, AsyncStorage.getItem, COLLECTIONS);
}

/**
 * Storage adapter bound to the on-device SQLite runner, exposing the same four
 * primitives local.ts funnels through. When you're ready to switch the app over,
 * local.ts's readColl/writeColl/readSettings/writeSettings can delegate here.
 */
export const sqliteStorage = {
  readColl: async (coll: (typeof COLLECTIONS)[number]) => sqlReadColl(await getExpoRunner(), coll),
  writeColl: async (coll: (typeof COLLECTIONS)[number], arr: any[]) => sqlWriteColl(await getExpoRunner(), coll, arr),
  readSettings: async () => sqlReadSettings(await getExpoRunner()),
  writeSettings: async (s: any) => sqlWriteSettings(await getExpoRunner(), s),
};
