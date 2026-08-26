import { createSyncSetupQr, parseSyncSetupQr } from '../src/sync/setupQr';

const payload = { serverUrl: 'https://sync.example.com', oidcIssuer: 'https://identity.example.com/realms/ledgr', oidcClientId: 'ledgr-mobile', oidcScopes: 'openid profile offline_access' };

describe('self-host setup QR payloads', () => {
  it('round-trips a configuration-only URI', () => {
    expect(parseSyncSetupQr(createSyncSetupQr(payload))).toEqual(payload);
  });

  it('round-trips a scoped one-time enrollment invitation', () => {
    const invitation = { ...payload, bookId: 'book-retail-1', enrollmentCode: 'LGR-abcdefghijklmnopqrstuvwx', enrollmentRole: 'viewer' as const, locationIds: ['location-east'], expiresAt: '2030-01-01T12:00:00.000Z' };
    expect(parseSyncSetupQr(createSyncSetupQr(invitation))).toEqual(invitation);
  });

  it('accepts the versioned JSON form and local development URLs', () => {
    expect(parseSyncSetupQr(JSON.stringify({ type: 'ledgr-sync-setup', version: 1, serverUrl: 'http://192.168.1.20:8787', oidcIssuer: 'http://localhost:8080', oidcClientId: 'ledgr-mobile' }))).toEqual({ serverUrl: 'http://192.168.1.20:8787', oidcIssuer: 'http://localhost:8080', oidcClientId: 'ledgr-mobile' });
  });

  it('rejects credentials and unsafe remote HTTP endpoints', () => {
    expect(() => parseSyncSetupQr('ledgr://sync-setup?server_url=http%3A%2F%2Fevil.example&oidc_issuer=https%3A%2F%2Fid.example&oidc_client_id=ledgr')).toThrow(/HTTPS/);
    expect(() => parseSyncSetupQr(JSON.stringify({ type: 'ledgr-sync-setup', version: 1, serverUrl: payload.serverUrl, oidcIssuer: payload.oidcIssuer, oidcClientId: payload.oidcClientId, token: 'secret' }))).toThrow(/credentials/);
    expect(() => parseSyncSetupQr(JSON.stringify({ type: 'ledgr-sync-setup', version: 1, ...payload, enrollmentRole: 'viewer' }))).toThrow(/requires an enrollment code/);
    expect(() => parseSyncSetupQr(JSON.stringify({ type: 'ledgr-sync-setup', version: 1, ...payload, enrollmentCode: 'not-a-code' }))).toThrow(/Enrollment code is invalid/);
  });
});
