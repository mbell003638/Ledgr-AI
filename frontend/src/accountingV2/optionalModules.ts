import type { SqlRunner } from '../db/schema';
import { OPTIONAL_FEATURE_KEYS, type FeatureKey } from '../utils/featureFlags';

export type OptionalModuleKey = (typeof OPTIONAL_FEATURE_KEYS)[number];
export type V2BookPrefs = { enabledFeatures?: string[]; activeLocationId?: string };

export const v2PrefsKey = (bookId: string) => `v2_prefs:${bookId}`;

function parsePrefs(raw?: string | null): V2BookPrefs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as V2BookPrefs : null;
  } catch {
    return null;
  }
}

export async function readV2BookPrefs(db: SqlRunner, bookId: string): Promise<V2BookPrefs | null> {
  const row = await db.first<{ value: string }>('SELECT value FROM settings WHERE key=?', [v2PrefsKey(bookId)]);
  return parsePrefs(row?.value);
}

export async function writeV2BookPrefs(db: SqlRunner, bookId: string, patch: V2BookPrefs): Promise<void> {
  const current = (await readV2BookPrefs(db, bookId)) || {};
  const next: V2BookPrefs = { ...current };
  if (patch.enabledFeatures !== undefined) next.enabledFeatures = patch.enabledFeatures;
  if (patch.activeLocationId !== undefined) next.activeLocationId = patch.activeLocationId;
  await db.run(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [v2PrefsKey(bookId), JSON.stringify(next)],
  );
}

async function resolveBookId(db: SqlRunner, bookId?: string): Promise<string | null> {
  if (bookId) return bookId;
  const active = await db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
  return active?.value || null;
}

async function mainSettingsBlob(db: SqlRunner): Promise<V2BookPrefs> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
  return parsePrefs(row?.value) || {};
}

/**
 * Create per-book prefs if missing.
 * First migration: the active book inherits legacy `settings.main` so Customize Features stay on.
 * Any other book without a row starts with optional modules off.
 */
export async function ensureV2BookPrefs(db: SqlRunner, bookId: string): Promise<V2BookPrefs> {
  const existing = await readV2BookPrefs(db, bookId);
  if (existing && Array.isArray(existing.enabledFeatures)) return existing;

  const others = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'v2_prefs:%' AND key<>?",
    [v2PrefsKey(bookId)],
  );
  const active = await db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
  const main = await mainSettingsBlob(db);
  const inheritMain = Number(others?.n || 0) === 0 && active?.value === bookId;
  const seed: V2BookPrefs = inheritMain
    ? {
        enabledFeatures: Array.isArray(main.enabledFeatures) ? main.enabledFeatures : [],
        activeLocationId: String(main.activeLocationId || ''),
      }
    : { enabledFeatures: [], activeLocationId: '' };
  await writeV2BookPrefs(db, bookId, seed);
  return (await readV2BookPrefs(db, bookId)) || seed;
}

/** True only when this book has the module on. Never reads another book's flags. */
export async function isOptionalModuleEnabled(db: SqlRunner, key: OptionalModuleKey, bookId?: string): Promise<boolean> {
  const resolved = await resolveBookId(db, bookId);
  if (!resolved) return false;
  const prefs = await ensureV2BookPrefs(db, resolved);
  return Array.isArray(prefs.enabledFeatures) && prefs.enabledFeatures.includes(key);
}

export function requireOptionalModule(enabled: boolean, key: FeatureKey): void {
  if (!enabled) throw new Error(`Turn on ${key} in Customize Features before using this.`);
}
