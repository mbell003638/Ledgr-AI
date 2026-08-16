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

async function mainSettingsFeatures(db: SqlRunner): Promise<string[] | null> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
  if (!row?.value) return null;
  const parsed = parsePrefs(row.value);
  return Array.isArray(parsed?.enabledFeatures) ? parsed!.enabledFeatures! : null;
}

/** True only when the user explicitly enabled the module for this book. */
export async function isOptionalModuleEnabled(db: SqlRunner, key: OptionalModuleKey, bookId?: string): Promise<boolean> {
  const resolved = await resolveBookId(db, bookId);
  if (resolved) {
    const prefs = await readV2BookPrefs(db, resolved);
    if (prefs && Array.isArray(prefs.enabledFeatures)) {
      return prefs.enabledFeatures.includes(key);
    }
  }
  const fallback = await mainSettingsFeatures(db);
  return Boolean(fallback && fallback.includes(key));
}

export function requireOptionalModule(enabled: boolean, key: FeatureKey): void {
  if (!enabled) throw new Error(`Turn on ${key} in Customize Features before using this.`);
}
