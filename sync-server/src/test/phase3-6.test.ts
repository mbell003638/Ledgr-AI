import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../server.js';
import { AnonymousAuthenticator } from '../auth.js';
import { MemoryEventStore } from '../store.js';

async function start(options: any = {}) {
  const server = createServer(new MemoryEventStore(), { authenticator: new AnonymousAuthenticator(), operationsToken: 'ops-token', ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('protected health endpoint separates readiness and dependency state', async (t) => {
  const { server, base } = await start({ readiness: async () => undefined, health: async () => ({ status: 'healthy', database: { status: 'healthy' }, backup: { status: 'healthy' } }) });
  t.after(() => server.close());
  assert.equal((await fetch(`${base}/v1/ops/health`)).status, 401);
  assert.equal((await fetch(`${base}/readyz`, { headers: { authorization: 'Bearer ops-token' } })).status, 200);
  const response = await fetch(`${base}/v1/ops/health`, { headers: { authorization: 'Bearer ops-token' } });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.status, 'healthy');
  assert.equal(body.liveness.status, 'healthy');
  assert.equal(body.readiness.status, 'ready');
  assert.equal(body.dependencies.backup.status, 'healthy');
});

test('administration routes delegate through authenticated device and membership controls', async (t) => {
  const state = { renamed: '', removed: '', locations: [] as string[] };
  const admin = {
    authorize: async () => undefined,
    listDevices: async () => [{ bookId: 'book-admin', deviceId: 'device-1', subject: 'owner', enrolledEpoch: 'epoch', enrolledAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), displayName: 'Register 1', platform: 'android' }],
    renameDevice: async (_principal: any, _bookId: string, deviceId: string, displayName: string) => { state.renamed = `${deviceId}:${displayName}`; },
    listMemberships: async () => [{ bookId: 'book-admin', subject: 'owner', role: 'owner', locationIds: [], updatedAt: new Date().toISOString() }],
    upsertMembership: async (_principal: any, bookId: string, subject: string, role: string) => ({ bookId, subject, role, locationIds: [], updatedAt: new Date().toISOString() }),
    removeMembership: async (_principal: any, _bookId: string, subject: string) => { state.removed = subject; },
    setMembershipLocations: async (_principal: any, _bookId: string, _subject: string, locationIds: string[]) => { state.locations = locationIds; },
  };
  const { server, base } = await start({ authorizer: admin, deviceAdministration: admin });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/v1/sync/devices?bookId=book-admin&deviceId=device-1`)).status, 200);
  const memberships = await fetch(`${base}/v1/sync/memberships?bookId=book-admin&deviceId=device-1`);
  assert.equal(memberships.status, 200);
  assert.equal((await memberships.json() as any).memberships[0].role, 'owner');
  assert.equal((await fetch(`${base}/v1/sync/devices/rename`, { method: 'POST', headers, body: JSON.stringify({ bookId: 'book-admin', deviceId: 'device-1', callerDeviceId: 'device-1', displayName: 'Front register' }) })).status, 200);
  assert.equal(state.renamed, 'device-1:Front register');
  assert.equal((await fetch(`${base}/v1/sync/memberships/locations`, { method: 'POST', headers, body: JSON.stringify({ bookId: 'book-admin', deviceId: 'device-1', subject: 'owner', locationIds: ['shop-a', 'shop-b'] }) })).status, 200);
  assert.deepEqual(state.locations, ['shop-a', 'shop-b']);
});

test('one-time enrollment code routes issue and redeem short-lived device access', async (t) => {
  const state = { created: false, redeemed: false };
  const admin = {
    authorize: async () => undefined,
    createEnrollmentCode: async (_principal: any, bookId: string, role: string, locationIds: string[]) => { state.created = true; return { codeId: 'code-1', bookId, code: 'LGR-abcdefghijklmnopqrstuv', role, locationIds, expiresAt: new Date(Date.now() + 900_000).toISOString() }; },
    redeemEnrollmentCode: async (_principal: any, code: string, deviceId: string, displayName?: string, platform?: string) => { state.redeemed = code.startsWith('LGR-') && deviceId === 'device-new' && displayName === 'POS 1' && platform === 'android'; return { bookId: 'book-code', bookEpoch: 'epoch-code', epochNumber: 1, epochStartSequence: 1, currentSequence: 0, device: { deviceId, displayName, platform } }; },
  };
  const { server, base } = await start({ authorizer: admin, deviceAdministration: admin });
  t.after(() => server.close());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${base}/v1/sync/enrollment-codes`, { method: 'POST', headers, body: JSON.stringify({ bookId: 'book-code', deviceId: 'device-admin', role: 'viewer', locationIds: ['shop-a'], ttlMinutes: 15 }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as any).enrollment.code, 'LGR-abcdefghijklmnopqrstuv');
  const redeemed = await fetch(`${base}/v1/sync/enroll-code/redeem`, { method: 'POST', headers, body: JSON.stringify({ code: 'LGR-abcdefghijklmnopqrstuv', deviceId: 'device-new', displayName: 'POS 1', platform: 'android' }) });
  assert.equal(redeemed.status, 200);
  assert.equal(state.created, true);
  assert.equal(state.redeemed, true);
});
