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
import { Platform } from 'react-native';
import { COLLECTIONS, CollectionName, SqlRunner } from './schema';
import { initializeV2Book, accountingBookVersion } from '../accountingV2/appBootstrap';
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

// ---------- Books (separate accounts) ----------
// Each "book" is a fully isolated set of data (e.g. Shop vs Technician).
// We namespace every storage key with the active book id. The default book
// uses the ORIGINAL un-prefixed keys ('ledgr:sales', 'ledgr:settings', …) so
// existing installs migrate transparently with zero data movement.
const DEFAULT_BOOK = 'default';
const BOOKS_INDEX_KEY = 'ledgr:books';        // [{ id, name, businessType }]
const ACTIVE_BOOK_KEY = 'ledgr:activeBook';   // string id
let activeBook: string = DEFAULT_BOOK;

function collKey(c: CollectionName): string {
  return activeBook === DEFAULT_BOOK ? KEYS[c] : `ledgr:${activeBook}:${c}`;
}
function settingsKey(): string {
  return activeBook === DEFAULT_BOOK ? SETTINGS_KEY : `ledgr:${activeBook}:settings`;
}

export type BookMeta = { id: string; name: string; businessType?: string };

export async function listBooks(): Promise<BookMeta[]> {
  const raw = await AsyncStorage.getItem(BOOKS_INDEX_KEY);
  let books: BookMeta[] = [];
  if (raw) { try { books = JSON.parse(raw); } catch { books = []; } }
  // Guarantee the default book always exists in the index.
  if (!books.find((b) => b.id === DEFAULT_BOOK)) {
    books.unshift({ id: DEFAULT_BOOK, name: 'Main Account' });
  }
  return books;
}

export function activeBookId(): string { return activeBook; }

export async function loadActiveBook(): Promise<string> {
  const id = await AsyncStorage.getItem(ACTIVE_BOOK_KEY);
  activeBook = id || DEFAULT_BOOK;
  return activeBook;
}

export async function setActiveBook(id: string): Promise<void> {
  activeBook = id || DEFAULT_BOOK;
  await AsyncStorage.setItem(ACTIVE_BOOK_KEY, activeBook);
  if (runner && await accountingBookVersion(runner, activeBook) != null) {
    await runner.run(`INSERT INTO meta(key,value) VALUES('v2_active_book_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [activeBook]);
  }
}

export async function createBook(name: string, businessType?: string): Promise<BookMeta> {
  const books = await listBooks();
  const id = `book_${Date.now().toString(36)}`;
  const meta: BookMeta = { id, name: name.trim() || 'New Account', businessType };
  books.push(meta);
  await AsyncStorage.setItem(BOOKS_INDEX_KEY, JSON.stringify(books));
  if (runner) {
    const year = new Date().getFullYear();
    await initializeV2Book(runner, { book: { id, name: meta.name, style: 'standard', basis: 'accrual' }, period: { id: `${id}:period:${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` }, personas: ['custom'] });
  }
  return meta;
}

export async function renameBook(id: string, name: string): Promise<void> {
  const books = await listBooks();
  const next = books.map((b) => (b.id === id ? { ...b, name: name.trim() || b.name } : b));
  await AsyncStorage.setItem(BOOKS_INDEX_KEY, JSON.stringify(next));
}

export async function deleteBook(id: string): Promise<void> {
  if (id === DEFAULT_BOOK) throw new Error('The main account cannot be deleted.');
  // Wipe this book's data (async keys; sqlite rows are namespaced too).
  for (const c of COLLECTIONS) {
    await AsyncStorage.removeItem(`ledgr:${id}:${c}`);
  }
  await AsyncStorage.removeItem(`ledgr:${id}:settings`);
  const books = (await listBooks()).filter((b) => b.id !== id);
  await AsyncStorage.setItem(BOOKS_INDEX_KEY, JSON.stringify(books));
  if (activeBook === id) await setActiveBook(DEFAULT_BOOK);
}

let mode: StorageMode = 'async';
let runner: SqlRunner | null = null;

export function storageMode(): StorageMode {
  return mode;
}

/** Active SQLite runner for authoritative V2 services. Null in AsyncStorage fallback mode. */
export function activeSqlRunner(): SqlRunner | null { return runner; }

// ---------- AsyncStorage implementations (default + fallback) ----------
async function asyncReadColl<T = any>(c: CollectionName): Promise<T[]> {
  const raw = await AsyncStorage.getItem(collKey(c));
  if (!raw) return [];
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}
async function asyncWriteColl<T = any>(c: CollectionName, arr: T[]): Promise<void> {
  await AsyncStorage.setItem(collKey(c), JSON.stringify(arr));
}
async function asyncReadSettings(): Promise<any> {
  const raw = await AsyncStorage.getItem(settingsKey());
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function asyncWriteSettings(s: any): Promise<void> {
  await AsyncStorage.setItem(settingsKey(), JSON.stringify(s));
}

// ---------- Public primitives (dispatch on active mode) ----------
export async function readColl<T = any>(c: CollectionName): Promise<T[]> {
  // SQLite store is not book-namespaced; only the default/main book uses it.
  // Secondary books always live in (namespaced) AsyncStorage for full isolation.
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
    try { return await sqlRead<T>(runner, c); }
    catch { return asyncReadColl<T>(c); } // defensive fallback on a read error
  }
  return asyncReadColl<T>(c);
}

export async function writeColl<T = any>(c: CollectionName, arr: T[]): Promise<void> {
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
    await sqlWrite<T>(runner, c, arr);
    return;
  }
  await asyncWriteColl<T>(c, arr);
}

export async function readSettings(): Promise<any> {
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
    try { return await sqlReadSettings(runner); }
    catch { return asyncReadSettings(); }
  }
  return asyncReadSettings();
}

export async function writeSettings(s: any): Promise<void> {
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
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
  await AsyncStorage.removeItem(collKey(c));
}

/**
 * Attempt to activate SQLite. Non-fatal: on any failure the app stays on
 * AsyncStorage. Returns the mode actually in effect + the migration report.
 */
export async function initStorage(): Promise<{ mode: StorageMode; migration?: any; error?: string }> {
  // Restore which book (account) was last active before touching storage.
  try { await loadActiveBook(); } catch { /* stay on default */ }
  if (Platform.OS === 'web') {
    mode = 'async';
    runner = null;
    return { mode };
  }
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
