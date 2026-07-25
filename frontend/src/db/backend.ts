/**
 * Switchable storage backend (Phase 2B activation).
 *
 * local.ts funnels ALL persistence through the four primitives re-exported here
 * (readColl / writeColl / readSettings / writeSettings) plus clearColl for reset.
 *
 * Default mode is 'async' (the proven AsyncStorage layer). At startup, initStorage()
 * attempts to switch to 'sqlite':
 *   1. open the on-device SQLite db + create schema
 *   2. run the ONE-TIME, NON-DESTRUCTIVE migration (copies AsyncStorage -> SQLite,
 *      leaves AsyncStorage data intact as a fallback)
 *   3. flip the active mode to 'sqlite'
 * If ANY step throws, we stay in 'async' mode so the app can never hard-break —
 * the SQLite path is strictly additive.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLLECTIONS, CollectionName, SqlRunner } from './schema';
import {
  readColl as sqlRead,
  writeColl as sqlWrite,
  readSettings as sqlReadSettings,
  writeSettings as sqlWriteSettings,
  migrateFromAsyncStorage,
} from './sqliteStore';

export type StorageMode = 'async' | 'sqlite';

const KEYS: Record<CollectionName, string> = COLLECTIONS.reduce((acc, c) => {
  acc[c] = `ledgr:${c}`;
  return acc;
}, {} as Record<CollectionName, string>);
const SETTINGS_KEY = 'ledgr:settings';

let mode: StorageMode = 'async';
let runner: SqlRunner | null = null;

export function storageMode(): StorageMode {
  return mode;
}

// ---------- AsyncStorage implementations (default + fallback) ----------
async function asyncReadColl<T = any>(c: CollectionName): Promise<T[]> {
  const raw = await AsyncStorage.getItem(KEYS[c]);
  if (!raw) return [];
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}
async function asyncWriteColl<T = any>(c: CollectionName, arr: T[]): Promise<void> {
  await AsyncStorage.setItem(KEYS[c], JSON.stringify(arr));
}
async function asyncReadSettings(): Promise<any> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function asyncWriteSettings(s: any): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------- Public primitives (dispatch on active mode) ----------
export async function readColl<T = any>(c: CollectionName): Promise<T[]> {
  if (mode === 'sqlite' && runner) {
    try { return await sqlRead<T>(runner, c); }
    catch { return asyncReadColl<T>(c); } // defensive fallback on a read error
  }
  return asyncReadColl<T>(c);
}

export async function writeColl<T = any>(c: CollectionName, arr: T[]): Promise<void> {
  if (mode === 'sqlite' && runner) {
    await sqlWrite<T>(runner, c, arr);
    return;
  }
  await asyncWriteColl<T>(c, arr);
}

export async function readSettings(): Promise<any> {
  if (mode === 'sqlite' && runner) {
    try { return await sqlReadSettings(runner); }
    catch { return asyncReadSettings(); }
  }
  return asyncReadSettings();
}

export async function writeSettings(s: any): Promise<void> {
  if (mode === 'sqlite' && runner) {
    await sqlWriteSettings(runner, s);
    return;
  }
  await asyncWriteSettings(s);
}

/** Clear a single collection (used by resetAll). */
export async function clearColl(c: CollectionName): Promise<void> {
  if (mode === 'sqlite' && runner) {
    await sqlWrite(runner, c, []);
    return;
  }
  await AsyncStorage.removeItem(KEYS[c]);
}

/**
 * Attempt to activate SQLite. Non-fatal: on any failure the app stays on
 * AsyncStorage. Returns the mode actually in effect + the migration report.
 */
export async function initStorage(): Promise<{ mode: StorageMode; migration?: any; error?: string }> {
  try {
    // Lazy import so a failure to load expo-sqlite can't crash module load.
    const { getExpoRunner } = require('./expoRunner');
    const r: SqlRunner = await getExpoRunner();
    const migration = await migrateFromAsyncStorage(r, AsyncStorage.getItem, COLLECTIONS);
    runner = r;
    mode = 'sqlite';
    return { mode, migration };
  } catch (e: any) {
    mode = 'async';
    runner = null;
    return { mode, error: e?.message || String(e) };
  }
}
