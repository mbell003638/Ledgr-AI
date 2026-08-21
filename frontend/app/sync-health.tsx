import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { ScreenHeader, Card } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';

type LocalStatus = { configured?: boolean; enabled?: boolean; pending?: number; retryable?: number; conflicts?: number; lastSyncAt?: string; lastSyncAttemptAt?: string; lastSyncError?: string; lastError?: string; cursor?: number; serverUrl?: string };
type HealthResult = { local: LocalStatus; server: any };

const stamp = (value?: string) => value ? new Date(value).toLocaleString() : 'Not available';
const statusColor = (value: string | undefined, theme: any) => value === 'healthy' || value === 'ready' ? theme.color.success || theme.color.brandPrimary : value === 'degraded' || value === 'unknown' ? theme.color.warning || '#B7791F' : theme.color.muted;

export default function SyncHealthScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [server, setServer] = useState<any>(null);
  const [operationsToken, setOperationsToken] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadLocal = useCallback(async () => {
    try { setLocal(await api.getSyncStatus() as LocalStatus); } catch (error: any) { setMessage(error?.message || 'Local sync status is unavailable.'); }
  }, []);
  useEffect(() => { void loadLocal(); }, [loadLocal]);

  const checkServer = async () => {
    if (!operationsToken.trim()) { setMessage('Enter the operations token for this request. It is never stored by the app.'); return; }
    setBusy(true); setMessage('');
    try { const result = await api.getServerHealth(operationsToken); setLocal(result.local as LocalStatus); setServer((result as HealthResult).server); setOperationsToken(''); }
    catch (error: any) { setMessage(error?.message || 'Protected server health could not be retrieved.'); }
    finally { setBusy(false); }
  };
  const queueCount = Number(local?.pending || 0) + Number(local?.retryable || 0);
  const serverStatus = server?.status || 'not checked';

  return <SafeAreaView style={styles.container} edges={['top']}>
    <ScreenHeader title="Sync Health" subtitle="Local queue and private-server diagnostics" leftAction={<Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>} />
    <ScrollView contentContainerStyle={styles.scroll}>
      <Card style={styles.explainer}><Ionicons name="pulse-outline" size={22} color={theme.color.brandPrimary} /><Text style={styles.hint}>Local health is available offline. Server diagnostics are protected separately from sync access and require the deployment operations token for one request; the token is cleared immediately afterward.</Text></Card>
      <View style={styles.section}><Text style={styles.sectionTitle}>Local sync status</Text><View style={styles.metricGrid}><Metric label="Connection" value={local?.enabled ? 'Enabled' : local?.configured ? 'Configured' : 'Local-only'} color={local?.enabled ? theme.color.success : theme.color.brandPrimary} styles={styles} /><Metric label="Queue" value={`${queueCount} pending`} color={queueCount ? theme.color.warning || '#B7791F' : theme.color.success} styles={styles} /><Metric label="Conflicts" value={String(local?.conflicts || 0)} color={local?.conflicts ? theme.color.error : theme.color.success} styles={styles} /><Metric label="Cursor" value={String(local?.cursor || 0)} color={theme.color.onSurface} styles={styles} /></View><Text style={styles.hint}>Last successful sync: {stamp(local?.lastSyncAt)}</Text><Text style={styles.hint}>Last attempt: {stamp(local?.lastSyncAttemptAt)}</Text>{local?.lastSyncError || local?.lastError ? <Text style={styles.error}>Last error: {local.lastSyncError || local.lastError}</Text> : <Text style={styles.success}>No recorded sync error.</Text>}</View>
      <View style={styles.section}><Text style={styles.sectionTitle}>Protected server diagnostics</Text><Text style={styles.hint}>The operations token is intentionally not persisted in AsyncStorage, SecureStore, or the sync profile.</Text><TextInput value={operationsToken} onChangeText={setOperationsToken} secureTextEntry autoCapitalize="none" placeholder="Operations token" placeholderTextColor={theme.color.muted} style={styles.input} /><View style={styles.buttonRow}><Pressable disabled={busy} onPress={() => void loadLocal()} style={styles.secondary}><Text style={styles.secondaryText}>Refresh local</Text></Pressable><Pressable testID="check-server-health" disabled={busy} onPress={() => void checkServer()} style={styles.primary}><Text style={styles.primaryText}>{busy ? 'Checking…' : 'Check server health'}</Text></Pressable></View>{server ? <><StatusLine label="Overall" value={serverStatus} color={statusColor(serverStatus, theme)} styles={styles} /><StatusLine label="Liveness" value={server.liveness?.status} color={statusColor(server.liveness?.status, theme)} styles={styles} /><StatusLine label="Readiness" value={server.readiness?.status} color={statusColor(server.readiness?.status, theme)} styles={styles} /><StatusLine label="Database" value={server.dependencies?.database?.status} color={statusColor(server.dependencies?.database?.status, theme)} styles={styles} /><StatusLine label="Identity provider" value={server.dependencies?.identity?.status} color={statusColor(server.dependencies?.identity?.status, theme)} styles={styles} /><StatusLine label="Backup health" value={server.dependencies?.backup?.status} color={statusColor(server.dependencies?.backup?.status, theme)} styles={styles} />{server.dependencies?.backup?.lastSuccessAt ? <Text style={styles.hint}>Last server backup: {stamp(server.dependencies.backup.lastSuccessAt)}</Text> : null}</> : <Text style={styles.hint}>No protected server check has been run in this session.</Text>}</View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
  </SafeAreaView>;
}

function Metric({ label, value, color, styles }: { label: string; value: string; color: string; styles: any }) { return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={[styles.metricValue, { color }]}>{value}</Text></View>; }
function StatusLine({ label, value, color, styles }: { label: string; value?: string; color: string; styles: any }) { return <View style={styles.statusLine}><Text style={styles.hint}>{label}</Text><Text style={[styles.statusValue, { color }]}>{value || 'unknown'}</Text></View>; }
const makeStyles = (theme: any) => StyleSheet.create({ container: { flex: 1, backgroundColor: theme.color.surface }, scroll: { padding: theme.spacing.lg, gap: 14, paddingBottom: 48 }, explainer: { flexDirection: 'row', gap: 10, padding: 14, alignItems: 'flex-start' }, hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 }, section: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 9 }, sectionTitle: { color: theme.color.onSurface, fontWeight: '800', fontSize: 18 }, metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { flexGrow: 1, minWidth: '45%', borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12 }, metricLabel: { color: theme.color.muted, fontSize: 11, fontWeight: '700' }, metricValue: { fontSize: 15, fontWeight: '800', marginTop: 4 }, input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 11, paddingVertical: 11 }, buttonRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' }, primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 11 }, primaryText: { color: theme.color.onBrandPrimary, fontWeight: '800' }, secondary: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 11 }, secondaryText: { color: theme.color.onSurface, fontWeight: '700' }, statusLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopColor: theme.color.border, borderTopWidth: 1, paddingTop: 9, marginTop: 2 }, statusValue: { fontWeight: '800', fontSize: 12 }, success: { color: theme.color.success || theme.color.brandPrimary, fontSize: 13, fontWeight: '700' }, error: { color: theme.color.danger || '#c53b3b', fontSize: 13, lineHeight: 19 }, message: { color: theme.color.muted, fontSize: 13 }, });
