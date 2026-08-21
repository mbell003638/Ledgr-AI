import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { ScreenHeader, Card } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { SyncQrCode } from '@/src/components/SyncQrCode';
import type { LedgrSyncQrInvite } from '@/src/sync/qrEnrollment';

type Device = { deviceId: string; subject?: string; enrolledAt?: string; expiresAt?: string; lastSeenAt?: string; revokedAt?: string | null; current?: boolean; displayName?: string; platform?: string };
type Membership = { bookId: string; subject: string; role: 'owner' | 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor'; locationIds: string[]; updatedAt: string };
type Location = { id: string; name: string };
const ROLES: Membership['role'][] = ['admin', 'accountant', 'editor', 'viewer', 'auditor'];

function date(value?: string): string { return value ? new Date(value).toLocaleString() : 'Not available'; }

export default function SyncAdminScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState<Membership['role']>('editor');
  const [names, setNames] = useState<Record<string, string>>({});
  const [locationDraft, setLocationDraft] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState('');
  const [codeRole, setCodeRole] = useState<Membership['role']>('viewer');
  const [codeLocations, setCodeLocations] = useState<string[]>([]);
  const [generatedCode, setGeneratedCode] = useState<{ code: string; bookId: string; expiresAt: string; role: string; locationIds: string[] } | null>(null);
  const [qrInvite, setQrInvite] = useState<Omit<LedgrSyncQrInvite, 'kind' | 'version'> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setMessage('');
    try {
      const [nextDevices, nextMembers, nextLocations] = await Promise.all([api.listSyncDevices(), api.listSyncMemberships(), api.listLocations()]);
      setDevices(nextDevices as Device[]);
      setMembers(nextMembers as Membership[]);
      setLocations((nextLocations as any[]).map((item) => ({ id: String(item.id), name: String(item.name || item.label || item.id) })));
      setNames(Object.fromEntries((nextDevices as Device[]).map((item) => [item.deviceId, item.displayName || (item.current ? 'This device' : `Device ${item.deviceId.slice(0, 12)}…`)])));
      setLocationDraft(Object.fromEntries((nextMembers as Membership[]).map((item) => [item.subject, item.locationIds])));
    } catch (error: any) { setMessage(error?.message || 'Administration data is unavailable. Confirm that this account has administrator access.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true); setMessage('');
    try { await action(); setMessage(success); await load(); }
    catch (error: any) { setMessage(error?.message || 'The administration change could not be saved.'); }
    finally { setBusy(false); }
  };

  const saveDeviceName = (device: Device) => run(async () => { await api.renameSyncDevice(device.deviceId, names[device.deviceId] || 'Unnamed device', device.platform); }, 'Device name saved.');
  const revoke = (device: Device) => Alert.alert('Revoke device?', device.current ? 'This device will lose sync access and must be re-enrolled.' : `Revoke ${names[device.deviceId] || device.deviceId}?`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Revoke', style: 'destructive', onPress: () => void run(() => api.revokeSyncDevice(device.deviceId), 'Device revoked.') }]);
  const saveMember = () => run(async () => { const member = await api.upsertSyncMembership(subject.trim(), role); if (locationDraft[subject.trim()]?.length) await api.setSyncMembershipLocations(subject.trim(), locationDraft[subject.trim()]); void member; setSubject(''); }, 'Member role saved.');
  const createCode = async () => { setBusy(true); setMessage(''); try { const result = await api.createSyncEnrollmentCode(codeRole as Exclude<Membership['role'], 'owner'>, codeLocations, 15); const sync = await api.getSyncStatus(); if (!sync.serverUrl) throw new Error('Configure the private sync server address before creating a QR invitation.'); setGeneratedCode(result); setQrInvite({ serverUrl: sync.serverUrl, bookId: result.bookId, code: result.code, role: result.role, locationIds: result.locationIds, expiresAt: result.expiresAt, ...(sync.oidcIssuer ? { oidcIssuer: sync.oidcIssuer } : {}), ...(sync.oidcClientId ? { oidcClientId: sync.oidcClientId } : {}), ...(sync.oidcScopes ? { oidcScopes: sync.oidcScopes } : {}) }); setMessage('QR invitation created. Show it only to the intended person; it expires in 15 minutes and can be used once.'); } catch (error: any) { setMessage(error?.message || 'Could not create a one-time enrollment code.'); } finally { setBusy(false); } };
  const toggleCodeLocation = (locationId: string) => setCodeLocations((current) => current.includes(locationId) ? current.filter((id) => id !== locationId) : [...current, locationId]);
  const toggleLocation = (member: Membership, locationId: string) => {
    const current = locationDraft[member.subject] || [];
    setLocationDraft((draft) => ({ ...draft, [member.subject]: current.includes(locationId) ? current.filter((id) => id !== locationId) : [...current, locationId] }));
  };
  const saveLocations = (member: Membership) => run(() => api.setSyncMembershipLocations(member.subject, locationDraft[member.subject] || []), 'Location access saved.');
  const removeMember = (member: Membership) => Alert.alert('Remove member?', `${member.subject} will lose access to this Business Account.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void run(() => api.removeSyncMembership(member.subject), 'Member removed.') }]);

  return <SafeAreaView style={styles.container} edges={['top']}>
    <ScreenHeader title="Sync Administration" subtitle="Devices, access roles, and location scopes" leftAction={<Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>} />
    <ScrollView contentContainerStyle={styles.scroll}>
      <Card style={styles.info}><Ionicons name="shield-checkmark-outline" size={22} color={theme.color.brandPrimary} /><Text style={styles.infoText}>These controls apply to the user-owned sync server. UI visibility never replaces server-side authorization; revoked devices and role restrictions are enforced by the server.</Text></Card>
      <View style={styles.section}><Text style={styles.sectionTitle}>Enrolled devices</Text><Text style={styles.hint}>Rename devices so registers and phones are recognizable. Revocation preserves accounting history and blocks future pull/push access.</Text>
        {devices.map((device) => <View key={device.deviceId} style={styles.row}><View style={styles.rowMain}><TextInput value={names[device.deviceId] || ''} onChangeText={(value) => setNames((current) => ({ ...current, [device.deviceId]: value }))} editable={!device.revokedAt} placeholder="Device name" placeholderTextColor={theme.color.muted} style={styles.input} /><Text style={styles.meta}>{device.current ? 'This device' : device.subject || 'Assigned user'} · {device.platform || 'platform not reported'} · {device.revokedAt ? 'Revoked' : `Last seen ${date(device.lastSeenAt)}`}</Text><Text style={styles.meta}>Enrolled {date(device.enrolledAt)} · expires {date(device.expiresAt)}</Text></View><View style={styles.actions}>{!device.revokedAt ? <><Pressable disabled={busy} onPress={() => saveDeviceName(device)} style={styles.smallButton}><Text style={styles.smallButtonText}>Save name</Text></Pressable><Pressable disabled={busy} onPress={() => revoke(device)} style={styles.dangerButton}><Text style={styles.dangerText}>Revoke</Text></Pressable></> : null}</View></View>)}
                {!devices.length ? <Text style={styles.hint}>No enrolled devices are available.</Text> : null}
      </View>
      <View style={styles.section}><Text style={styles.sectionTitle}>Invite another device</Text><Text style={styles.hint}>Choose what this phone, browser, POS tablet, or warehouse device may do. Ledgr will create a QR invitation that expires automatically and works once.</Text><View style={styles.roleRow}>{ROLES.map((item) => <Pressable key={item} onPress={() => setCodeRole(item)} style={[styles.roleChip, codeRole === item && styles.roleChipActive]}><Text style={[styles.roleText, codeRole === item && styles.roleTextActive]}>{item}</Text></Pressable>)}</View><Text style={styles.scopeLabel}>Initial location scope</Text><View style={styles.roleRow}>{locations.map((location) => <Pressable key={location.id} onPress={() => toggleCodeLocation(location.id)} style={[styles.roleChip, codeLocations.includes(location.id) && styles.roleChipActive]}><Text style={[styles.roleText, codeLocations.includes(location.id) && styles.roleTextActive]}>{location.name}</Text></Pressable>)}</View><Pressable testID="create-qr-invitation" disabled={busy} onPress={() => void createCode()} style={[styles.primaryButton, busy && styles.disabled]}><Ionicons name="qr-code-outline" size={19} color={theme.color.onBrandPrimary} /><Text style={styles.primaryText}>Create QR invitation</Text></Pressable>{generatedCode ? <View style={styles.generated}><Text style={styles.generatedLabel}>Invitation code behind the QR</Text><Text selectable style={styles.generatedCode}>{generatedCode.code}</Text><Text style={styles.meta}>Expires {date(generatedCode.expiresAt)} · {generatedCode.role} · {generatedCode.locationIds.length} location scope(s)</Text></View> : null}</View>
      {qrInvite ? <View style={styles.section}><Text style={styles.sectionTitle}>Scan to join this business</Text><Text style={styles.hint}>The QR contains the short-lived invitation and server address. It never contains this administrator’s access token.</Text><View style={styles.qrWrap}><SyncQrCode invite={qrInvite} /><Text style={styles.meta}>Expires {date(qrInvite.expiresAt)} · {qrInvite.role} · {qrInvite.locationIds.length} location scope(s)</Text></View><Pressable onPress={() => setQrInvite(null)} style={styles.secondaryButton}><Text style={styles.secondaryText}>Hide QR invitation</Text></Pressable></View> : null}
      <View style={styles.section}><Text style={styles.sectionTitle}>Business access</Text>
<Text style={styles.hint}>Assign the minimum role required. Location scopes are separate from identity and role, so a shop manager can be limited to selected shops.</Text>
        <View style={styles.addMember}><TextInput value={subject} onChangeText={setSubject} autoCapitalize="none" placeholder="user@example.com" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} /><View style={styles.roleRow}>{ROLES.map((item) => <Pressable key={item} onPress={() => setRole(item)} style={[styles.roleChip, role === item && styles.roleChipActive]}><Text style={[styles.roleText, role === item && styles.roleTextActive]}>{item}</Text></Pressable>)}</View><Pressable disabled={busy || !subject.trim()} onPress={saveMember} style={[styles.primaryButton, (!subject.trim() || busy) && styles.disabled]}><Text style={styles.primaryText}>Assign role</Text></Pressable></View>
        {members.map((member) => <View key={member.subject} style={styles.member}><View style={styles.memberHeader}><View style={{ flex: 1 }}><Text style={styles.memberTitle}>{member.subject}</Text><Text style={styles.meta}>Role: {member.role} · updated {date(member.updatedAt)}</Text></View>{member.role !== 'owner' ? <Pressable disabled={busy} onPress={() => removeMember(member)}><Text style={styles.dangerText}>Remove</Text></Pressable> : <Text style={styles.owner}>Owner</Text>}</View><Text style={styles.scopeLabel}>Location access</Text><View style={styles.roleRow}>{locations.map((location) => { const selected = (locationDraft[member.subject] || []).includes(location.id); return <Pressable key={location.id} onPress={() => toggleLocation(member, location.id)} style={[styles.roleChip, selected && styles.roleChipActive]}><Text style={[styles.roleText, selected && styles.roleTextActive]}>{location.name}</Text></Pressable>; })}</View>{!locations.length ? <Text style={styles.hint}>No synced location directory is configured; this member has no explicit location scope.</Text> : <Pressable disabled={busy} onPress={() => saveLocations(member)} style={styles.secondaryButton}><Text style={styles.secondaryText}>Save location scope</Text></Pressable>}</View>)}
        {!members.length ? <Text style={styles.hint}>No members returned. The server may require initial membership provisioning by the deployment owner.</Text> : null}
      </View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (theme: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface }, scroll: { padding: theme.spacing.lg, gap: 14, paddingBottom: 48 }, info: { flexDirection: 'row', gap: 10, padding: 14, alignItems: 'flex-start' }, infoText: { flex: 1, color: theme.color.muted, fontSize: 13, lineHeight: 19 }, section: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 10 }, sectionTitle: { color: theme.color.onSurface, fontWeight: '800', fontSize: 18 }, hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 }, row: { borderTopColor: theme.color.border, borderTopWidth: 1, paddingTop: 12, marginTop: 4, gap: 8 }, rowMain: { gap: 4 }, input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 11, paddingVertical: 10 }, meta: { color: theme.color.muted, fontSize: 11 }, actions: { flexDirection: 'row', gap: 8 }, smallButton: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 11, paddingVertical: 9 }, smallButtonText: { color: theme.color.onSurface, fontWeight: '700', fontSize: 12 }, dangerButton: { borderColor: `${theme.color.danger || '#c53b3b'}66`, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 11, paddingVertical: 9 }, dangerText: { color: theme.color.danger || '#c53b3b', fontWeight: '700', fontSize: 12 }, addMember: { gap: 9 }, roleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, roleChip: { borderColor: theme.color.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 8 }, roleChipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary }, roleText: { color: theme.color.onSurface, fontSize: 12, fontWeight: '600' }, roleTextActive: { color: theme.color.onBrandPrimary }, primaryButton: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 7 }, primaryText: { color: theme.color.onBrandPrimary, fontWeight: '800' }, disabled: { opacity: 0.45 }, member: { borderTopColor: theme.color.border, borderTopWidth: 1, paddingTop: 13, marginTop: 3, gap: 8 }, memberHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 }, memberTitle: { color: theme.color.onSurface, fontWeight: '800' }, owner: { color: theme.color.brandPrimary, fontWeight: '800', fontSize: 12 }, scopeLabel: { color: theme.color.onSurface, fontWeight: '700', fontSize: 12 }, secondaryButton: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 10, alignItems: 'center' }, secondaryText: { color: theme.color.onSurface, fontWeight: '700' }, generated: { backgroundColor: theme.color.surface, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, padding: 14, gap: 5 }, qrWrap: { alignItems: 'center', gap: 8, paddingVertical: 8 }, generatedLabel: { color: theme.color.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }, generatedCode: { color: theme.color.brandPrimary, fontSize: 22, fontWeight: '900', letterSpacing: 1.2 }, message: { color: theme.color.muted, fontSize: 13, lineHeight: 19 },
});
