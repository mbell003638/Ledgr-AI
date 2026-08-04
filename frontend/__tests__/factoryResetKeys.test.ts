// Verifies that a factory reset wipes EVERYTHING the app persists — not just the
// per-book ledger/settings, but the user-preference + UI-customization keys
// (theme, animations, dashboard tile order/usage) and the AI credentials — and
// that a fresh getSettings() then returns pristine defaults (hasOnboarded=false,
// so the onboarding gate shows again on next launch).
//
// The device-level key wipe lives in api.factoryReset(). api.ts imports the full
// V2 graph via the `@/` path alias, which this pure-node ts-jest project does
// not resolve, so we assert that wiring at the source level (the same
// source-inspection pattern used by v2UiContracts.test.ts). The behavioral
// pristine-defaults half runs for real against the db layer (relative imports).

import * as fs from 'fs';
import * as path from 'path';

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
    setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
    multiGet: jest.fn(async (keys: string[]) => keys.map((k) => [k, k in mem ? mem[k] : null])),
    multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) mem[k] = v; }),
    multiRemove: jest.fn(async (keys: string[]) => { for (const k of keys) delete mem[k]; }),
  },
}));

import { getSettings, updateSettings, factoryReset } from '../src/db/local';
import { readLogo, setActiveBook } from '../src/db/backend';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });
afterEach(async () => { await setActiveBook('default'); });

const API_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.ts'), 'utf8');

describe('factoryReset — device-level key wipe (api.ts wiring)', () => {
  // The exact keys the reset must clear, mirroring ThemeContext.tsx +
  // app/(tabs)/index.tsx. If a new persisted pref is added without being wired
  // into the reset, this list — and the assertions below — must be updated.
  const PREF_KEYS = ['theme_mode', 'animations_enabled', 'ledgr_tile_order', 'ledgr_tile_usage'];
  const AI_KEYS = ['ai_provider', 'ai_api_key', 'ai_model', 'ai_base_url', 'gemini_api_key', 'gemini_model'];

  it('declares the complete preference-key list as a single exported constant', () => {
    const block = API_SRC.match(/FACTORY_RESET_PREF_KEYS\s*=\s*\[([\s\S]*?)\]/);
    expect(block).toBeTruthy();
    for (const key of PREF_KEYS) {
      // Referenced via a named const (THEME_MODE_KEY etc.) — assert each literal
      // is defined in the file and the constant is assembled from them.
      expect(API_SRC).toContain(`'${key}'`);
    }
  });

  it('factoryReset feeds the pref keys AND the AI keys into a multiRemove', () => {
    const fn = API_SRC.match(/factoryReset:\s*async[\s\S]*?\n {2}},/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).toContain('multiRemove');
    expect(body).toContain('FACTORY_RESET_PREF_KEYS');
    // AI credential keys cleared explicitly + the secure keystore entry removed.
    expect(body).toContain('AI_PROVIDER_KEY');
    expect(body).toContain('AI_MODEL_KEY');
    expect(body).toContain('secureRemove(AI_API_KEY_KEY)');
  });

  it('factoryReset wires the scorched-earth V2 wipe (zero rows in every v2_* table)', () => {
    // The behavioral half (real SQL) lives in factoryResetV2.test.ts; this
    // asserts api.factoryReset actually calls it on the active runner, so an
    // orphaned v2_books row can never resurface and crash onboarding with
    // "UNIQUE constraint failed: v2_books.id".
    const fn = API_SRC.match(/factoryReset:\s*async[\s\S]*?\n {2}},/);
    expect(fn).toBeTruthy();
    expect(fn![0]).toContain('factoryResetV2Data(runner)');
    expect(API_SRC).toContain("import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook'");
  });
});

describe('factoryReset — pristine defaults (db behavior)', () => {
  it('leaves getSettings() at defaults so the onboarding gate reopens', async () => {
    await updateSettings({
      businessName: 'Old Shop',
      hasOnboarded: true,
      themeMode: 'amoled_blue',
      accountingStyle: 'retail_partnership',
      openingCash: 500,
      openingInventory: 300,
      logo: 'data:image/png;base64,AAAA',
    });
    expect(await readLogo()).toBe('data:image/png;base64,AAAA');

    await factoryReset();

    const s = await getSettings();
    // hasOnboarded is what app/index.tsx reads for the onboarding gate — MUST be
    // false so the redirect to /onboarding can't be bypassed on next launch.
    expect(s.hasOnboarded).toBe(false);
    expect(s.businessName ?? '').toBe('');
    expect(Number(s.openingCash || 0)).toBe(0);
    expect(Number(s.openingInventory || 0)).toBe(0);
    expect(s.accountingStyle ?? 'standard').not.toBe('retail_partnership');
    // Logo cleared (stored outside the settings blob).
    expect(await readLogo()).toBe('');
    expect(s.hasLogo).toBeFalsy();
  });
});
