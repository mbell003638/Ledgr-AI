import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import type { ConflictResolutionType, SyncConflict } from '@/src/sync/conflicts';

export default function SyncConflictsScreen() {
  const theme = useTheme(); const styles = useMemo(() => makeStyles(theme), [theme]);
  const [items, setItems] = useState<SyncConflict[]>([]); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async (refresh = false) => { if (refresh) setRefreshing(true); else setLoading(true); try { setItems(await api.listSyncConflicts()); } finally { setLoading(false); setRefreshing(false); } }, []);
  useEffect(() => { void load(); }, [load]);
  const resolve = (item: SyncConflict, type: ConflictResolutionType) => {
    const label = type === 'keep_canonical' ? 'Keep canonical' : type === 'merge' ? 'Apply safe merge' : 'Apply audited correction';
    const detail = type === 'keep_canonical'
      ? 'The retained local intent will be superseded. Canonical snapshot recovery will remove the rejected local effect before sync resumes.'
      : type === 'merge' ? 'Only disjoint fields will be combined in a new dependent operation, then canonical recovery will replay it.' : 'A new dependent accounting operation will be created. Existing journal history will not be edited.';
    Alert.alert(label, detail, [{ text: 'Cancel', style: 'cancel' }, { text: label, onPress: async () => { setBusy(item.conflictId); try { await api.resolveSyncConflict(item.conflictId, type); await load(true); } catch (error: any) { Alert.alert('Resolution failed', error?.message || 'The conflict remains open.'); } finally { setBusy(null); } } }]);
  };
  return <SafeAreaView style={styles.container} edges={['top']}><ScreenHeader title="Conflict Inbox" subtitle={`${items.length} open item${items.length === 1 ? '' : 's'}`} leftAction={<Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>} />
    {loading ? <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /> : <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.color.brandPrimary} />}>
      {items.length === 0 ? <Card style={styles.card}><Ionicons name="checkmark-circle-outline" size={34} color={theme.color.success} /><Text style={styles.emptyTitle}>No open conflicts</Text><Text style={styles.body}>Conflicting intent remains in the audit trail and is never silently overwritten.</Text></Card> : items.map((item) => <Card key={item.conflictId} style={styles.card}>
        <View style={styles.row}><Ionicons name="warning-outline" size={22} color={theme.color.warning || theme.color.brandPrimary} /><View style={{ flex: 1 }}><Text style={styles.title}>{item.reason}</Text><Text style={styles.meta}>{item.commandType || 'operation'} · {item.opId.slice(0, 12)}… · {new Date(item.createdAt).toLocaleString()}</Text></View></View>
        <Text style={styles.body}>Local and canonical intent are retained. Choose an explicit audited outcome.</Text>
        <Text style={styles.meta}>Aggregate: {item.aggregateId || 'n/a'} · business date: {item.businessDate || 'n/a'} · base/canonical revision: {item.baseRevision ?? 'n/a'} / {item.canonicalRevision ?? 'n/a'}</Text>
        <Text style={styles.meta}>Actor: {item.actorId || 'n/a'} · device: {item.deviceId ? `${item.deviceId.slice(0, 16)}…` : 'n/a'}</Text>
        <Text style={styles.evidence}>Local: {JSON.stringify(item.localPayload)?.slice(0, 600) || 'n/a'}</Text>
        <Text style={styles.evidence}>Canonical: {JSON.stringify(item.canonicalPayload)?.slice(0, 600) || 'n/a'}</Text>
        <View style={styles.actions}><Pressable disabled={busy === item.conflictId} onPress={() => resolve(item, 'keep_canonical')} style={styles.action}><Text style={styles.actionText}>Keep canonical</Text></Pressable>{item.hasRetainedLocalOperation ? <Pressable disabled={busy === item.conflictId} onPress={() => router.push({ pathname: '/sync-conflict-correction', params: { conflictId: item.conflictId, operationId: item.opId } } as any)} style={styles.action}><Text style={styles.actionText}>Audited correction</Text></Pressable> : null}{item.mergePermitted ? <Pressable disabled={busy === item.conflictId} onPress={() => resolve(item, 'merge')} style={styles.action}><Text style={styles.actionText}>Safe merge</Text></Pressable> : null}</View>
      </Card>)}<View style={{ height: 90 }} />
    </ScrollView>}
  </SafeAreaView>;
}
function makeStyles(theme: any) { return StyleSheet.create({ container: { flex: 1, backgroundColor: theme.color.surface }, scroll: { padding: 18, paddingBottom: 60, gap: 14 }, card: { padding: 18 }, row: { flexDirection: 'row', alignItems: 'center', gap: 10 }, title: { color: theme.color.onSurface, fontSize: 15, fontWeight: '700' }, meta: { color: theme.color.muted, fontSize: 11, marginTop: 5 }, evidence: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 8, fontFamily: 'monospace' }, body: { color: theme.color.muted, fontSize: 13, lineHeight: 19, marginTop: 12 }, emptyTitle: { color: theme.color.onSurface, fontSize: 17, fontWeight: '700', marginTop: 12 }, actions: { marginTop: 16, gap: 8 }, action: { borderWidth: 1, borderColor: theme.color.brandPrimary, borderRadius: theme.radius.md, padding: 11, alignItems: 'center' }, actionText: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: '700' } }); }
