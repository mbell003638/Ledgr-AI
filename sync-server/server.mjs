import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.LEDGR_SYNC_DATA_DIR || path.join(__dirname, 'data'));
const ACCESS_TOKEN = String(process.env.LEDGR_SYNC_TOKEN || '').trim();
const ALLOWED_ORIGIN = process.env.LEDGR_SYNC_ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.LEDGR_SYNC_MAX_BODY_BYTES || 50 * 1024 * 1024);

function fingerprint(value) {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function safeWorkspaceId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(id)) throw new Error('workspaceId must contain only letters, numbers, dots, underscores, colons, or hyphens.');
  return id;
}

function workspacePath(workspaceId) {
  const digest = crypto.createHash('sha256').update(workspaceId).digest('hex');
  return path.join(DATA_DIR, `${digest}.json`);
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  response.end(payload);
}

function authenticate(request) {
  if (!ACCESS_TOKEN) return true;
  const header = String(request.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(ACCESS_TOKEN);
  return suppliedBytes.length === expectedBytes.length && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}

async function readWorkspace(workspaceId) {
  try { return JSON.parse(await fs.readFile(workspacePath(workspaceId), 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeWorkspace(workspaceId, record) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const target = workspacePath(workspaceId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot is required.');
  if (snapshot?._meta?.app !== 'ledgr') throw new Error('snapshot is not a Ledgr backup.');
  if (!Number.isFinite(Number(snapshot?._meta?.version))) throw new Error('snapshot has no supported Ledgr backup version.');
  if (!snapshot.v2?.tables || typeof snapshot.v2.tables !== 'object') throw new Error('snapshot must contain the V2 accounting payload.');
}

async function handle(request, response) {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  if (!authenticate(request)) return send(response, 401, { error: 'unauthorized', message: 'A valid bearer token is required.' });
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/v1/sync/health') return send(response, 200, { ok: true, service: 'ledgr-self-host-sync', version: 1 });

  try {
    if (request.method === 'GET' && url.pathname === '/v1/sync/pull') {
      const workspaceId = safeWorkspaceId(url.searchParams.get('workspaceId'));
      const record = await readWorkspace(workspaceId);
      if (!record) return send(response, 404, { error: 'not_found', message: 'No remote snapshot exists for this workspace.' });
      return send(response, 200, { workspaceId, etag: record.etag, snapshotHash: record.snapshotHash, updatedAt: record.updatedAt, snapshot: record.snapshot });
    }

    if (request.method === 'POST' && url.pathname === '/v1/sync/push') {
      const body = await readBody(request);
      const workspaceId = safeWorkspaceId(body.workspaceId);
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId || deviceId.length > 160) throw new Error('deviceId is required.');
      validateSnapshot(body.snapshot);
      const snapshotHash = fingerprint(body.snapshot);
      if (body.snapshotHash && body.snapshotHash !== snapshotHash) throw new Error('snapshotHash does not match snapshot content.');
      const existing = await readWorkspace(workspaceId);
      if (existing && body.baseSnapshotHash !== existing.etag) {
        return send(response, 409, { error: 'conflict', message: 'The remote workspace changed since this device last synchronized.', remoteEtag: existing.etag, remoteHash: existing.snapshotHash, updatedAt: existing.updatedAt });
      }
      const etag = `${snapshotHash}-${Date.now().toString(36)}`;
      const record = { workspaceId, etag, snapshotHash, updatedAt: new Date().toISOString(), deviceId, snapshot: body.snapshot };
      await writeWorkspace(workspaceId, record);
      return send(response, 200, { ok: true, workspaceId, etag, snapshotHash, updatedAt: record.updatedAt });
    }

    return send(response, 404, { error: 'not_found', message: 'Unknown sync endpoint.' });
  } catch (error) {
    return send(response, Number(error?.statusCode || 400), { error: 'invalid_request', message: error?.message || 'Request could not be processed.' });
  }
}

const server = http.createServer((request, response) => { handle(request, response).catch((error) => send(response, 500, { error: 'server_error', message: error?.message || 'Unexpected server error.' })); });
server.listen(PORT, HOST, () => console.log(`Ledgr self-host sync listening on ${HOST}:${PORT}`));
