import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { pickTextFile } from '@/src/utils/share';
import { parseBankCsvPreview, type BankPreviewResult } from '@/src/utils/bankImportPreview';
import { SETTINGS_SCREEN_CARD_GAP, SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

export default function BankImportPreviewScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [preview, setPreview] = useState<BankPreviewResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const choose = async () => {
    setBusy(true); setError(''); setPreview(null);
    try {
      const picked = await pickTextFile();
      if (!picked.ok) { if (picked.reason === 'invalid') setError('The selected CSV could not be read.'); return; }
      setFileName(picked.name);
      setPreview(parseBankCsvPreview(picked.text));
    } catch (cause: any) { setError(cause?.message || 'Could not preview this statement.'); }
    finally { setBusy(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable><View style={{ flex: 1 }}><ScreenHeader embedded title="Bank Statement Preview" subtitle="Experimental · no ledger posting" /></View></View>
      <ScrollView contentContainerStyle={styles.content}>
        <Card shadowEnabled={false} style={styles.warning}><Ionicons name="eye-outline" size={23} color={theme.color.warning} /><View style={{ flex: 1 }}><Text style={styles.warningTitle}>Review-only safety boundary</Text><Text style={styles.hint}>This screen cannot create, match or reconcile transactions. The preview stays in memory and is discarded when you leave.</Text></View></Card>
        <Card shadowEnabled={false} style={styles.card}>
          <Text style={styles.title}>Choose a CSV statement</Text>
          <Text style={styles.hint}>Required columns: date, description, and amount—or debit/credit. Dates may use YYYY-MM-DD or MM/DD/YYYY.</Text>
          <Pressable testID="bank-preview-pick" disabled={busy} onPress={choose} style={styles.primary}>{busy ? <ActivityIndicator color={theme.color.onBrandPrimary} /> : <><Ionicons name="document-text-outline" size={18} color={theme.color.onBrandPrimary} /><Text style={styles.primaryText}>Choose CSV File</Text></>}</Pressable>
          {fileName ? <Text style={styles.fileName}>{fileName}</Text> : null}
        </Card>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {preview ? <>
          <View style={styles.summaryRow}>
            <Card shadowEnabled={false} style={styles.summaryCard}><Text style={styles.summaryValue}>{preview.validCount}</Text><Text style={styles.summaryLabel}>Ready to review</Text></Card>
            <Card shadowEnabled={false} style={styles.summaryCard}><Text style={styles.summaryValue}>{preview.duplicateCount}</Text><Text style={styles.summaryLabel}>Duplicates</Text></Card>
            <Card shadowEnabled={false} style={styles.summaryCard}><Text style={styles.summaryValue}>{preview.invalidCount}</Text><Text style={styles.summaryLabel}>Invalid</Text></Card>
          </View>
          <Card shadowEnabled={false} style={{ padding: 0, overflow: 'hidden' }}>
            {preview.rows.map((row) => (
              <View key={`${row.id}:${row.sourceLine}`} style={[styles.row, (!row.valid || row.duplicate) && styles.rowAttention]}>
                <Ionicons name={!row.valid ? 'alert-circle-outline' : row.duplicate ? 'copy-outline' : row.direction === 'inflow' ? 'arrow-down-circle-outline' : 'arrow-up-circle-outline'} size={20} color={!row.valid ? theme.color.error : row.duplicate ? theme.color.warning : row.direction === 'inflow' ? theme.color.success : theme.color.onSurface} />
                <View style={{ flex: 1 }}><Text style={styles.rowTitle}>{row.description || `Line ${row.sourceLine}`}</Text><Text style={styles.rowDetail}>{row.date} · line {row.sourceLine}{row.issue ? ` · ${row.issue}` : row.duplicate ? ' · duplicate in this file' : ''}</Text></View>
                <Text style={[styles.amount, { color: row.direction === 'inflow' ? theme.color.success : theme.color.onSurface }]}>{row.direction === 'inflow' ? '+' : '−'}{row.amount.toFixed(2)}</Text>
              </View>
            ))}
          </Card>
          <Pressable testID="bank-preview-clear" onPress={() => { setPreview(null); setFileName(''); setError(''); }} style={styles.clear}><Text style={styles.clearText}>Discard Preview</Text></Pressable>
        </> : null}
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
    warning: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderColor: theme.color.warning },
    warningTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '700' },
    card: { gap: 8 },
    title: { color: theme.color.onSurface, fontSize: 16, fontWeight: '700' },
    hint: { color: theme.color.muted, fontSize: 12, lineHeight: 17 },
    primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, padding: 13, marginTop: 4 },
    primaryText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
    fileName: { color: theme.color.brandPrimary, fontSize: 11, fontWeight: '600' },
    error: { color: theme.color.error, backgroundColor: theme.color.errorBg, borderRadius: theme.radius.md, padding: 11, fontSize: 12 },
    summaryRow: { flexDirection: 'row', gap: 8 },
    summaryCard: { flex: 1, alignItems: 'center', padding: 10 },
    summaryValue: { color: theme.color.onSurface, fontSize: 18, fontWeight: '700' },
    summaryLabel: { color: theme.color.muted, fontSize: 9, textAlign: 'center', marginTop: 2 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
    rowAttention: { backgroundColor: theme.color.warning + '0D' },
    rowTitle: { color: theme.color.onSurface, fontSize: 13, fontWeight: '600' },
    rowDetail: { color: theme.color.muted, fontSize: 10, marginTop: 2 },
    amount: { fontSize: 12, fontWeight: '700' },
    clear: { alignItems: 'center', padding: 12, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md },
    clearText: { color: theme.color.muted, fontWeight: '700' },
  });
}
