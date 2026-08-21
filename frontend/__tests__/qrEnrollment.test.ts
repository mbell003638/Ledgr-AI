import { decodeLedgrSyncQrInvite, encodeLedgrSyncQrInvite } from '../src/sync/qrEnrollment';

describe('Ledgr QR enrollment invitations', () => {
  it('round-trips a short-lived token-free invite', () => {
    const raw = encodeLedgrSyncQrInvite({ serverUrl: 'https://sync.example.com', bookId: 'book-1', code: 'LGR-abcdefghijklmnopqrstuv', role: 'editor', locationIds: ['shop-a'], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), oidcIssuer: 'https://identity.example.com', oidcClientId: 'ledgr-mobile', oidcScopes: 'openid profile offline_access' });
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('Bearer');
    expect(decodeLedgrSyncQrInvite(raw)).toMatchObject({ serverUrl: 'https://sync.example.com', bookId: 'book-1', code: 'LGR-abcdefghijklmnopqrstuv', role: 'editor', locationIds: ['shop-a'] });
  });

  it('rejects expired invitations and insecure remote addresses', () => {
    expect(() => encodeLedgrSyncQrInvite({ serverUrl: 'http://sync.example.com', bookId: 'book-1', code: 'LGR-abcdefghijklmnopqrstuv', role: 'viewer', locationIds: [], expiresAt: new Date(Date.now() + 60_000).toISOString() })).toThrow(/HTTPS/);
    const expired = JSON.stringify({ kind: 'ledgr.sync.enrollment', version: 1, serverUrl: 'https://sync.example.com', bookId: 'book-1', code: 'LGR-abcdefghijklmnopqrstuv', role: 'viewer', locationIds: [], expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(() => decodeLedgrSyncQrInvite(expired)).toThrow(/expired/);
  });
});
