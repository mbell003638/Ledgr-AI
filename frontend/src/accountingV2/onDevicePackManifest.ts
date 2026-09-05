import { OPTIONAL_ON_DEVICE_MODELS, type OnDevicePackCapability } from './onDeviceTools';

/**
 * A model pack the app can offer. Identical in shape to a catalogue entry, so
 * the compiled-in list and a fetched manifest are interchangeable.
 */
export type OnDevicePack = {
  id: string;
  label: string;
  summary: string;
  bytes: number;
  minRamBytes: number;
  vision: boolean;
  audio: boolean;
  rank: number;
  capabilities: OnDevicePackCapability[];
  filename: string;
  downloadUrl: string;
  sha256?: string;
  /** Packs needing a newer app than this are ignored rather than offered. */
  minAppVersion?: number;
};

/**
 * The catalogue is compiled into the app, so adding a pack or correcting a URL
 * would otherwise need a Play release. A manifest makes both a data change:
 * this app version is the floor, and anything declaring a higher
 * minAppVersion is skipped rather than offered and then failing to load.
 */
export const ON_DEVICE_PACK_SCHEMA = 1;
export const APP_PACK_RUNTIME_VERSION = 1;

export const DEFAULT_PACK_MANIFEST_URL =
  'https://raw.githubusercontent.com/mbell003638/Ledgr-AI/main/model-packs.json';

const CAPABILITIES: OnDevicePackCapability[] = ['text', 'tools', 'vision', 'audio'];

function asCapabilities(value: unknown): OnDevicePackCapability[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is OnDevicePackCapability =>
    typeof entry === 'string' && (CAPABILITIES as string[]).includes(entry));
}

function positiveInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Turns one manifest row into a pack, or null when it is unusable.
 *
 * Rows come from a file on the network, so nothing is trusted: a pack without a
 * filename, an https URL, or a declared capability cannot be downloaded or
 * routed to safely, and is dropped rather than half-accepted.
 */
export function parsePackRow(row: unknown): OnDevicePack | null {
  if (!row || typeof row !== 'object') return null;
  const source = row as Record<string, unknown>;
  const id = String(source.id || '').trim();
  const filename = String(source.filename || '').trim();
  const downloadUrl = String(source.downloadUrl || '').trim();
  const capabilities = asCapabilities(source.capabilities);
  if (!id || !filename || !capabilities.length) return null;
  if (!/^https:\/\//i.test(downloadUrl)) return null;
  // A filename is used as a path on the device; never let one escape the folder.
  if (/[\\/]|\.\./.test(filename)) return null;

  const minAppVersion = positiveInt(source.minAppVersion) || 0;
  if (minAppVersion > APP_PACK_RUNTIME_VERSION) return null;

  return {
    id,
    label: String(source.label || id),
    summary: String(source.summary || ''),
    bytes: positiveInt(source.bytes),
    minRamBytes: positiveInt(source.minRamBytes),
    vision: capabilities.includes('vision'),
    audio: capabilities.includes('audio'),
    rank: Number.isFinite(Number(source.rank)) ? Number(source.rank) : 0,
    capabilities,
    filename,
    downloadUrl,
    ...(typeof source.sha256 === 'string' && source.sha256.trim() ? { sha256: source.sha256.trim() } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
  };
}

/** Parses a whole manifest, dropping rows this build cannot use. */
export function parsePackManifest(raw: unknown): OnDevicePack[] {
  if (!raw || typeof raw !== 'object') return [];
  const body = raw as Record<string, unknown>;
  if (positiveInt(body.schema) !== ON_DEVICE_PACK_SCHEMA) return [];
  if (!Array.isArray(body.packs)) return [];
  const packs = body.packs.map(parsePackRow).filter((pack): pack is OnDevicePack => pack !== null);
  // Two rows claiming one id would make selection non-deterministic.
  const byId = new Map<string, OnDevicePack>();
  for (const pack of packs) if (!byId.has(pack.id)) byId.set(pack.id, pack);
  return [...byId.values()];
}

/** The packs compiled into this build, used until a manifest is fetched. */
export function bundledPacks(): OnDevicePack[] {
  return OPTIONAL_ON_DEVICE_MODELS.map((spec) => ({ ...spec }));
}
