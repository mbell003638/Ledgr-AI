import AsyncStorage from '@react-native-async-storage/async-storage';
import { activeBookId, activeSqlRunner } from '@/src/db/backend';
import { getSyncStatus } from '@/src/sync/coordinator';

export type HostingMode = 'local_only' | 'private_sync' | 'cloud_drive' | 'local_wifi';

export const HOSTING_MODE_LABELS: Record<HostingMode, string> = {
  local_only: 'Local-only mode',
  private_sync: 'Private sync',
  cloud_drive: 'Google Drive Sync (E2EE)',
  local_wifi: 'Nearby Wi-Fi Sync (P2P)',
};

export const HOSTING_MODE_DESCRIPTIONS: Record<HostingMode, string> = {
  local_only: 'Ledgr works on this device without a server or internet connection. Use an encrypted backup to move or recover this business book.',
  private_sync: 'Ledgr still works offline, while your own private sync server coordinates approved changes across enrolled devices.',
  cloud_drive: 'Encrypted delta sync and offsite backup via Google Drive with zero-knowledge keys.',
  local_wifi: 'Instant peer-to-peer sync between devices on the same local network using QR codes.',
};

export const HOSTING_CONCEPT_COPY = {
  backup: 'Back up your data',
  sync: 'Add another device',
  serverHealth: 'Server health',
  futureHostedErp: 'A full hosted ERP is a separate future product concept and is not required for Ledgr today.',
} as const;

export type HostingModeState = {
  mode: HostingMode;
  requestedMode: HostingMode;
  configured: boolean;
  enabled: boolean;
  pending: number;
  conflicts: number;
  retryable: number;
  recoveryRequired: boolean;
  bootstrapRequired: boolean;
  serverUrl?: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
};

const HOSTING_MODE_KEY = 'ledgr:hosting_mode';

export async function getRequestedHostingMode(): Promise<HostingMode> {
  const value = await AsyncStorage.getItem(HOSTING_MODE_KEY);
  if (value === 'private_sync' || value === 'cloud_drive' || value === 'local_wifi') {
    return value;
  }
  return 'local_only';
}

export async function setRequestedHostingMode(mode: HostingMode): Promise<void> {
  await AsyncStorage.setItem(HOSTING_MODE_KEY, mode);
}

/**
 * Reads the effective mode from the persisted user preference and semantic-sync
 * state. A requested private-sync mode is not effective until sync is configured;
 * this prevents a misleading status after a cancelled setup flow.
 */
async function getCurrentSyncStatus(): Promise<any> {
  const runner = activeSqlRunner();
  if (!runner) return { enabled: false, configured: false, pending: 0, conflicts: 0, retryable: 0 };
  return getSyncStatus(runner, activeBookId()).catch(() => ({ enabled: false, configured: false, pending: 0, conflicts: 0, retryable: 0 }));
}

export async function getHostingModeState(): Promise<HostingModeState> {
  const [requestedMode, status] = await Promise.all([
    getRequestedHostingMode(),
    getCurrentSyncStatus(),
  ]);
  const configured = status.configured === true;
  let mode: HostingMode = 'local_only';
  if (requestedMode === 'private_sync' && configured) {
    mode = 'private_sync';
  } else if (requestedMode === 'cloud_drive') {
    mode = 'cloud_drive';
  } else if (requestedMode === 'local_wifi') {
    mode = 'local_wifi';
  }

  return {
    mode,
    requestedMode,
    configured,
    enabled: status.enabled === true,
    pending: Number(status.pending || 0),
    conflicts: Number(status.conflicts || 0),
    retryable: Number(status.retryable || 0),
    recoveryRequired: status.recoveryRequired === true,
    bootstrapRequired: status.bootstrapRequired === true,
    serverUrl: status.serverUrl || undefined,
    lastSyncAt: status.lastSyncAt || null,
    lastError: status.lastError || null,
  };
}

export function hostingModeSummary(state: HostingModeState): string {
  if (state.mode === 'local_only') return HOSTING_MODE_DESCRIPTIONS.local_only;
  if (state.mode === 'cloud_drive') return HOSTING_MODE_DESCRIPTIONS.cloud_drive;
  if (state.mode === 'local_wifi') return HOSTING_MODE_DESCRIPTIONS.local_wifi;
  if (state.recoveryRequired) return 'Private sync is configured, but recovery is required before the server can receive new changes.';
  if (state.conflicts > 0) return `${state.conflicts} sync conflict${state.conflicts === 1 ? '' : 's'} need review. Local work remains available.`;
  if (state.pending > 0) return `${state.pending} local change${state.pending === 1 ? '' : 's'} waiting to synchronize.`;
  return HOSTING_MODE_DESCRIPTIONS.private_sync;
}

export type HostingStatusInput = {
  enabled: boolean;
  configured: boolean;
  mode?: HostingMode;
  pending: number;
  retryable: number;
  conflicts: number;
  lastSyncAt?: string;
  recoveryRequired?: boolean;
  recoveryReason?: string;
};

export function deriveHostingMode(status: HostingStatusInput): {
  mode: HostingMode;
  label: string;
  summary: string;
  tone: 'healthy' | 'attention' | 'critical';
  detail: string;
} {
  if (status.mode === 'cloud_drive') {
    return {
      mode: 'cloud_drive',
      label: 'Google Drive Sync (E2EE)',
      summary: 'Syncing encrypted deltas via private Google Drive app folder.',
      tone: 'healthy',
      detail: status.lastSyncAt ? `Last cloud sync: ${status.lastSyncAt}` : 'Encrypted cloud sync active.',
    };
  }
  if (status.mode === 'local_wifi') {
    return {
      mode: 'local_wifi',
      label: 'Nearby Wi-Fi Sync (P2P)',
      summary: 'Direct device-to-device synchronization over local Wi-Fi.',
      tone: 'healthy',
      detail: 'Instant offline sync ready for QR pairing.',
    };
  }
  if (status.recoveryRequired) {
    return {
      mode: status.configured ? 'private_sync' : 'local_only',
      label: 'Recovery required',
      summary: 'Private sync is paused to protect this Business Account.',
      tone: 'critical',
      detail: status.recoveryReason || 'Complete validated recovery before enabling sync.',
    };
  }
  if (status.conflicts > 0) {
    return {
      mode: 'private_sync',
      label: 'Private sync needs review',
      summary: `${status.conflicts} sync conflict${status.conflicts === 1 ? '' : 's'} need review.`,
      tone: 'attention',
      detail: 'Local accounting remains available while retained concurrent edits are reviewed.',
    };
  }
  if (status.enabled && status.configured) {
    const pending = Math.max(0, Number(status.pending || 0));
    return {
      mode: 'private_sync',
      label: 'Private sync',
      summary: pending ? `${pending} local change${pending === 1 ? '' : 's'} waiting to sync.` : 'This Business Account is synchronized with your configured server.',
      tone: status.retryable > 0 ? 'attention' : 'healthy',
      detail: status.lastSyncAt ? `Last successful sync: ${status.lastSyncAt}` : 'Configured and ready for its first successful sync.',
    };
  }
  if (status.configured) {
    return {
      mode: 'local_only',
      label: 'Local-only — sync paused',
      summary: 'Data stays on this device while private sync is disabled.',
      tone: 'attention',
      detail: 'The server configuration is retained and can be re-enabled after review.',
    };
  }
  return {
    mode: 'local_only',
    label: 'Local-only',
    summary: 'Accounting data stays on this device unless you export a backup.',
    tone: 'healthy',
    detail: 'Private sync is optional and has not been configured.',
  };
}

export { HOSTING_MODE_KEY };
