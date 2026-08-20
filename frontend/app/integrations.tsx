import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScreenHeader, Card } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { showAlert } from '@/src/utils/alerts';

function parseCsv(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((value) => value.trim().toLowerCase());
  const indexOf = (...names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const idIndex = indexOf('id', 'external_id', 'transaction_id', 'reference');
  const dateIndex = indexOf('date', 'transaction_date');
  const amountIndex = indexOf('amount', 'value', 'total');
  const currencyIndex = indexOf('currency', 'ccy');
  const descriptionIndex = indexOf('description', 'memo', 'narration', 'details');
  if (dateIndex < 0 || amountIndex < 0) throw new Error('CSV must include date and amount columns.');
  return lines.slice(1).map((line, rowIndex) => {
    const values = line.split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
    const externalId = values[idIndex] || `row-${rowIndex + 1}-${values[dateIndex]}-${values[amountIndex]}`;
    return { externalId, date: values[dateIndex], amount: Number(values[amountIndex]), currency: values[currencyIndex] || 'USD', description: values[descriptionIndex] || '', rawMetadata: { importedFrom: 'csv' } };
  }).filter((row) => row.date && Number.isFinite(row.amount));
}

export default function IntegrationsScreen() {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [integrations, setIntegrations] = useState<any[]>([]);
  const [syncState, setSyncState] = useState<any>(null);
  const [syncUrl, setSyncUrl] = useState('');
  const [syncWorkspace, setSyncWorkspace] = useState('');
  const [syncToken, setSyncToken] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [feedRows, queueRows, configured, selfHosted] = await Promise.all([
        api.listBankFeedEntries(), api.listPendingSync(), api.listIntegrations(), api.getSelfHostedSyncState().catch(() => null),
      ]);
      setFeed(feedRows as any[]); setPending(queueRows as any[]); setIntegrations(configured as any[]); setSyncState(selfHosted);
      if (selfHosted) { setSyncUrl((current) => current || selfHosted.baseUrl || ''); setSyncWorkspace((current) => current || selfHosted.workspaceId || ''); }
    } catch { /* the screen remains usable when no SQLite book is active */ }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const configureCsv = async () => {
    setBusy(true);
    try {
      await api.upsertIntegration({ provider: 'csv', kind: 'bank_feed', displayName: 'Local CSV bank feed', enabled: true, config: { mode: 'device_file', reviewBeforePost: true } });
      await api.enqueueSync({ provider: 'csv', kind: 'bank_feed_import', idempotencyKey: `csv:configured:${new Date().toISOString().slice(0, 10)}`, payload: { mode: 'device_file' } });
      await load();
      showAlert('Configured', 'CSV imports stay on this device and enter review before any ledger posting.');
    } catch (error: any) { showAlert('Could not configure', error?.message || 'Please try again.'); } finally { setBusy(false); }
  };

  const configureSelfHosted = async () => {
    if (!syncUrl.trim()) return showAlert('Server URL required', 'Enter the address of your user-owned sync server.');
    setSyncBusy(true);
    try {
      const next = await api.configureSelfHostedSync({ baseUrl: syncUrl, workspaceId: syncWorkspace, token: syncToken || undefined, enabled: true, autoSync: false });
      setSyncState(next); setSyncToken('');
      showAlert('Self-host sync saved', 'Your book remains local-first. Use Push local or Pull remote when you choose.');
    } catch (error: any) { showAlert('Could not save sync settings', error?.message || 'Please check the URL and try again.'); } finally { setSyncBusy(false); }
  };

  const testSelfHosted = async () => {
    setSyncBusy(true);
    try { await api.testSelfHostedSyncConnection(); showAlert('Connection successful', 'The self-host sync server responded correctly.'); }
    catch (error: any) { showAlert('Connection failed', error?.message || 'The self-host sync server could not be reached.'); }
    finally { setSyncBusy(false); }
  };

  const runSelfHosted = async (action: 'push' | 'pull' | 'sync') => {
    setSyncBusy(true);
    try {
      const next = action === 'push' ? await api.pushSelfHostedSnapshot() : action === 'pull' ? await api.pullSelfHostedSnapshot() : await api.syncSelfHostedNow();
      setSyncState(next); await load();
      showAlert('Sync complete', `This device is synchronized at ${new Date(next.lastSyncAt || Date.now()).toLocaleString()}.`);
    } catch (error: any) { await load(); showAlert(error?.status === 409 ? 'Sync conflict' : 'Sync unavailable', error?.message || 'The local book remains safe on this device.'); }
    finally { setSyncBusy(false); }
  };

  const resolveSelfHosted = async (strategy: 'push_local' | 'use_remote') => {
    setSyncBusy(true);
    try { const next = await api.resolveSelfHostedConflict(strategy); setSyncState(next); await load(); showAlert('Conflict resolved', strategy === 'push_local' ? 'The local copy replaced the remote snapshot.' : 'The remote snapshot replaced this local book.'); }
    catch (error: any) { showAlert('Conflict was not resolved', error?.message || 'Choose an option and try again.'); }
    finally { setSyncBusy(false); }
  };

  const disableSelfHosted = async () => {
    setSyncBusy(true);
    try { await api.disableSelfHostedSync(); await load(); showAlert('Self-host sync disabled', 'Your local book remains available and no remote requests will be made.'); }
    catch (error: any) { showAlert('Could not disable sync', error?.message || 'Please try again.'); }
    finally { setSyncBusy(false); }
  };

  const importCsv = async () => {
    setBusy(true);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const FileSystem = await import('expo-file-system');
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel'], copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const file = new FileSystem.File(result.assets[0].uri);
      const rows = parseCsv(file.textSync());
      const imported = await api.importBankFeedRows('csv', rows);
      await api.enqueueSync({ provider: 'csv', kind: 'bank_feed_import', idempotencyKey: `csv:${result.assets[0].name}:${result.assets[0].size || rows.length}`, payload: { filename: result.assets[0].name, rowCount: rows.length } });
      await load();
      showAlert('Imported for review', `${imported.inserted} new bank-feed row(s) were staged. Nothing was posted automatically.`);
    } catch (error: any) { showAlert('Import failed', error?.message || 'The selected CSV could not be read.'); } finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.surface }}>
      <ScreenHeader title="Integrations" subtitle="Direct-to-device imports and optional online connectors" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 36 }}>
        <Card style={{ padding: 16, marginBottom: 14 }}>
          <Text style={{ color: theme.color.brandPrimary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 }}>User-side by design</Text>
          <Text style={{ color: theme.color.onSurface, fontSize: 20, fontWeight: '800', marginTop: 6 }}>Connect without a Ledgr server</Text>
          <Text style={{ color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 6 }}>Files and provider credentials remain under your control. Imports are staged locally for review; Ledgr never silently posts external data into the ledger.</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Configure local CSV bank feed" onPress={configureCsv} style={{ flex: 1, padding: 11, borderRadius: 12, backgroundColor: theme.color.brandPrimary }}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12, textAlign: 'center' }}>Use local CSV</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Import bank feed CSV" onPress={importCsv} style={{ flex: 1, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: theme.color.brandPrimary }}>
              <Text style={{ color: theme.color.brandPrimary, fontWeight: '800', fontSize: 12, textAlign: 'center' }}>Import file</Text>
            </Pressable>
          </View>
          {busy ? <ActivityIndicator style={{ marginTop: 12 }} color={theme.color.brandPrimary} /> : null}
        </Card>

        <Card style={{ padding: 16, marginBottom: 14 }} testID="self-host-sync-card">
          <Text style={{ color: theme.color.brandPrimary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 }}>Optional and user-owned</Text>
          <Text style={{ color: theme.color.onSurface, fontSize: 19, fontWeight: '800', marginTop: 5 }}>Self-host sync</Text>
          <Text style={{ color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 5 }}>Run the sync server yourself on a NAS, private computer, VPS, or local network. Ledgr stays usable offline and never requires a Ledgr cloud account.</Text>
          <TextInput value={syncUrl} onChangeText={setSyncUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://your-server.example.com" placeholderTextColor={theme.color.muted} style={{ borderWidth: 1, borderColor: theme.color.border, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 10, color: theme.color.onSurface, marginTop: 12 }} accessibilityLabel="Self-host sync server URL" />
          <TextInput value={syncWorkspace} onChangeText={setSyncWorkspace} autoCapitalize="none" autoCorrect={false} placeholder="Workspace identifier (optional)" placeholderTextColor={theme.color.muted} style={{ borderWidth: 1, borderColor: theme.color.border, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 10, color: theme.color.onSurface, marginTop: 8 }} accessibilityLabel="Self-host sync workspace identifier" />
          <TextInput value={syncToken} onChangeText={setSyncToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder={syncState?.hasToken ? 'Bearer token saved; leave blank to keep it' : 'Bearer token (optional if server allows anonymous access)'} placeholderTextColor={theme.color.muted} style={{ borderWidth: 1, borderColor: theme.color.border, borderRadius: 11, paddingHorizontal: 11, paddingVertical: 10, color: theme.color.onSurface, marginTop: 8 }} accessibilityLabel="Self-host sync bearer token" />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable disabled={syncBusy} accessibilityRole="button" accessibilityLabel="Save self-host sync settings" onPress={configureSelfHosted} style={{ flex: 1, padding: 11, borderRadius: 12, backgroundColor: theme.color.brandPrimary }}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 12, textAlign: 'center' }}>Save server</Text></Pressable>
            <Pressable disabled={syncBusy || !syncState?.enabled} accessibilityRole="button" accessibilityLabel="Test self-host sync connection" onPress={testSelfHosted} style={{ flex: 1, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: theme.color.brandPrimary, opacity: syncState?.enabled ? 1 : 0.45 }}><Text style={{ color: theme.color.brandPrimary, fontWeight: '800', fontSize: 12, textAlign: 'center' }}>Test connection</Text></Pressable>
          </View>
          {syncState?.enabled ? <>
            <View style={{ marginTop: 12, padding: 11, borderRadius: 12, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }}><Text style={{ color: theme.color.onSurface, fontWeight: '800', fontSize: 12 }}>Status: {syncState.status}</Text><Text style={{ color: theme.color.muted, fontSize: 10, marginTop: 3 }}>{syncState.lastSyncAt ? `Last sync ${new Date(syncState.lastSyncAt).toLocaleString()}` : 'No snapshot has been synchronized yet.'}{syncState.lastError ? ` · ${syncState.lastError}` : ''}</Text></View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <Pressable disabled={syncBusy} onPress={() => runSelfHosted('push')} style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11, backgroundColor: theme.color.brandPrimary }}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 11 }}>Push local</Text></Pressable>
              <Pressable disabled={syncBusy} onPress={() => runSelfHosted('pull')} style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: theme.color.brandPrimary }}><Text style={{ color: theme.color.brandPrimary, fontWeight: '800', fontSize: 11 }}>Pull remote</Text></Pressable>
              <Pressable disabled={syncBusy} onPress={() => runSelfHosted('sync')} style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: theme.color.border }}><Text style={{ color: theme.color.onSurface, fontWeight: '800', fontSize: 11 }}>Sync now</Text></Pressable>
              <Pressable disabled={syncBusy} onPress={disableSelfHosted} style={{ paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11 }}><Text style={{ color: theme.color.error, fontWeight: '800', fontSize: 11 }}>Disable</Text></Pressable>
            </View>
            {syncState.status === 'conflict' ? <View style={{ marginTop: 10, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: theme.color.warning, backgroundColor: theme.color.warning + '12' }}><Text style={{ color: theme.color.onSurface, fontWeight: '800', fontSize: 12 }}>Sync conflict needs your choice</Text><Text style={{ color: theme.color.muted, fontSize: 10, lineHeight: 15, marginTop: 3 }}>Nothing was silently overwritten. Choose which complete snapshot should win.</Text><View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Pressable disabled={syncBusy} onPress={() => resolveSelfHosted('push_local')} style={{ flex: 1, padding: 9, borderRadius: 10, backgroundColor: theme.color.brandPrimary }}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 10, textAlign: 'center' }}>Keep local</Text></Pressable><Pressable disabled={syncBusy} onPress={() => resolveSelfHosted('use_remote')} style={{ flex: 1, padding: 9, borderRadius: 10, borderWidth: 1, borderColor: theme.color.warning }}><Text style={{ color: theme.color.warning, fontWeight: '800', fontSize: 10, textAlign: 'center' }}>Use remote</Text></Pressable></View></View> : null}
          </> : null}
          {syncBusy ? <ActivityIndicator style={{ marginTop: 12 }} color={theme.color.brandPrimary} /> : null}
        </Card>

        <Text style={{ color: theme.color.onSurface, fontSize: 17, fontWeight: '800', marginBottom: 8 }}>Configured locally</Text>
        {integrations.length ? integrations.map((item) => <Card key={item.id} style={{ padding: 12, marginBottom: 8 }}><Text style={{ color: theme.color.onSurface, fontWeight: '800' }}>{item.display_name}</Text><Text style={{ color: theme.color.muted, fontSize: 11, marginTop: 3 }}>{item.provider} · {item.kind} · {item.enabled ? 'Enabled' : 'Disabled'}</Text></Card>) : <Text style={{ color: theme.color.muted, fontSize: 12, marginBottom: 14 }}>No provider is configured yet.</Text>}

        <Text style={{ color: theme.color.onSurface, fontSize: 17, fontWeight: '800', marginTop: 8, marginBottom: 8 }}>Pending local sync work</Text>
        <Card style={{ padding: 12, marginBottom: 14 }}><Text style={{ color: theme.color.onSurface, fontWeight: '800' }}>{pending.length} item(s) waiting</Text><Text style={{ color: theme.color.muted, fontSize: 11, marginTop: 3 }}>These are local retry-safe records. An online connector can process them later, but the app remains fully usable offline.</Text></Card>

        <Text style={{ color: theme.color.onSurface, fontSize: 17, fontWeight: '800', marginBottom: 8 }}>Bank rows awaiting review</Text>
        {feed.length ? feed.slice(0, 30).map((row) => <Card key={row.id} style={{ padding: 12, marginBottom: 8 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: theme.color.onSurface, fontWeight: '800', flex: 1 }}>{row.description || row.external_id}</Text><Text style={{ color: theme.color.onSurface, fontWeight: '800' }}>{Number(row.amount).toFixed(2)} {row.currency}</Text></View><Text style={{ color: theme.color.muted, fontSize: 11, marginTop: 3 }}>{row.date} · {row.status}</Text></Card>) : <Text style={{ color: theme.color.muted, fontSize: 12 }}>Import a CSV to stage bank rows for matching.</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}
