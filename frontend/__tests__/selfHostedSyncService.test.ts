const secureValues = new Map<string, string>();
const exportBackup = jest.fn();
const importBackup = jest.fn();
const activeSqlRunner = jest.fn();
const activeContext = jest.fn();

jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureValues.get(key) || null,
  setItemAsync: async (key: string, value: string) => { secureValues.set(key, value); },
}));
jest.mock('../src/db/local', () => ({ exportBackup, importBackup }));
jest.mock('../src/db/backend', () => ({ activeSqlRunner }));
jest.mock('../src/accountingV2/appService', () => ({ V2AppService: jest.fn().mockImplementation(() => ({ activeContext })) }));

import { configureSelfHostedSync, getSelfHostedSyncState, pushSelfHostedSnapshot, pullSelfHostedSnapshot, snapshotFingerprint } from '../src/accountingV2/services/selfHostedSyncService';

function backup() {
  return { _meta: { app: 'ledgr', version: 10 }, v2: { tables: { v2_books: [] } }, settings: {} };
}

function response(body: any, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('user-owned self-host sync', () => {
  let integration: any = null;
  let state: any = null;
  const runner = {
    first: jest.fn(async (sql: string) => {
      if (sql.includes('v2_integrations')) return integration;
      if (sql.includes('v2_sync_state')) return state;
      return null;
    }),
    run: jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes('v2_integrations')) integration = { id: params[0], enabled: params[5], config: params[6], created_at: params[7], updated_at: params[8] };
      if (sql.includes('v2_sync_state')) state = { id: params[0], remote_book_id: params[3], device_id: params[4], etag: params[5], last_local_hash: params[6], last_sync_at: params[7], status: params[8], last_error: params[9], conflict_payload: params[10] };
    }),
  };

  beforeEach(() => {
    secureValues.clear(); integration = null; state = null;
    jest.clearAllMocks();
    activeSqlRunner.mockReturnValue(runner);
    activeContext.mockResolvedValue({ bookId: 'book-1', periodId: 'period-1' });
    exportBackup.mockResolvedValue(backup());
    importBackup.mockResolvedValue({ ok: true });
  });

  it('fingerprints equal snapshots deterministically and changes when content changes', () => {
    expect(snapshotFingerprint({ a: 1 })).toBe(snapshotFingerprint({ a: 1 }));
    expect(snapshotFingerprint({ a: 1 })).not.toBe(snapshotFingerprint({ a: 2 }));
  });

  it('stores the server token securely and pushes the first snapshot', async () => {
    await configureSelfHostedSync({ baseUrl: 'https://sync.example.test/', workspaceId: 'workspace-1', token: 'secret-token' });
    expect(secureValues.get('ledgr.self-hosted-sync.token.book-1')).toBe('secret-token');
    const result = await pushSelfHostedSnapshot(async (_url, init) => {
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer secret-token');
      return response({ etag: 'remote-etag-1' });
    });
    expect(result.status).toBe('synced');
    expect(result.etag).toBe('remote-etag-1');
  });

  it('refuses a remote pull when local offline edits are not synced', async () => {
    await configureSelfHostedSync({ baseUrl: 'https://sync.example.test', workspaceId: 'workspace-1' });
    state.last_local_hash = 'previous-hash';
    state.etag = 'remote-etag-1';
    exportBackup.mockResolvedValue({ ...backup(), changed: true });
    await expect(pullSelfHostedSnapshot({}, async () => response({ snapshot: backup(), etag: 'remote-etag-2' }))).rejects.toThrow('Local offline edits are not synced');
    expect(importBackup).not.toHaveBeenCalled();
    expect((await getSelfHostedSyncState()).status).toBe('conflict');
  });

  it('pulls a remote snapshot only through the existing atomic backup importer', async () => {
    await configureSelfHostedSync({ baseUrl: 'https://sync.example.test', workspaceId: 'workspace-1' });
    state.last_local_hash = snapshotFingerprint(backup());
    state.etag = 'remote-etag-1';
    const remote = { ...backup(), remote: true };
    const result = await pullSelfHostedSnapshot({}, async (_url, init) => {
      expect(init?.method).toBeUndefined();
      return response({ snapshot: remote, etag: 'remote-etag-2' });
    });
    expect(importBackup).toHaveBeenCalledWith(remote);
    expect(result.status).toBe('synced');
    expect(result.etag).toBe('remote-etag-2');
  });
});
