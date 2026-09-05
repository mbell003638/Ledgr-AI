import { encryptPayload, decryptPayload, type EncryptedEnvelope } from './e2ee';
import { hashPayload, type SyncSnapshot, type SyncOperation } from './protocol';
import { randomBytes } from '@noble/hashes/utils';

export const WIFI_P2P_QR_SCHEME = 'ledgr://wifi-p2p';
export const DEFAULT_P2P_PORT = 8787;

export type WifiP2pSession = {
  sessionId: string;
  bookId: string;
  hostIp: string;
  port: number;
  ephemeralKeyHex: string;
  createdAt: string;
  expiresAt: string;
};

export type WifiP2pTransferPackage = {
  version: number;
  bookId: string;
  bookEpoch: string;
  snapshot: SyncSnapshot;
  pendingOperations: SyncOperation[];
  packageChecksum: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function createWifiP2pSession(
  bookId: string,
  hostIp = '127.0.0.1',
  port = DEFAULT_P2P_PORT,
  validityMinutes = 15
): { session: WifiP2pSession; key: Uint8Array; qrCodeUri: string } {
  const key = randomBytes(32);
  const ephemeralKeyHex = bytesToHex(key);
  const sessionId = 'p2p_' + bytesToHex(randomBytes(8));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validityMinutes * 60 * 1000).toISOString();

  const session: WifiP2pSession = {
    sessionId,
    bookId,
    hostIp,
    port,
    ephemeralKeyHex,
    createdAt: now.toISOString(),
    expiresAt,
  };

  const params = new URLSearchParams({
    s: sessionId,
    b: bookId,
    ip: hostIp,
    p: String(port),
    k: ephemeralKeyHex,
    exp: expiresAt,
  });

  const qrCodeUri = `${WIFI_P2P_QR_SCHEME}?${params.toString()}`;

  return { session, key, qrCodeUri };
}

export function parseWifiP2pQr(rawUri: string): WifiP2pSession {
  const trimmed = rawUri.trim();
  if (!trimmed.startsWith(WIFI_P2P_QR_SCHEME)) {
    throw new Error('Not a valid Ledgr Wi-Fi pairing code');
  }

  const queryIdx = trimmed.indexOf('?');
  if (queryIdx === -1) {
    throw new Error('Malformed Wi-Fi pairing code');
  }

  const query = trimmed.slice(queryIdx + 1);
  const params = new URLSearchParams(query);

  const sessionId = params.get('s');
  const bookId = params.get('b');
  const hostIp = params.get('ip');
  const port = parseInt(params.get('p') || '0', 10);
  const ephemeralKeyHex = params.get('k');
  const expiresAt = params.get('exp');

  if (!sessionId || !bookId || !hostIp || !port || !ephemeralKeyHex || !expiresAt) {
    throw new Error('Incomplete Wi-Fi pairing parameters');
  }

  if (new Date(expiresAt).getTime() < Date.now()) {
    throw new Error('This Wi-Fi pairing invitation has expired. Please create a new one.');
  }

  return {
    sessionId,
    bookId,
    hostIp,
    port,
    ephemeralKeyHex,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
}

export function packWifiTransfer(
  snapshot: SyncSnapshot,
  pendingOps: SyncOperation[],
  key: Uint8Array
): { envelope: EncryptedEnvelope; checksum: string } {
  const checksum = hashPayload({ snapshot, pendingOps });
  const pkg: WifiP2pTransferPackage = {
    version: 1,
    bookId: snapshot.bookId,
    bookEpoch: snapshot.bookEpoch,
    snapshot,
    pendingOperations: pendingOps,
    packageChecksum: checksum,
  };

  const envelope = encryptPayload(pkg, key);
  return { envelope, checksum };
}

export function unpackWifiTransfer(
  envelope: EncryptedEnvelope,
  key: Uint8Array
): WifiP2pTransferPackage {
  const pkg = decryptPayload<WifiP2pTransferPackage>(envelope, key);

  if (!pkg || !pkg.snapshot || !pkg.packageChecksum) {
    throw new Error('Invalid or corrupted Wi-Fi transfer package');
  }

  const computed = hashPayload({ snapshot: pkg.snapshot, pendingOps: pkg.pendingOperations });
  if (computed !== pkg.packageChecksum) {
    throw new Error('Integrity verification failed: package checksum mismatch');
  }

  return pkg;
}

export async function fetchWifiTransferPackage(
  session: WifiP2pSession
): Promise<WifiP2pTransferPackage> {
  const url = `http://${session.hostIp}:${session.port}/p2p-transfer?s=${encodeURIComponent(session.sessionId)}`;
  const key = hexToBytes(session.ephemeralKeyHex);

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Direct Wi-Fi transfer failed (HTTP ${res.status}): ${res.statusText}`);
  }

  const envelope = await res.json() as EncryptedEnvelope;
  return unpackWifiTransfer(envelope, key);
}
