export const SYNC_SETUP_QR_TYPE = 'ledgr-sync-setup';
export const SYNC_SETUP_QR_VERSION = 1;

export type SyncSetupQrPayload = {
  serverUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcScopes?: string;
  bookId?: string;
  enrollmentCode?: string;
  enrollmentRole?: 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor';
  locationIds?: string[];
  expiresAt?: string;
};

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
    octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)
  );
}

function validateUrl(value: unknown, label: string, allowLocalHttp = false): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2048) throw new Error(`${label} is required`);
  const candidate = value.trim().replace(/\/+$/u, '');
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#].*)?$/iu.exec(candidate);
  if (!match) throw new Error(`${label} must be an HTTPS URL`);
  const protocol = match[1].toLowerCase();
  const hostname = match[2].replace(/^\[[^\]]+\](?::\d+)?$/u, (host) => host.split(':')[0]).split(':')[0];
  if (protocol !== 'https' && !(allowLocalHttp && isPrivateHost(hostname))) throw new Error(`${label} must use HTTPS`);
  return candidate;
}

function validateText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw new Error(`${label} is required`);
  return value.trim();
}

function validateEnrollmentCode(value: unknown): string {
  const code = validateText(value, 'Enrollment code', 100);
  if (!/^LGR-[A-Za-z0-9_-]{20,80}$/u.test(code)) throw new Error('Enrollment code is invalid');
  return code;
}

function validateRole(value: unknown): SyncSetupQrPayload['enrollmentRole'] {
  if (value === undefined || value === null || value === '') return undefined;
  if (!['admin', 'accountant', 'editor', 'viewer', 'auditor'].includes(String(value))) throw new Error('Enrollment role is invalid');
  return value as SyncSetupQrPayload['enrollmentRole'];
}

function validateLocations(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== 'string' || item.trim().length > 120)) throw new Error('Enrollment locations are invalid');
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function fromFields(fields: Record<string, unknown>): SyncSetupQrPayload {
  const serverUrl = validateUrl(fields.serverUrl ?? fields.server_url, 'Server URL', true);
  const oidcIssuer = validateUrl(fields.oidcIssuer ?? fields.oidc_issuer, 'OIDC issuer', true);
  const oidcClientId = validateText(fields.oidcClientId ?? fields.oidc_client_id, 'OIDC client ID', 256);
  const oidcScopes = fields.oidcScopes ?? fields.oidc_scopes;
  const bookId = fields.bookId ?? fields.book_id;
  const enrollmentCode = fields.enrollmentCode ?? fields.enrollment_code;
  const enrollmentRole = fields.enrollmentRole ?? fields.enrollment_role;
  const rawLocationIds = fields.locationIds ?? fields.location_ids;
  let locationIds: unknown = rawLocationIds;
  if (typeof rawLocationIds === 'string') {
    try { locationIds = JSON.parse(rawLocationIds); } catch { throw new Error('Enrollment locations are invalid'); }
  }
  const expiresAt = fields.expiresAt ?? fields.expires_at;
  if (enrollmentRole !== undefined && enrollmentCode === undefined) throw new Error('Enrollment role requires an enrollment code');
  if (locationIds !== undefined && enrollmentCode === undefined) throw new Error('Enrollment locations require an enrollment code');
  if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw new Error('Enrollment expiry is invalid');
  return {
    serverUrl, oidcIssuer, oidcClientId,
    ...(oidcScopes ? { oidcScopes: validateText(oidcScopes, 'OIDC scopes', 512) } : {}),
    ...(bookId !== undefined ? { bookId: validateText(bookId, 'Business Account ID', 256) } : {}),
    ...(enrollmentCode !== undefined ? { enrollmentCode: validateEnrollmentCode(enrollmentCode) } : {}),
    ...(enrollmentRole !== undefined ? { enrollmentRole: validateRole(enrollmentRole) } : {}),
    ...(locationIds !== undefined ? { locationIds: validateLocations(locationIds) } : {}),
    ...(expiresAt !== undefined ? { expiresAt: String(expiresAt) } : {}),
  };
}

function queryFields(query: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const pair of query.split('&').filter(Boolean)) {
    const separator = pair.indexOf('=');
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : '';
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    fields[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
  }
  return fields;
}

export function parseSyncSetupQr(rawValue: string): SyncSetupQrPayload {
  const raw = rawValue.trim();
  if (!raw || raw.length > 4096) throw new Error('This QR code is not a valid Ledgr setup code');
  if (/^(?:\{|\[)/u.test(raw)) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type !== SYNC_SETUP_QR_TYPE || parsed.version !== SYNC_SETUP_QR_VERSION) throw new Error('Unsupported Ledgr setup QR version');
      if ('token' in parsed || 'accessToken' in parsed || 'secret' in parsed) throw new Error('Setup QR codes cannot contain credentials');
      return fromFields(parsed);
    } catch (error: any) {
      throw new Error(error?.message || 'This QR code is not a valid Ledgr setup code');
    }
  }
  const match = /^ledgr:\/\/sync-setup\?(.*)$/iu.exec(raw);
  if (!match) throw new Error('This QR code is not a Ledgr sync setup code');
  const fields = queryFields(match[1]);
  if (Object.keys(fields).some((key) => /token|secret|password|credential/iu.test(key))) throw new Error('Setup QR codes cannot contain credentials');
  return fromFields(fields);
}

export function createSyncSetupQr(payload: SyncSetupQrPayload): string {
  const normalized = fromFields(payload);
  const query = [
    ['server_url', normalized.serverUrl],
    ['oidc_issuer', normalized.oidcIssuer],
    ['oidc_client_id', normalized.oidcClientId],
    ...(normalized.oidcScopes ? [['oidc_scopes', normalized.oidcScopes]] : []),
    ...(normalized.bookId ? [['book_id', normalized.bookId]] : []),
    ...(normalized.enrollmentCode ? [['enrollment_code', normalized.enrollmentCode]] : []),
    ...(normalized.enrollmentRole ? [['enrollment_role', normalized.enrollmentRole]] : []),
    ...(normalized.locationIds?.length ? [['location_ids', JSON.stringify(normalized.locationIds)]] : []),
    ...(normalized.expiresAt ? [['expires_at', normalized.expiresAt]] : []),
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `ledgr://sync-setup?${query}`;
}
