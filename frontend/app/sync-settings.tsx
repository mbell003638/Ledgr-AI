import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { ScreenHeader } from '@/src/components/UI';
import { HostingModeCard } from '@/src/components/HostingModeCard';
import { useTheme } from '@/src/context/ThemeContext';
import { activeBookId, activeSqlRunner } from '@/src/db/backend';
import { advanceSyncEpoch, enrollSyncDevice, listSyncDevices, revokeSyncDevice, type SyncDevice } from '@/src/sync/recovery';

export default function SyncSettingsScreen() {
  const theme = useTheme(); const styles = useMemo(() => makeStyles(theme), [theme]);
  const [serverUrl, setServerUrl] = useState(''); const [userId, setUserId] = useState(''); const [token, setToken] = useState('');
  const [oidcIssuer, setOidcIssuer] = useState(''); const [oidcClientId, setOidcClientId] = useState(''); const [oidcScopes, setOidcScopes] = useState('openid profile offline_access');
  const [status, setStatus] = useState<any>(null); const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await api.getSyncStatus(); setStatus(next);
      if (next.serverUrl) setServerUrl((current) => current || next.serverUrl || '');
      if (next.userId) setUserId((current) => current || next.userId || '');
      if (next.oidcIssuer) setOidcIssuer((current) => current || next.oidcIssuer || '');
      if (next.oidcClientId) setOidcClientId((current) => current || next.oidcClientId || '');
      if (next.oidcScopes) setOidcScopes((current) => current || next.oidcScopes || '');
      const db = activeSqlRunner(); setDevices(db && next.configured ? await listSyncDevices(db, activeBookId()).catch(() => []) : []);
    } catch (error: any) { setMessage(error?.message || 'Sync is unavailable until SQLite is ready.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const enroll = async () => {
    setBusy(true); setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) throw new Error(!prerequisites.integrity.ok ? prerequisites.integrity.issues.join(' ') : 'Create and verify an encrypted backup before connecting private sync.');
      await api.configureSync({ serverUrl, userId, accessToken: token, enabled: false, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner(); if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await enrollSyncDevice(db, activeBookId()); setToken('');
      const next = await api.getSyncStatus(); setStatus(next);
      setMessage(next.bootstrapRequired ? 'Device enrolled against an empty server epoch. Review the destination, then explicitly choose Publish snapshot to make this local Business Account canonical before sync can start.' : next.recoveryRequired ? `Device enrolled in epoch ${enrolled.epochNumber}. Export a backup, then install the validated server snapshot.` : 'Device enrolled. Local writes remain available offline.');
      await load();
    } catch (error: any) { setMessage(error?.message || 'Could not enroll this device.'); } finally { setBusy(false); }
  };
  const enrollOidc = async () => {
    setBusy(true); setMessage('');
    try {
      const prerequisites = await api.getPrivateSyncPrerequisites();
      if (!prerequisites.ok) throw new Error(!prerequisites.integrity.ok ? prerequisites.integrity.issues.join(' ') : 'Create and verify an encrypted backup before connecting private sync.');
      await api.authorizeSyncOidc({ serverUrl, userId, oidcIssuer, oidcClientId, oidcScopes });
      const db = activeSqlRunner(); if (!db) throw new Error('Sync requires SQLite storage');
      const enrolled = await enrollSyncDevice(db, activeBookId());
      const next = await api.getSyncStatus(); setStatus(next);
      setMessage(next.bootstrapRequired ? 'OIDC sign-in succeeded. This server epoch is empty; explicitly publish the initial snapshot after reviewing the destination.' : next.recoveryRequired ? `OIDC sign-in succeeded for epoch ${enrolled.epochNumber}. Export a backup, then install the validated server snapshot.` : 'OIDC sign-in and device enrollment completed. Local writes remain available offline.');
      await load();
    } catch (error: any) { setMessage(error?.message || 'Could not sign in and enroll this device.'); } finally { setBusy(false); }
  };
  const sync = async () => { setBusy(true); setMessage(''); try { setStatus(await api.syncNow()); setMessage('Sync completed.'); await load(); } catch (error: any) { setMessage(error?.message || 'Sync could not reach the server; local data is unchanged.'); } finally { setBusy(false); } };
  const retry = async () => { setBusy(true); setMessage(''); try { setStatus(await api.retrySyncNow()); setMessage('Retry completed.'); await load(); } catch (error: any) { setMessage(error?.message || 'Retry could not reach the server; local data is unchanged.'); } finally { setBusy(false); } };
  const advanceEpoch = () => Alert.alert('Advance server epoch?', 'Use this only when reset, restore, or deletion intentionally replaces the shared Business Account. All devices will be revoked and must re-enroll.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Advance epoch', style: 'destructive', onPress: async () => { const db = activeSqlRunner(); if (!db) return; setBusy(true); try { await advanceSyncEpoch(db, activeBookId(), status?.recoveryReason || 'Explicit recovery'); setMessage('Server epoch advanced. Re-enroll this device, sync the empty epoch, then publish a recovery snapshot.'); await load(); } catch (error: any) { setMessage(error?.message || 'Could not advance the server epoch.'); } finally { setBusy(false); } } }]);
  const installSnapshot = async () => {
    setBusy(true); setMessage('');
    try {
      const fn = (api as any).installSyncSnapshot;
      if (typeof fn !== 'function') throw new Error('Snapshot installer is not registered in this build');
      await fn(); setMessage('Validated snapshot installed, canonical events caught up, and preserved local work replayed atomically.'); await load();
    } catch (error: any) { setMessage(error?.message || 'Snapshot recovery failed; local data was rolled back.'); } finally { setBusy(false); }
  };
  const publish = async () => { setBusy(true); setMessage(''); try { await api.publishSyncSnapshot(); setMessage('Recovery snapshot published for this canonical checkpoint.'); await load(); } catch (error: any) { setMessage(error?.message || 'Could not publish the recovery snapshot.'); } finally { setBusy(false); } };
  const verify = async () => { setBusy(true); setMessage(''); try { const result = await api.verifySyncCheckpoint(); setMessage(result.eventHashMatches && result.projectionHashMatches !== false ? 'Checkpoint verified.' : 'Checkpoint mismatch detected; recovery is required.'); await load(); } catch (error: any) { setMessage(error?.message || 'Checkpoint verification failed.'); } finally { setBusy(false); } };
  const disable = async () => { setBusy(true); try { await api.disableSync(); setMessage('Sync disabled. Pending local work is retained.'); await load(); } catch (error: any) { setMessage(error?.message || 'Could not disable sync.'); } finally { setBusy(false); } };
  const enable = async () => { setBusy(true); try { await api.enableSync(); setMessage('Sync enabled. Local writes remain offline-first.'); await load(); } catch (error: any) { setMessage(error?.message || 'Could not enable sync.'); } finally { setBusy(false); } };
  const revoke = (device: SyncDevice) => Alert.alert('Revoke device?', device.current ? 'This device will stop syncing and must be explicitly re-enrolled.' : `Device ${device.deviceId.slice(0, 12)}… will no longer access this Business Account.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Revoke', style: 'destructive', onPress: async () => { const db = activeSqlRunner(); if (!db) return; setBusy(true); try { await revokeSyncDevice(db, activeBookId(), device.deviceId); setMessage('Device revoked.'); await load(); } catch (error: any) { setMessage(error?.message || 'Could not revoke device.'); } finally { setBusy(false); } } }]);
  return <SafeAreaView style={styles.container} edges={['top']}>
    <View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable><ScreenHeader title="Self-hosted Sync" subtitle="Optional offline-first collaboration" /></View>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <HostingModeCard compact />
      <Pressable testID="open-sync-admin" onPress={() => router.push('/sync-admin' as any)} style={styles.adminLink}><Ionicons name="people-outline" size={20} color={theme.color.brandPrimary} /><View style={{ flex: 1 }}><Text style={styles.adminLinkTitle}>Sync Administration</Text><Text style={styles.hint}>Manage enrolled devices, user roles, and location access</Text></View><Ionicons name="chevron-forward" size={18} color={theme.color.muted} /></Pressable>
      <Pressable testID="open-sync-health" onPress={() => router.push('/sync-health' as any)} style={styles.adminLink}><Ionicons name="pulse-outline" size={20} color={theme.color.brandPrimary} /><View style={{ flex: 1 }}><Text style={styles.adminLinkTitle}>Sync Health</Text><Text style={styles.hint}>Review offline queue, last errors, readiness, and backup health</Text></View><Ionicons name="chevron-forward" size={18} color={theme.color.muted} /></Pressable>
      <View style={styles.card}><Text style={styles.title}>Your device stays local first</Text>
<Text style={styles.hint}>Writes commit locally immediately. Enrollment obtains the Business Account epoch from your server; recovery never merges raw SQLite files.</Text>
        <Text style={styles.label}>Server URL</Text><TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder="https://sync.example.com" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Text style={styles.label}>Account or user ID</Text><TextInput value={userId} onChangeText={setUserId} autoCapitalize="none" placeholder="you@example.com" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Text style={styles.label}>OIDC issuer</Text><TextInput value={oidcIssuer} onChangeText={setOidcIssuer} autoCapitalize="none" keyboardType="url" placeholder="https://identity.example.com/realms/ledgr" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Text style={styles.label}>OIDC client ID</Text><TextInput value={oidcClientId} onChangeText={setOidcClientId} autoCapitalize="none" placeholder="ledgr-mobile" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Text style={styles.label}>OIDC scopes</Text><TextInput value={oidcScopes} onChangeText={setOidcScopes} autoCapitalize="none" placeholder="openid profile offline_access" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Pressable disabled={busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()} onPress={enrollOidc} style={[styles.primary, (busy || !serverUrl.trim() || !userId.trim() || !oidcIssuer.trim() || !oidcClientId.trim()) && styles.disabled]}><Text style={styles.primaryText}>{busy ? 'Working…' : 'Sign in with OIDC and enroll'}</Text></Pressable>
        <Text style={styles.hint}>The app uses Authorization Code + PKCE and securely rotates refresh tokens. Configure the redirect URI ledgr://sync-oidc in your identity provider.</Text>
        <Text style={styles.label}>Manual access token (development fallback)</Text><TextInput value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry placeholder="Stored only in SecureStore" placeholderTextColor={theme.color.muted} style={styles.input} />
        <Pressable disabled={busy || !serverUrl.trim() || !userId.trim() || !token.trim()} onPress={enroll} style={[styles.secondary, (busy || !serverUrl.trim() || !userId.trim() || !token.trim()) && styles.disabled]}><Text style={styles.secondaryText}>{status?.configured ? 'Update token and re-enroll' : 'Enroll with manual token'}</Text></Pressable>
        {status?.configured ? <View style={styles.status}><Text style={styles.statusTitle}>{status.bootstrapRequired ? 'Bootstrap snapshot required' : status.recoveryRequired ? 'Recovery required' : status.enabled ? 'Sync enabled' : 'Sync disabled'}</Text><Text style={styles.hint}>{status.pending} pending · {status.conflicts} conflicts · cursor {status.cursor ?? 0}</Text>{status.bookEpoch ? <Text style={styles.mono}>Epoch {status.bookEpoch}</Text> : null}{status.lastSyncAt ? <Text style={styles.hint}>Last successful sync {new Date(status.lastSyncAt).toLocaleString()}</Text> : null}{status.lastSyncAttemptAt ? <Text style={styles.hint}>Last sync attempt {new Date(status.lastSyncAttemptAt).toLocaleString()}</Text> : null}{status.lastSyncError ? <Text style={styles.error}>Last sync error: {status.lastSyncError}</Text> : null}{status.lastVerifiedAt ? <Text style={styles.hint}>Checkpoint verified {new Date(status.lastVerifiedAt).toLocaleString()}</Text> : null}{status.lastError ? <Text style={styles.error}>{status.lastError}</Text> : null}<View style={styles.row}><Pressable disabled={busy || !status.enabled} onPress={sync} style={styles.secondary}><Text style={styles.secondaryText}>Sync now</Text></Pressable><Pressable disabled={busy || !status.enabled || !status.retryable} onPress={retry} style={styles.secondary}><Text style={styles.secondaryText}>Retry now</Text></Pressable><Pressable disabled={busy || !status.enabled} onPress={verify} style={styles.secondary}><Text style={styles.secondaryText}>Verify</Text></Pressable><Pressable disabled={busy || (!status.enabled && !status.bootstrapRequired)} onPress={publish} style={styles.secondary}><Text style={styles.secondaryText}>{status.bootstrapRequired ? 'Publish initial snapshot' : 'Publish snapshot'}</Text></Pressable>{status.recoveryRequired && !status.bootstrapRequired ? <><Pressable disabled={busy} onPress={() => router.push('/advanced-settings' as any)} style={styles.secondary}><Text style={styles.secondaryText}>Export backup first</Text></Pressable><Pressable disabled={busy} onPress={installSnapshot} style={styles.secondary}><Text style={styles.secondaryText}>Restore server snapshot</Text></Pressable><Pressable disabled={busy} onPress={advanceEpoch} style={styles.secondary}><Text style={styles.secondaryText}>Replace shared epoch</Text></Pressable></> : null}{!status.enabled && !status.recoveryRequired ? <Pressable disabled={busy} onPress={enable} style={styles.secondary}><Text style={styles.secondaryText}>Enable</Text></Pressable> : <Pressable disabled={busy || !status.enabled} onPress={disable} style={styles.secondary}><Text style={styles.secondaryText}>Disable</Text></Pressable>}</View></View> : null}
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </View>
      {status?.configured ? <View style={styles.card}><Text style={styles.title}>Enrolled devices</Text><Text style={styles.hint}>Revocation and enrollment expiry are enforced by the server. Revoking this device also clears its local credentials.</Text>{devices.length ? devices.map((device) => <View key={device.deviceId} style={styles.device}><View style={{ flex: 1 }}><Text style={styles.deviceTitle}>{device.current ? 'This device' : `Device ${device.deviceId.slice(0, 12)}…`}</Text><Text style={styles.hint}>{device.revokedAt ? 'Revoked' : device.lastSeenAt ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}` : 'Enrolled'}{device.expiresAt && !device.revokedAt ? ` · expires ${new Date(device.expiresAt).toLocaleDateString()}` : ''}</Text></View>{!device.revokedAt ? <Pressable disabled={busy} onPress={() => revoke(device)} style={styles.revoke}><Text style={styles.revokeText}>Revoke</Text></Pressable> : null}</View>) : <Text style={styles.hint}>Device list is unavailable or empty.</Text>}</View> : null}
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (theme: any) => StyleSheet.create({ container: { flex: 1, backgroundColor: theme.color.surface }, header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: theme.spacing.lg, paddingTop: 16 }, scroll: { padding: theme.spacing.lg, paddingBottom: 40, gap: 14 }, card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 18, gap: 8 }, title: { color: theme.color.onSurface, fontSize: 18, fontWeight: '700' }, hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 }, mono: { color: theme.color.muted, fontSize: 11 }, label: { color: theme.color.onSurface, fontSize: 13, fontWeight: '600', marginTop: 12 }, input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 }, primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 16 }, primaryText: { color: theme.color.onBrandPrimary, fontWeight: '700' }, disabled: { opacity: 0.45 }, status: { borderTopColor: theme.color.border, borderTopWidth: 1, marginTop: 18, paddingTop: 14, gap: 6 }, statusTitle: { color: theme.color.brandPrimary, fontWeight: '700' }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }, secondary: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10 }, secondaryText: { color: theme.color.onSurface, fontWeight: '600' }, error: { color: theme.color.danger || '#c53b3b', fontSize: 12 }, message: { color: theme.color.muted, fontSize: 13, marginTop: 10 }, device: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 12, marginTop: 8 }, deviceTitle: { color: theme.color.onSurface, fontWeight: '600' }, adminLink: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 15 }, adminLinkTitle: { color: theme.color.onSurface, fontWeight: '800' }, revoke: { padding: 10 }, revokeText: { color: theme.color.danger || '#c53b3b', fontWeight: '700' } });
