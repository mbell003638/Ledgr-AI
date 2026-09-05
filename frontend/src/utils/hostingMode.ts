export type HostingMode = 'local_only' | 'private_sync' | 'cloud_drive' | 'local_wifi';

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

export type HostingModeState = {
  mode: HostingMode;
  label: string;
  summary: string;
  tone: 'healthy' | 'attention' | 'critical';
  detail: string;
};

export function deriveHostingMode(status: HostingStatusInput): HostingModeState {
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
