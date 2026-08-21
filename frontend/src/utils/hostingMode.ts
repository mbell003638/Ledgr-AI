import AsyncStorage from '@react-native-async-storage/async-storage';
import { activeBookId, activeSqlRunner } from '@/src/db/backend';
import { getSyncStatus } from '@/src/sync/coordinator';

export type HostingMode = 'local_only' | 'private_sync';

export const HOSTING_MODE_LABELS: Record<HostingMode, string> = {
  local_only: 'Local-only mode',
  private_sync: 'Private sync',
};

export const HOSTING_MODE_DESCRIPTIONS: Record<HostingMode, string> = {
  local_only: 'Ledgr works on this device without a server or internet connection. Use an encrypted backup to move or recover this business book.',
  private_sync: 'Ledgr still works offline, while your own private sync server coordinates approved changes across enrolled devices.',
};

export const HOSTING_CONCEPT_COPY = {
  backup: 'Encrypted backup',
  sync: 'Private sync',
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
  return value === 'private_sync' ? 'private_sync' : 'local_only';
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
  const mode: HostingMode = configured && requestedMode === 'private_sync' ? 'private_sync' : 'local_only';
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
  if (state.recoveryRequired) return 'Private sync is configured, but recovery is required before the server can receive new changes.';
  if (state.conflicts > 0) return `${state.conflicts} sync conflict${state.conflicts === 1 ? '' : 's'} need review. Local work remains available.`;
  if (state.pending > 0) return `${state.pending} local change${state.pending === 1 ? '' : 's'} waiting to synchronize.`;
  return HOSTING_MODE_DESCRIPTIONS.private_sync;
}

export { HOSTING_MODE_KEY };
