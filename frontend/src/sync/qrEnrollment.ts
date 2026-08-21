export const LEDGR_SYNC_QR_KIND = 'ledgr.sync.enrollment' as const;
export const LEDGR_SYNC_QR_VERSION = 1 as const;

export type LedgrSyncQrInvite = {
  kind: typeof LEDGR_SYNC_QR_KIND;
  version: typeof LEDGR_SYNC_QR_VERSION;
  serverUrl: string;
  bookId: string;
  code: string;
  role: string;
  locationIds: string[];
  expiresAt: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcScopes?: string;
};

function requiredString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`QR invite ${field} is invalid`);
  return value.trim();
}

function normalizeServerUrl(value: unknown): string {
  const raw = requiredString(value, 'server address', 2048).replace(/\/+$/u, '');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('QR invite server address is invalid'); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error('QR invite server address must use HTTPS');
  return raw;
}

export function encodeLedgrSyncQrInvite(input: Omit<LedgrSyncQrInvite, 'kind' | 'version'>): string {
  const invite: LedgrSyncQrInvite = { kind: LEDGR_SYNC_QR_KIND, version: LEDGR_SYNC_QR_VERSION, serverUrl: normalizeServerUrl(input.serverUrl), bookId: requiredString(input.bookId, 'Business Account', 120), code: requiredString(input.code, 'one-time code', 100), role: requiredString(input.role, 'role', 30), locationIds: Array.isArray(input.locationIds) ? input.locationIds.map((value) => requiredString(value, 'location scope', 120)).slice(0, 500) : [], expiresAt: requiredString(input.expiresAt, 'expiry', 80), ...(input.oidcIssuer ? { oidcIssuer: normalizeServerUrl(input.oidcIssuer) } : {}), ...(input.oidcClientId ? { oidcClientId: requiredString(input.oidcClientId, 'application ID', 200) } : {}), ...(input.oidcScopes ? { oidcScopes: requiredString(input.oidcScopes, 'permissions', 500) } : {}) };
  return JSON.stringify(invite);
}

export function decodeLedgrSyncQrInvite(raw: string): LedgrSyncQrInvite {
  if (typeof raw !== 'string' || raw.length > 8000) throw new Error('This QR code is not a Ledgr invitation');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('This QR code is not a Ledgr invitation'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('This QR code is not a Ledgr invitation');
  const value = parsed as Record<string, unknown>;
  if (value.kind !== LEDGR_SYNC_QR_KIND || value.version !== LEDGR_SYNC_QR_VERSION) throw new Error('This QR code is for a different Ledgr sync version');
  const expiresAt = requiredString(value.expiresAt, 'expiry', 80);
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) throw new Error('This Ledgr invitation has expired');
  const locationIds = Array.isArray(value.locationIds) ? value.locationIds.map((item) => requiredString(item, 'location scope', 120)).slice(0, 500) : [];
  return { kind: LEDGR_SYNC_QR_KIND, version: LEDGR_SYNC_QR_VERSION, serverUrl: normalizeServerUrl(value.serverUrl), bookId: requiredString(value.bookId, 'Business Account', 120), code: requiredString(value.code, 'one-time code', 100), role: requiredString(value.role, 'role', 30), locationIds, expiresAt, ...(value.oidcIssuer ? { oidcIssuer: normalizeServerUrl(value.oidcIssuer) } : {}), ...(value.oidcClientId ? { oidcClientId: requiredString(value.oidcClientId, 'application ID', 200) } : {}), ...(value.oidcScopes ? { oidcScopes: requiredString(value.oidcScopes, 'permissions', 500) } : {}) };
}
