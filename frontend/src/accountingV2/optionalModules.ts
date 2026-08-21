import type { SqlRunner } from '../db/schema';
import { OPTIONAL_FEATURE_KEYS, type FeatureKey } from '../utils/featureFlags';
import { featureKeysForCapabilities } from '../utils/capabilities';

export type OptionalModuleKey = (typeof OPTIONAL_FEATURE_KEYS)[number];
export type V2BookPrefs = { enabledFeatures?: string[]; activeLocationId?: string };
export const v2PrefsKey = (bookId: string) => `v2_prefs:${bookId}`;
function parsePrefs(raw?: string | null): V2BookPrefs | null { try { const parsed = raw ? JSON.parse(raw) : null; return parsed && typeof parsed === 'object' ? parsed as V2BookPrefs : null; } catch { return null; } }
export async function readV2BookPrefs(db: SqlRunner, bookId: string): Promise<V2BookPrefs | null> {
  const row = await db.first<{ value: string }>('SELECT value FROM settings WHERE key=?', [v2PrefsKey(bookId)]);
  return parsePrefs(row?.value);
}
export async function writeV2BookPrefs(db: SqlRunner, bookId: string, patch: V2BookPrefs): Promise<void> {
  const current = (await readV2BookPrefs(db, bookId)) || {};
  const next: V2BookPrefs = { ...current, ...(patch.enabledFeatures === undefined ? {} : { enabledFeatures: patch.enabledFeatures }), ...(patch.activeLocationId === undefined ? {} : { activeLocationId: patch.activeLocationId }) };
  await db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [v2PrefsKey(bookId), JSON.stringify(next)]);
}

/** True only when the user explicitly enabled the module in Customize Features. */
export async function isOptionalModuleEnabled(db: SqlRunner, key: OptionalModuleKey): Promise<boolean> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
  if (!row?.value) return false;
  let parsed: { enabledFeatures?: unknown } = {};
  try { parsed = JSON.parse(row.value); } catch { return false; }
  return Array.isArray(parsed.enabledFeatures) && parsed.enabledFeatures.includes(key);
}

export async function bookOptionalSettings(db: SqlRunner, bookId: string): Promise<{ enabledFeatures?: string[]; enabledCapabilities?: string[]; activeLocationId?: string }> {
  const rows = await db.all<{ config: string }>('SELECT config FROM v2_personas WHERE book_id=? AND enabled=1', [bookId]);
  let scoped: { enabledFeatures?: string[]; enabledCapabilities?: string[]; activeLocationId?: string } = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.config || '{}');
      if (Array.isArray(parsed.enabledFeatures) || Array.isArray(parsed.enabledCapabilities)) {
        scoped = {
          enabledFeatures: Array.isArray(parsed.enabledFeatures) ? parsed.enabledFeatures.map(String) : undefined,
          enabledCapabilities: Array.isArray(parsed.enabledCapabilities) ? parsed.enabledCapabilities.map(String) : undefined,
          activeLocationId: parsed.activeLocationId ? String(parsed.activeLocationId) : undefined,
        };
        break;
      }
    } catch { /* try the next enabled persona */ }
  }
  // Customize Features writes the active settings document. Read it as the
  // compatibility source when older V2 persona rows do not yet contain the
  // current capability pack. This keeps the UI and posting guard in agreement.
  const main = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
  let visible: Record<string, unknown> = {};
  try { visible = JSON.parse(main?.value || '{}'); } catch { visible = {}; }
  const visibleCapabilities = Array.isArray(visible.enabledCapabilities) ? visible.enabledCapabilities.map(String) : undefined;
  const visibleFeatures = Array.isArray(visible.enabledFeatures) ? visible.enabledFeatures.map(String) : undefined;
  return {
    enabledFeatures: visibleFeatures !== undefined ? visibleFeatures : scoped.enabledFeatures,
    enabledCapabilities: visibleCapabilities !== undefined ? visibleCapabilities : scoped.enabledCapabilities,
    activeLocationId: visible.activeLocationId ? String(visible.activeLocationId) : scoped.activeLocationId,
  };
}

export async function isOptionalModuleEnabledForBook(db: SqlRunner, bookId: string, key: OptionalModuleKey): Promise<boolean> {
  const scoped = await bookOptionalSettings(db, bookId);
  // Current onboarding/customization stores capability packs. Prefer this
  // authoritative capability state when a legacy enabledFeatures array is also
  // present, otherwise stale legacy flags can make the UI show Locations as on
  // while the ledger enforcement layer rejects a shop close.
  if (scoped.enabledCapabilities) return featureKeysForCapabilities({ enabledCapabilities: scoped.enabledCapabilities }).includes(key);
  if (scoped.enabledFeatures) return scoped.enabledFeatures.includes(key);
  // Older books without a scoped preference record retain the legacy setting
  // until the active-book mirroring path initializes their persona config.
  return isOptionalModuleEnabled(db, key);
}

export function requireOptionalModule(enabled: boolean, key: FeatureKey): void {
  if (!enabled) throw new Error(`Turn on ${key} in Customize Features before using this.`);
}
