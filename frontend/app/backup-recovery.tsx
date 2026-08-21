import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { activeBookId } from '@/src/db/backend';
import { HostingModeCard } from '@/src/components/HostingModeCard';
import { decryptBackup, encryptBackup, isEncryptedBackup, type EncryptedBackupEnvelope } from '@/src/utils/backupEncryption';
import { listBackupHistory, recordBackupHistory, estimateJsonSize, type BackupHistoryEntry } from '@/src/utils/backupHistory';
import { checkLocalIntegrity, type LocalIntegrityResult } from '@/src/utils/localIntegrity';
import { pickJsonFile, shareJsonFile } from '@/src/utils/share';

const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

function dryRunBackup(payload: any, currentBookId: string): { ok: boolean; summary: string; issues: string[] } {
  const issues: string[] = [];
  if (!payload || typeof payload !== 'object') issues.push('The decrypted payload is not an object.');
  if (payload?._meta?.app !== 'ledgr') issues.push('This is not a Ledgr backup.');
  if (Number(payload?._meta?.version) !== 10) issues.push('This backup format is not supported by this build.');
  if (!payload?.v2 || payload.v2.schemaVersion !== 1 || !payload.v2.tables || typeof payload.v2.tables !== 'object') issues.push('The backup does not contain the current V2 accounting ledger.');
  const backupBookId = payload?.v2?.meta?.v2_active_book_id || payload?.books?.find((book: any) => book?.id === currentBookId)?.id;
  if (backupBookId && currentBookId !== 'default' && backupBookId !== currentBookId) issues.push('This backup belongs to a different active business book. Switch to the matching book or cancel restore.');
  const journalEntries = Array.isArray(payload?.v2?.tables?.v2_journal_entries) ? payload.v2.tables.v2_journal_entries.length : 0;
  const journalLines = Array.isArray(payload?.v2?.tables?.v2_journal_lines) ? payload.v2.tables.v2_journal_lines.length : 0;
  const books = Array.isArray(payload?.books) ? payload.books.length : 0;
  return { ok: issues.length === 0, summary: `${books || 1} business book${books === 1 ? '' : 's'} · ${journalEntries} journal entr${journalEntries === 1 ? 'y' : 'ies'} · ${journalLines} journal lines`, issues };
}

export default function BackupRecoveryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [passphrase, setPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [pendingEnvelope, setPendingEnvelope] = useState<EncryptedBackupEnvelope | null>(null);
  const [pendingFileName, setPendingFileName] = useState('');
  const [dryRun, setDryRun] = useState<{ ok: boolean; summary: string; issues: string[] } | null>(null);
  const [history, setHistory] = useState<BackupHistoryEntry[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [integrity, setIntegrity] = useState<LocalIntegrityResult | null>(null);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderDays, setReminderDays] = useState('7');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'export' | 'pick' | 'restore' | 'integrity' | null>(null);

  const load = useCallback(async () => {
    const [items, settings] = await Promise.all([listBackupHistory(), api.getSettings()]);
    setHistory(items);
    setReminderEnabled(settings.backupReminderEnabled !== false);
    setReminderDays(String(settings.backupReminderDays || 7));
    try { setAuditEvents(await api.listAuditEvents()); } catch { setAuditEvents([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runIntegrity = async () => {
    setBusy('integrity'); setMessage('');
    try {
      const result = await checkLocalIntegrity();
      setIntegrity(result);
      await api.recordBackupAuditEvent('backup.integrity_checked', { ok: result.ok, issueCount: result.issues.length });
      setMessage(result.ok ? 'Local integrity check passed.' : `Integrity check found ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}.`);
      await load();
    } catch (error: any) { setMessage(error?.message || 'Integrity check failed.'); }
    finally { setBusy(null); }
  };

  const exportEncrypted = async () => {
    if (passphrase.trim().length < 8) { setMessage('Use a backup passphrase with at least 8 characters.'); return; }
    setBusy('export'); setMessage('');
    try {
      const localCheck = integrity || await checkLocalIntegrity();
      if (!localCheck.ok) throw new Error(`Fix local integrity issues before exporting: ${localCheck.issues.join(' ')}`);
      const raw = await api.exportBackup();
      const encrypted = await encryptBackup(raw, passphrase);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `ledgr-encrypted-backup-${stamp}.ledgr.json`;
      await shareJsonFile(fileName, encrypted);
      await recordBackupHistory({ createdAt: encrypted.createdAt, sizeBytes: estimateJsonSize(encrypted), kind: 'encrypted_export', verified: true, fileName, note: 'Encrypted export integrity verified before sharing.' });
      await api.recordBackupAuditEvent('backup.exported', { fileName, sizeBytes: estimateJsonSize(encrypted), cipher: encrypted.cipher, kdf: encrypted.kdf });
      setPassphrase(''); setMessage('Encrypted backup is ready. Keep the file and passphrase separately.');
      await load();
    } catch (error: any) { setMessage(error?.message || 'Encrypted backup export failed.'); }
    finally { setBusy(null); }
  };

  const chooseImport = async () => {
    setBusy('pick'); setMessage('');
    try {
      const picked = await pickJsonFile();
      if (!picked.ok) { if (picked.reason === 'invalid') setMessage('The selected backup file is unreadable or corrupted.'); return; }
      if (!isEncryptedBackup(picked.data)) throw new Error('Choose an encrypted Ledgr backup created from Backup & Recovery.');
      setPendingEnvelope(picked.data); setPendingFileName('Selected encrypted backup'); setDryRun(null); setImportPassphrase(''); setMessage('Backup selected. Enter its passphrase, then run the non-destructive validation.');
    } catch (error: any) { setMessage(error?.message || 'Could not read the backup file.'); }
    finally { setBusy(null); }
  };

  const validateImport = async () => {
    if (!pendingEnvelope) return;
    if (importPassphrase.trim().length < 8) { setMessage('Enter the passphrase used to encrypt this backup.'); return; }
    setBusy('restore'); setMessage('');
    try {
      const payload = await decryptBackup(pendingEnvelope, importPassphrase);
      const result = dryRunBackup(payload, activeBookId());
      setDryRun(result);
      await api.recordBackupAuditEvent('backup.restore_dry_run', { ok: result.ok, summary: result.summary, issueCount: result.issues.length });
      setMessage(result.ok ? 'Restore dry-run passed. No data has been changed.' : 'Restore dry-run found issues. No data has been changed.');
      await load();
    } catch (error: any) { setDryRun(null); setMessage(error?.message || 'Backup decryption or validation failed.'); }
    finally { setBusy(null); }
  };

  const confirmRestore = () => {
    if (!pendingEnvelope || !dryRun?.ok) return;
    Alert.alert('Replace this local book?', 'Restore first validates the encrypted file, then atomically replaces the current main book. Keep the original backup file unchanged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore backup', style: 'destructive', onPress: async () => {
        setBusy('restore'); setMessage('');
        try {
          const payload = await decryptBackup(pendingEnvelope, importPassphrase);
          const result = await api.importBackup(payload);
          await recordBackupHistory({ createdAt: new Date().toISOString(), sizeBytes: estimateJsonSize(pendingEnvelope), kind: 'restore', verified: true, fileName: pendingFileName, note: 'Restore completed after successful dry-run.' });
          await api.recordBackupAuditEvent('backup.restored', { fileName: pendingFileName, warningCount: Array.isArray(result?.warnings) ? result.warnings.length : 0 });
          setPendingEnvelope(null); setDryRun(null); setImportPassphrase(''); setMessage('Backup restored. Sync is quarantined until its recovery flow is completed.');
          await load();
        } catch (error: any) { setMessage(error?.message || 'Restore failed. Your existing data was kept if the atomic restore could not complete.'); }
        finally { setBusy(null); }
      } },
    ]);
  };

  const saveReminder = async (enabled: boolean) => {
    const days = Math.max(1, Math.min(365, Number(reminderDays) || 7));
    setReminderEnabled(enabled);
    setReminderDays(String(days));
    await api.updateSettings({ backupReminderEnabled: enabled, backupReminderDays: days });
    setMessage(enabled ? `Backup reminder enabled every ${days} days.` : 'Backup reminder disabled.');
  };

  return <SafeAreaView style={styles.container} edges={['top']}>
    <View style={styles.header}><Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back"><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable><ScreenHeader title="Backup & Recovery" subtitle="Protect and verify your business books" /></View>
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <HostingModeCard compact />
      <View style={styles.card}><Text style={styles.title}>Encrypted backup</Text><Text style={styles.hint}>Backups are portable recovery files. They are not live synchronization, and Ledgr never stores this passphrase in ordinary settings.</Text><Text style={styles.label}>Create an encryption passphrase</Text><TextInput testID="backup-export-passphrase" value={passphrase} onChangeText={setPassphrase} secureTextEntry placeholder="At least 8 characters" placeholderTextColor={theme.color.muted} style={styles.input} /><Pressable testID="backup-export-button" disabled={busy !== null} onPress={exportEncrypted} style={[styles.primary, busy !== null && styles.disabled]}><Text style={styles.primaryText}>{busy === 'export' ? 'Encrypting…' : 'Export encrypted backup'}</Text></Pressable></View>
      <View style={styles.card}><Text style={styles.title}>Restore with a dry-run first</Text><Text style={styles.hint}>Choose an encrypted file, decrypt it locally, and validate its schema, book identity, V2 ledger, and integrity before anything is replaced.</Text><Pressable testID="backup-pick-button" disabled={busy !== null} onPress={chooseImport} style={styles.secondary}><Text style={styles.secondaryText}>{busy === 'pick' ? 'Opening files…' : 'Choose encrypted backup'}</Text></Pressable>{pendingEnvelope ? <><Text style={styles.selected}>{pendingFileName}</Text><TextInput testID="backup-import-passphrase" value={importPassphrase} onChangeText={setImportPassphrase} secureTextEntry placeholder="Backup passphrase" placeholderTextColor={theme.color.muted} style={styles.input} /><View style={styles.row}><Pressable testID="backup-dry-run-button" disabled={busy !== null} onPress={validateImport} style={styles.secondary}><Text style={styles.secondaryText}>{busy === 'restore' ? 'Validating…' : 'Run restore dry-run'}</Text></Pressable>{dryRun?.ok ? <Pressable testID="backup-restore-button" disabled={busy !== null} onPress={confirmRestore} style={styles.danger}><Text style={styles.dangerText}>Restore verified backup</Text></Pressable> : null}</View>{dryRun ? <View style={[styles.result, dryRun.ok ? styles.resultGood : styles.resultBad]}><Text style={styles.resultTitle}>{dryRun.ok ? 'Dry-run passed' : 'Dry-run blocked'}</Text><Text style={styles.hint}>{dryRun.summary}</Text>{dryRun.issues.map((issue) => <Text key={issue} style={styles.error}>• {issue}</Text>)}</View> : null}</> : null}</View>
      <View style={styles.card}><Text style={styles.title}>Local checks and reminders</Text><Text style={styles.hint}>Run a read-only integrity check before migration or recovery. Private sync requires a healthy local book and a recent verified encrypted backup.</Text><Pressable testID="backup-integrity-button" disabled={busy !== null} onPress={runIntegrity} style={styles.secondary}><Text style={styles.secondaryText}>{busy === 'integrity' ? 'Checking…' : 'Run local integrity check'}</Text></Pressable>{integrity ? <View style={[styles.result, integrity.ok ? styles.resultGood : styles.resultBad]}><Text style={styles.resultTitle}>{integrity.ok ? 'Local book healthy' : 'Review local integrity issues'}</Text><Text style={styles.hint}>{integrity.storage.toUpperCase()} · schema {integrity.schemaVersion ?? 'managed fallback'} · checked {new Date(integrity.checkedAt).toLocaleString()}</Text>{integrity.issues.map((issue) => <Text key={issue} style={styles.error}>• {issue}</Text>)}</View> : null}<View style={styles.reminderRow}><View style={{ flex: 1 }}><Text style={styles.label}>Backup reminder</Text><Text style={styles.hint}>Keep a recent encrypted recovery copy.</Text></View><Switch value={reminderEnabled} onValueChange={saveReminder} /></View><View style={styles.daysRow}><Text style={styles.hint}>Remind every</Text><TextInput value={reminderDays} onChangeText={setReminderDays} onBlur={() => saveReminder(reminderEnabled)} keyboardType="number-pad" style={styles.daysInput} /><Text style={styles.hint}>days</Text></View></View>
      <View style={styles.card}><Text style={styles.title}>Backup history</Text>{history.length ? history.map((item) => <View key={item.id} style={styles.historyRow}><Ionicons name={item.kind === 'restore' ? 'download-outline' : 'shield-checkmark-outline'} size={20} color={item.verified ? theme.color.success : theme.color.warning} /><View style={{ flex: 1 }}><Text style={styles.historyTitle}>{item.kind === 'restore' ? 'Restore event' : 'Encrypted export'} · {item.verified ? 'Verified' : 'Unverified'}</Text><Text style={styles.hint}>{new Date(item.createdAt).toLocaleString()} · {formatBytes(item.sizeBytes)}{item.fileName ? ` · ${item.fileName}` : ''}</Text></View></View>) : <Text style={styles.hint}>No encrypted backup events recorded for this business book yet.</Text>}</View>
      <View style={styles.card}><Text style={styles.title}>Recovery audit events</Text>{auditEvents.length ? auditEvents.slice(0, 10).map((item: any) => <View key={item.id} style={styles.auditRow}><Text style={styles.auditType}>{item.eventType || item.event_type}</Text><Text style={styles.hint}>{new Date(item.createdAt || item.created_at).toLocaleString()}</Text></View>) : <Text style={styles.hint}>Integrity, dry-run, export, and restore events will appear here.</Text>}</View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      <View style={{ height: 30 }} />
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (theme: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: theme.spacing.lg, paddingTop: 16 },
  scroll: { padding: theme.spacing.lg, paddingBottom: 40, gap: 14 },
  card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 18, gap: 9 },
  title: { color: theme.color.onSurface, fontSize: 18, fontWeight: '700' },
  hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 },
  label: { color: theme.color.onSurface, fontSize: 13, fontWeight: '700', marginTop: 5 },
  input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 },
  primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  primaryText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
  secondary: { borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
  secondaryText: { color: theme.color.onSurface, fontWeight: '700' },
  danger: { borderColor: theme.color.error, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center' },
  dangerText: { color: theme.color.error, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  selected: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '700' },
  result: { padding: 12, borderRadius: theme.radius.md, borderWidth: 1, gap: 4 },
  resultGood: { backgroundColor: theme.color.successBg, borderColor: theme.color.success + '55' },
  resultBad: { backgroundColor: theme.color.errorBg, borderColor: theme.color.error + '55' },
  resultTitle: { color: theme.color.onSurface, fontWeight: '800' },
  error: { color: theme.color.error, fontSize: 12, lineHeight: 17 },
  reminderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  daysRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  daysInput: { width: 62, color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 8, textAlign: 'center' },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 11, marginTop: 3 },
  historyTitle: { color: theme.color.onSurface, fontWeight: '700', fontSize: 13 },
  auditRow: { borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 10, marginTop: 3 },
  auditType: { color: theme.color.onSurface, fontWeight: '700', fontSize: 12 },
  message: { color: theme.color.muted, fontSize: 13, lineHeight: 18 },
});
