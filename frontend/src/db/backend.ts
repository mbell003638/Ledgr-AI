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
import { initializeV2Book, accountingBookVersion } from '../accountingV2/appBootstrap';
import { deleteV2BookData } from '../accountingV2/resetBook';
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
// Logo lives OUTSIDE the settings blob (a large base64 data-URI in the settings
// JSON can overflow Android's ~2MB SQLite CursorWindow and break EVERY settings
// read/write). It is namespaced per-book exactly like settings. [H4]
const LOGO_KEY = 'ledgr:logo';
function logoKey(): string {
  return activeBook === DEFAULT_BOOK ? LOGO_KEY : `ledgr:${activeBook}:logo`;
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
  // Remove the authoritative normalized ledger first. If it fails, leave the
  // visible book/index intact instead of pretending financial data was deleted.
  if (runner) await deleteV2BookData(runner, id);

  // Wipe this book's namespaced legacy payload and logo.
  for (const c of COLLECTIONS) {
    await AsyncStorage.removeItem(`ledgr:${id}:${c}`);
  }
  await AsyncStorage.removeItem(`ledgr:${id}:settings`);
  await AsyncStorage.removeItem(`ledgr:${id}:logo`);
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

// ---------- Logo (stored apart from the settings blob) ----------
// In SQLite mode the logo is its OWN row in the `settings` table (key 'logo'),
// so its size never bloats the main settings document's CursorWindow. In
// AsyncStorage mode it is a dedicated (per-book) key. Returns '' when absent.
export async function readLogo(): Promise<string> {
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
    try {
      const row = await runner.first<{ value: string }>("SELECT value FROM settings WHERE key='logo'");
      return row?.value ? String(row.value) : '';
    } catch { /* fall through to async */ }
  }
  const raw = await AsyncStorage.getItem(logoKey());
  return raw ? String(raw) : '';
}
export async function writeLogo(dataUri: string): Promise<void> {
  const value = dataUri || '';
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
    if (!value) {
      await runner.run("DELETE FROM settings WHERE key='logo'");
    } else {
      await runner.run(
        "INSERT INTO settings(key,value) VALUES('logo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [value],
      );
    }
    return;
  }
  if (!value) await AsyncStorage.removeItem(logoKey());
  else await AsyncStorage.setItem(logoKey(), value);
}
export async function clearLogo(): Promise<void> {
  await writeLogo('');
}

/** True when the default/main book is active (the only book that uses the SQLite store). */
export function activeBookIsDefault(): boolean { return activeBook === DEFAULT_BOOK; }

/**
 * Full books/active-book teardown for a factory reset. [C4/M2]
 *   - removes the AsyncStorage books index + active-book pointer
 *   - resets the in-memory `activeBook` back to the default (otherwise a stale
 *     secondary id would keep namespacing every subsequent read/write)
 *   - clears the SQLite meta keys `v2_active_book_id` and every `v2_book_version:*`
 * Theme keys and AI credentials are NOT touched here (handled elsewhere).
 */
export async function resetBooksAndActiveBook(): Promise<void> {
  await AsyncStorage.removeItem(BOOKS_INDEX_KEY);
  await AsyncStorage.removeItem(ACTIVE_BOOK_KEY);
  activeBook = DEFAULT_BOOK;
  if (runner) {
    try {
      await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
      await runner.run("DELETE FROM meta WHERE key LIKE 'v2_book_version:%'");
    } catch { /* meta cleanup best-effort */ }
  }
}

// ---------- Namespaced AsyncStorage key resolvers + snapshot/rollback ----------
// Used by the AsyncStorage-mode atomic import (snapshot the exact keys a restore
// will overwrite, then multiSet them back on failure). [C3]
export function collStorageKey(c: CollectionName): string { return collKey(c); }
export function settingsStorageKey(): string { return settingsKey(); }
export function logoStorageKey(): string { return logoKey(); }

/** Snapshot the current raw values of the given AsyncStorage keys. */
export async function snapshotKeys(keys: string[]): Promise<[string, string | null][]> {
  const pairs = await AsyncStorage.multiGet(keys);
  // multiGet returns readonly [key, value|null][]; normalize to a mutable copy.
  return pairs.map(([k, v]) => [k, v ?? null] as [string, string | null]);
}

/** Restore a snapshot: re-set keys that had a value, remove keys that were absent. */
export async function restoreKeys(snapshot: [string, string | null][]): Promise<void> {
  const toSet: [string, string][] = [];
  const toRemove: string[] = [];
  for (const [k, v] of snapshot) {
    if (v == null) toRemove.push(k);
    else toSet.push([k, v]);
  }
  if (toSet.length) await AsyncStorage.multiSet(toSet);
  if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
}

// ---------- Multi-book backup helpers [Finding D] ----------
// A backup must capture EVERY book, not just the active one. Secondary books
// store their legacy collections/settings/logo in namespaced AsyncStorage keys
// (`ledgr:<book>:*`); the default book stores them in the SQLite store (or the
// un-prefixed AsyncStorage keys in async mode). The V2 double-entry ledger for
// ALL books already lives in the shared v2_* tables (captured by v2Backup). The
// gap these helpers close is the per-book legacy payload + the books index, so a
// restore makes every book selectable and intact.

const rawBookCollKey = (bookId: string, c: CollectionName) => (bookId === DEFAULT_BOOK ? KEYS[c] : `ledgr:${bookId}:${c}`);
const rawBookSettingsKey = (bookId: string) => (bookId === DEFAULT_BOOK ? SETTINGS_KEY : `ledgr:${bookId}:settings`);
const rawBookLogoKey = (bookId: string) => (bookId === DEFAULT_BOOK ? LOGO_KEY : `ledgr:${bookId}:logo`);

/** Raw books-index JSON (or []) exactly as persisted, WITHOUT injecting the default. */
export async function readBooksIndexRaw(): Promise<BookMeta[]> {
  const raw = await AsyncStorage.getItem(BOOKS_INDEX_KEY);
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** Overwrite the books index (used by restore). */
export async function writeBooksIndexRaw(books: BookMeta[]): Promise<void> {
  await AsyncStorage.setItem(BOOKS_INDEX_KEY, JSON.stringify(Array.isArray(books) ? books : []));
}

/**
 * Read one SECONDARY book's legacy payload straight from its namespaced
 * AsyncStorage keys (never the SQLite store — that is the default book only).
 * Returns { collections, settings, logo }. Absent keys read as [] / {} / ''.
 */
export async function readSecondaryBookPayload(bookId: string): Promise<{ collections: Record<string, any[]>; settings: any; logo: string }> {
  const collections: Record<string, any[]> = {};
  for (const c of COLLECTIONS) {
    const raw = await AsyncStorage.getItem(rawBookCollKey(bookId, c));
    let arr: any[] = [];
    if (raw) { try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : []; } catch { arr = []; } }
    collections[c] = arr;
  }
  const settingsRaw = await AsyncStorage.getItem(rawBookSettingsKey(bookId));
  let settings: any = {};
  if (settingsRaw) { try { settings = JSON.parse(settingsRaw) || {}; } catch { settings = {}; } }
  const logo = (await AsyncStorage.getItem(rawBookLogoKey(bookId))) || '';
  return { collections, settings, logo };
}

/**
 * Write one SECONDARY book's legacy payload back into its namespaced keys,
 * CLEARING every collection first (so a collection absent from the payload can't
 * leak stale rows). Never touches the SQLite store.
 */
export async function writeSecondaryBookPayload(bookId: string, payload: { collections?: Record<string, any[]>; settings?: any; logo?: string }): Promise<void> {
  const collections = payload.collections || {};
  for (const c of COLLECTIONS) {
    await AsyncStorage.setItem(rawBookCollKey(bookId, c), JSON.stringify(Array.isArray(collections[c]) ? collections[c] : []));
  }
  await AsyncStorage.setItem(rawBookSettingsKey(bookId), JSON.stringify(payload.settings && typeof payload.settings === 'object' ? payload.settings : {}));
  const logo = typeof payload.logo === 'string' ? payload.logo : '';
  if (logo) await AsyncStorage.setItem(rawBookLogoKey(bookId), logo);
  else await AsyncStorage.removeItem(rawBookLogoKey(bookId));
}

/** Clear a single collection (used by resetAll). */
export async function clearColl(c: CollectionName): Promise<void> {
  if (mode === 'sqlite' && runner && activeBook === DEFAULT_BOOK) {
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
  try {
    // Lazy import so a failure to load expo-sqlite can't crash module load.
    const { getExpoRunner } = await import('./expoRunner');
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
