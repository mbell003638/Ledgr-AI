import type { SqlRunner } from '../db/schema';
import { OPTIONAL_FEATURE_KEYS, type FeatureKey } from '../utils/featureFlags';

export type OptionalModuleKey = (typeof OPTIONAL_FEATURE_KEYS)[number];

/** True only when the user explicitly enabled the module in Customize Features. */
export async function isOptionalModuleEnabled(db: SqlRunner, key: OptionalModuleKey): Promise<boolean> {
  const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
  if (!row?.value) return false;
  let parsed: { enabledFeatures?: unknown } = {};
  try { parsed = JSON.parse(row.value); } catch { return false; }
  return Array.isArray(parsed.enabledFeatures) && parsed.enabledFeatures.includes(key);
}

export function requireOptionalModule(enabled: boolean, key: FeatureKey): void {
  if (!enabled) throw new Error(`Turn on ${key} in Customize Features before using this.`);
}
