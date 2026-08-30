import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '@/src/api';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { decryptBackup, encryptBackup, isEncryptedBackup, type EncryptedBackupEnvelope } from '@/src/utils/backupEncryption';
import { pickJsonFile, shareJsonFile } from '@/src/utils/share';
import { requireAuth } from '@/src/utils/lock';
import type { BookHealth } from '@/src/utils/bookHealth';
import { SETTINGS_SCREEN_CARD_GAP, SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

type PendingBackup = { kind: 'encrypted'; envelope: EncryptedBackupEnvelope } | { kind: 'legacy'; payload: any };
type Preflight = { ok: true; formatVersion: number; v2SchemaVersion: number; businessAccountCount: number; secondaryBookIds: string[] };

export default function BackupRecoveryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [health, setHealth] = useState<BookHealth | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [pending, setPending] = useState<PendingBackup | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState<'export' | 'pick' | 'validate' | 'restore' | null>(null);
  const [message, setMessage] = useState('');

  const loadHealth = useCallback(() => { api.getBookHealth().then(setHealth).catch((error) => console.warn('backup health', error)); }, []);
  useFocusEffect(useCallback(() => { loadHealth(); }, [loadHealth]));

  const encryptedPayload = async (): Promise<any> => {
    if (!pending) throw new Error('Choose a backup file first.');
    if (pending.kind === 'legacy') return pending.payload;
    if (importPassphrase.trim().length < 8) throw new Error('Enter the passphrase used to encrypt this backup.');
    return decryptBackup(pending.envelope, importPassphrase);
  };

  const exportEncrypted = async () => {
    if (exportPassphrase.trim().length < 8) { setMessage('Use a backup passphrase with at least 8 characters.'); return; }
    if (exportPassphrase !== confirmPassphrase) { setMessage('The two backup passphrases do not match.'); return; }
    setBusy('export'); setMessage('');
    try {
      const latestHealth = await api.getBookHealth();
      setHealth(latestHealth);
      const raw = await api.exportBackup();
      api.validateBackupForImport(raw);
      const encrypted = await encryptBackup(raw, exportPassphrase);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await shareJsonFile(`ledgr-encrypted-backup-${stamp}.ledgr.json`, encrypted);
      await api.updateSettings({ lastBackupAt: new Date().toISOString() });
      setExportPassphrase(''); setConfirmPassphrase('');
      setMessage(latestHealth.tone === 'critical'
        ? 'Encrypted backup created. Book Health still has a critical finding; keep this recovery copy and review the finding.'
        : 'Encrypted backup created. Keep the file and its passphrase in separate safe places.');
      loadHealth();
    } catch (error: any) { setMessage(error?.message || 'Encrypted backup export failed.'); }
    finally { setBusy(null); }
  };

  const chooseBackup = async () => {
    setBusy('pick'); setMessage(''); setPreflight(null); setPending(null); setImportPassphrase('');
    try {
      const picked = await pickJsonFile();
      if (!picked.ok) { if (picked.reason === 'invalid') setMessage('The selected file is unreadable or corrupted.'); return; }
      if (isEncryptedBackup(picked.data)) {
        setPending({ kind: 'encrypted', envelope: picked.data });
        setMessage('Encrypted backup selected. Enter its passphrase and validate it before restoring.');
      } else if (picked.data?._meta?.app === 'ledgr') {
        setPending({ kind: 'legacy', payload: picked.data });
        setMessage('Unencrypted legacy backup selected. Validate it before restoring, then create a new encrypted backup.');
      } else throw new Error('Choose an encrypted or supported legacy Ledgr backup.');
    } catch (error: any) { setMessage(error?.message || 'Could not read the backup file.'); }
    finally { setBusy(null); }
  };

  const validatePending = async () => {
    setBusy('validate'); setMessage(''); setPreflight(null);
    try {
      const payload = await encryptedPayload();
      const result = api.validateBackupForImport(payload) as Preflight;
      setPreflight(result);
      setMessage(`Validation passed. ${result.businessAccountCount} Business Account${result.businessAccountCount === 1 ? '' : 's'} can be restored. No data has changed.`);
    } catch (error: any) { setMessage(error?.message || 'Backup validation failed. No data has changed.'); }
    finally { setBusy(null); }
  };

  const confirmRestore = () => {
    if (!preflight?.ok || !pending) return;
    Alert.alert(
      'Replace local accounting data?',
      `This verified backup contains ${preflight.businessAccountCount} Business Account${preflight.businessAccountCount === 1 ? '' : 's'}. Restore will atomically replace local books and quarantine private sync until re-enrollment.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Restore verified backup', style: 'destructive', onPress: async () => {
          if (!(await requireAuth('Confirm encrypted backup restore'))) return;
          setBusy('restore'); setMessage('');
          try {
            const payload = await encryptedPayload();
            api.validateBackupForImport(payload);
            const result: any = await api.importBackup({ ...payload, mode: 'replace' });
            const warnings: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
            setPending(null); setPreflight(null); setImportPassphrase('');
            setMessage(warnings.length ? `Restore completed with warnings: ${warnings.join(' ')}` : 'Restore completed. Private sync remains quarantined until its recovery flow is completed.');
            loadHealth();
          } catch (error: any) { setMessage(error?.message || 'Restore failed. Existing data was retained if the atomic import could not complete.'); }
          finally { setBusy(null); }
        } },
      ],
    );
  };

  const healthColor = health?.tone === 'critical' ? theme.color.error : health?.tone === 'attention' ? theme.color.warning : theme.color.success;
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}><ScreenHeader embedded title="Backup & Recovery" subtitle="Encrypted, local and portable" /></View>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {health ? <Card shadowEnabled={false} style={[styles.health, { borderColor: healthColor }]}><Ionicons name={health.tone === 'healthy' ? 'shield-checkmark' : 'alert-circle'} size={22} color={healthColor} /><View style={{ flex: 1 }}><Text style={styles.cardTitle}>Book Health: {health.label}</Text><Text style={styles.hint}>Health is checked before export. A recovery copy is still allowed when attention is needed.</Text></View></Card> : null}

        <Card shadowEnabled={false} style={styles.card}>
          <Text style={styles.cardTitle}>Create encrypted backup</Text>
          <Text style={styles.hint}>AES-256-GCM encryption runs on this device. Ledgr does not save or transmit this passphrase. Losing it means the backup cannot be recovered.</Text>
          <TextInput testID="backup-export-passphrase" value={exportPassphrase} onChangeText={setExportPassphrase} secureTextEntry placeholder="Passphrase — at least 8 characters" placeholderTextColor={theme.color.muted} style={styles.input} />
          <TextInput testID="backup-confirm-passphrase" value={confirmPassphrase} onChangeText={setConfirmPassphrase} secureTextEntry placeholder="Confirm passphrase" placeholderTextColor={theme.color.muted} style={styles.input} />
          <Pressable testID="backup-export-encrypted" disabled={busy !== null} onPress={exportEncrypted} style={[styles.primary, busy !== null && styles.disabled]}>{busy === 'export' ? <ActivityIndicator color={theme.color.onBrandPrimary} /> : <><Ionicons name="shield-checkmark-outline" size={18} color={theme.color.onBrandPrimary} /><Text style={styles.primaryText}>Create & Share Encrypted Backup</Text></>}</Pressable>
        </Card>

        <Card shadowEnabled={false} style={styles.card}>
          <Text style={styles.cardTitle}>Validate and restore</Text>
          <Text style={styles.hint}>Encrypted backups are decrypted locally. Existing unencrypted Ledgr backups remain import-compatible, but new exports are encrypted.</Text>
          <Pressable testID="backup-pick" disabled={busy !== null} onPress={chooseBackup} style={styles.secondary}><Ionicons name="document-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>{busy === 'pick' ? 'Opening files…' : 'Choose Backup File'}</Text></Pressable>
          {pending?.kind === 'encrypted' ? <TextInput testID="backup-import-passphrase" value={importPassphrase} onChangeText={setImportPassphrase} secureTextEntry placeholder="Backup passphrase" placeholderTextColor={theme.color.muted} style={styles.input} /> : null}
          {pending ? <Pressable testID="backup-validate" disabled={busy !== null} onPress={validatePending} style={styles.secondary}>{busy === 'validate' ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="search-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>Validate Without Restoring</Text></>}</Pressable> : null}
          {preflight?.ok ? <View style={styles.validation}><Text style={styles.validationTitle}>Validation passed</Text><Text style={styles.hint}>Format v{preflight.formatVersion} · V2 schema {preflight.v2SchemaVersion} · {preflight.businessAccountCount} Business Account{preflight.businessAccountCount === 1 ? '' : 's'}</Text><Pressable testID="backup-restore" disabled={busy !== null} onPress={confirmRestore} style={styles.danger}><Text style={styles.dangerText}>{busy === 'restore' ? 'Restoring…' : 'Restore Verified Backup'}</Text></Pressable></View> : null}
        </Card>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        <View style={{ height: 70 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: theme.spacing.lg, paddingTop: 16, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM },
    content: { padding: theme.spacing.lg, paddingTop: SETTINGS_SCREEN_CONTENT_TOP, gap: SETTINGS_SCREEN_CARD_GAP },
    card: { gap: 10 },
    health: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1 },
    cardTitle: { color: theme.color.onSurface, fontSize: 17, fontWeight: '700' },
    hint: { color: theme.color.muted, fontSize: 12, lineHeight: 18 },
    input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 },
    primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, padding: 13 },
    primaryText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
    secondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12 },
    secondaryText: { color: theme.color.brandPrimary, fontWeight: '700' },
    disabled: { opacity: 0.55 },
    validation: { padding: 12, borderWidth: 1, borderColor: theme.color.success, backgroundColor: theme.color.successBg, borderRadius: theme.radius.md, gap: 5 },
    validationTitle: { color: theme.color.success, fontWeight: '700' },
    danger: { marginTop: 7, borderWidth: 1, borderColor: theme.color.error, borderRadius: theme.radius.md, padding: 11, alignItems: 'center' },
    dangerText: { color: theme.color.error, fontWeight: '700' },
    message: { color: theme.color.onSurface, fontSize: 12, lineHeight: 18, padding: 12, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceSecondary },
  });
}
