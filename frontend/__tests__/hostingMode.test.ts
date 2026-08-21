const memory: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => memory[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { memory[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete memory[key]; }),
  },
}));

jest.mock('../src/db/backend', () => ({
  activeBookId: jest.fn(() => 'default'),
  activeSqlRunner: jest.fn(() => null),
}));
jest.mock('../src/sync/coordinator', () => ({
  getSyncStatus: jest.fn(async () => ({ enabled: false, configured: false, pending: 0, retryable: 0, conflicts: 0 })),
}));

import {
  getHostingModeState,
  getRequestedHostingMode,
  HOSTING_CONCEPT_COPY,
  HOSTING_MODE_DESCRIPTIONS,
  HOSTING_MODE_LABELS,
  setRequestedHostingMode,
} from '../src/utils/hostingMode';

describe('hosting mode contract', () => {
  beforeEach(() => { Object.keys(memory).forEach((key) => delete memory[key]); });

  it('defaults to local-only mode and exposes distinct product concepts', async () => {
    expect(await getRequestedHostingMode()).toBe('local_only');
    const state = await getHostingModeState();
    expect(state.mode).toBe('local_only');
    expect(HOSTING_MODE_LABELS.local_only).toBe('Local-only mode');
    expect(HOSTING_MODE_LABELS.private_sync).toBe('Private sync');
    expect(HOSTING_MODE_DESCRIPTIONS.local_only).toMatch(/encrypted backup/i);
    expect(HOSTING_MODE_DESCRIPTIONS.private_sync).toMatch(/server/i);
    expect(HOSTING_CONCEPT_COPY.backup).toBe('Encrypted backup');
    expect(HOSTING_CONCEPT_COPY.serverHealth).toBe('Server health');
  });

  it('does not report private sync as effective until semantic sync is configured', async () => {
    await setRequestedHostingMode('private_sync');
    const state = await getHostingModeState();
    expect(state.requestedMode).toBe('private_sync');
    expect(state.mode).toBe('local_only');
    expect(state.configured).toBe(false);
  });
});
