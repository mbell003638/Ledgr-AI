import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '@/src/api';
import { ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import type { SyncCorrectionAccount } from '@/src/sync/conflicts';
import { isValidDateString, normalizeDateInput } from '@/src/utils/dateValidation';

const today = () => new Date().toISOString().slice(0, 10);

export default function SyncConflictCorrectionScreen() {
  const theme = useTheme(); const styles = useMemo(() => makeStyles(theme), [theme]);
  const params = useLocalSearchParams<{ conflictId: string; operationId?: string }>();
  const conflictId = String(params.conflictId || ''); const operationId = String(params.operationId || '');
  const [reason, setReason] = useState(''); const [date, setDate] = useState(today());
  const [debitAccountId, setDebitAccountId] = useState(''); const [creditAccountId, setCreditAccountId] = useState('');
  const [amount, setAmount] = useState(''); const [memo, setMemo] = useState(''); const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<SyncCorrectionAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true); const [accountError, setAccountError] = useState('');
  const [accountPicker, setAccountPicker] = useState<'debit' | 'credit' | null>(null);
  useEffect(() => {
    let live = true;
    api.listSyncCorrectionAccounts().then((rows) => {
      if (!live) return;
      setAccounts(rows); setAccountError('');
    }).catch((error: any) => {
      if (live) setAccountError(error?.message || 'Could not load the chart of accounts.');
    }).finally(() => {
      if (live) setAccountsLoading(false);
    });
    return () => { live = false; };
  }, []);
  const debitAccount = accounts.find((account) => account.id === debitAccountId);
  const creditAccount = accounts.find((account) => account.id === creditAccountId);
  const submit = async () => {
    const value = Number(amount);
    const normalizedDate = normalizeDateInput(date);
    if (!conflictId) return Alert.alert('Conflict unavailable', 'Return to the Conflict Inbox and try again.');
    if (reason.trim().length < 3) return Alert.alert('Reason required', 'Enter an audit reason of at least three characters.');
    if (!isValidDateString(normalizedDate)) return Alert.alert('Invalid date', 'Use YYYY-MM-DD.');
    if (!debitAccount || !creditAccount || debitAccount.id === creditAccount.id) return Alert.alert('Accounts required', 'Select two different active accounts from this Business Account.');
    if (!Number.isFinite(value) || value <= 0) return Alert.alert('Invalid amount', 'Enter a positive correction amount.');
    const note = memo.trim() || reason.trim();
    const payload = {
      reason: reason.trim(), conflictId, ...(operationId ? { correctsOperationId: operationId } : {}),
      posting: { date: normalizedDate, memo: note, lines: [
        { accountId: debitAccount.id, debit: value, credit: 0, memo: note },
        { accountId: creditAccount.id, debit: 0, credit: value, memo: note },
      ] },
    };
    setBusy(true);
    try {
      await (api.resolveSyncConflict as any)(conflictId, 'audited_correction', payload, 'accounting.correction.post');
      Alert.alert('Correction queued', 'Install the canonical snapshot next. Ledgr will then replay this balanced posting and preserved offline work before sync resumes.', [{ text: 'OK', onPress: () => router.replace('/sync-settings' as any) }]);
    } catch (error: any) { Alert.alert('Correction failed', error?.message || 'The conflict remains open.'); } finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.container} edges={['top']}><ScreenHeader title="Audited Correction" subtitle="Post a new balanced entry" leftAction={<Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>} />
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled"><View style={styles.card}><Text style={styles.warning}>This creates a new posting. It never overwrites or deletes historical accounting records.</Text>
      <Field label="Audit reason" value={reason} onChangeText={setReason} placeholder="Why is this correction required?" styles={styles} theme={theme} />
      <Field label="Posting date" value={date} onChangeText={setDate} onBlur={() => { if (date.trim()) setDate(normalizeDateInput(date)); }} placeholder="YYYY-MM-DD" styles={styles} theme={theme} />
      {accountsLoading ? <View style={styles.loading}><ActivityIndicator color={theme.color.brandPrimary} /><Text style={styles.warning}>Loading chart of accounts…</Text></View> : null}
      {accountError ? <Text style={styles.error}>{accountError}</Text> : null}
      {!accountsLoading && !accountError ? <>
        <AccountPickerField label="Debit account" account={debitAccount} onPress={() => setAccountPicker('debit')} styles={styles} />
        <AccountPickerField label="Credit account" account={creditAccount} onPress={() => setAccountPicker('credit')} styles={styles} />
      </> : null}
      <Field label="Amount" value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" styles={styles} theme={theme} />
      <Field label="Memo (optional)" value={memo} onChangeText={setMemo} placeholder="Correction memo" styles={styles} theme={theme} />
      <Pressable disabled={busy || accountsLoading || accounts.length < 2} onPress={submit} style={[styles.submit, (busy || accountsLoading || accounts.length < 2) && styles.disabled]}><Text style={styles.submitText}>{busy ? 'Queuing…' : 'Post audited correction'}</Text></Pressable>
    </View></ScrollView>
    <AccountPickerModal
      visible={accountPicker !== null} title={`Select ${accountPicker || ''} account`} accounts={accounts}
      selectedId={accountPicker === 'debit' ? debitAccountId : creditAccountId}
      excludedId={accountPicker === 'debit' ? creditAccountId : debitAccountId}
      onClose={() => setAccountPicker(null)} onSelect={(account) => {
        if (accountPicker === 'debit') setDebitAccountId(account.id); else if (accountPicker === 'credit') setCreditAccountId(account.id);
        setAccountPicker(null);
      }} styles={styles} theme={theme}
    />
  </SafeAreaView>;
}

function AccountPickerField({ label, account, onPress, styles }: { label: string; account?: SyncCorrectionAccount; onPress: () => void; styles: any }) {
  return <View><Text style={styles.label}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${account ? `${account.code} ${account.name}` : 'not selected'}`} onPress={onPress} style={styles.accountField}>
    <Text style={account ? styles.accountValue : styles.accountPlaceholder}>{account ? `${account.code} · ${account.name}` : 'Select an account'}</Text>
    <Ionicons name="chevron-down" size={18} style={styles.accountChevron} />
  </Pressable></View>;
}

function AccountPickerModal({ visible, title, accounts, selectedId, excludedId, onClose, onSelect, styles, theme }: { visible: boolean; title: string; accounts: SyncCorrectionAccount[]; selectedId: string; excludedId: string; onClose: () => void; onSelect: (account: SyncCorrectionAccount) => void; styles: any; theme: any }) {
  const choices = accounts.filter((account) => account.id !== excludedId);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
      <View style={styles.modalHeader}><Text style={styles.modalTitle}>{title}</Text><Pressable accessibilityRole="button" accessibilityLabel="Close account picker" onPress={onClose} style={styles.closeButton}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable></View>
      <Text style={styles.modalHint}>Only active accounts from this Business Account are available.</Text>
      <ScrollView contentContainerStyle={styles.accountList}>
        {choices.map((account) => <Pressable key={account.id} accessibilityRole="button" onPress={() => onSelect(account)} style={[styles.accountOption, account.id === selectedId && styles.accountOptionSelected]}>
          <View style={{ flex: 1 }}><Text style={styles.accountOptionTitle}>{account.code} · {account.name}</Text><Text style={styles.accountOptionType}>{account.type}</Text></View>
          {account.id === selectedId ? <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} /> : null}
        </Pressable>)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

function Field({ label, styles, theme, ...props }: any) { return <View><Text style={styles.label}>{label}</Text><TextInput {...props} autoCapitalize="none" placeholderTextColor={theme.color.muted} style={styles.input} /></View>; }
const makeStyles = (theme: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { padding: 18, paddingBottom: 50 },
  card: { gap: 12, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.lg, padding: 18 },
  warning: { color: theme.color.muted, lineHeight: 19 },
  error: { color: theme.color.danger || '#c53b3b', lineHeight: 19 },
  loading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  label: { color: theme.color.onSurface, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: { color: theme.color.onSurface, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 },
  accountField: { minHeight: 48, flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 11 },
  accountValue: { flex: 1, color: theme.color.onSurface, fontWeight: '600' },
  accountPlaceholder: { flex: 1, color: theme.color.muted },
  accountChevron: { color: theme.color.muted },
  submit: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  disabled: { opacity: 0.45 },
  submitText: { color: theme.color.onBrandPrimary, fontWeight: '700' },
  modalContainer: { flex: 1, backgroundColor: theme.color.surface },
  modalHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  modalTitle: { flex: 1, color: theme.color.onSurface, fontSize: 18, fontWeight: '700', textTransform: 'capitalize' },
  closeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  modalHint: { color: theme.color.muted, lineHeight: 19, paddingHorizontal: 18, paddingTop: 14 },
  accountList: { padding: 18, gap: 10, paddingBottom: 40 },
  accountOption: { minHeight: 58, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  accountOptionSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceSecondary },
  accountOptionTitle: { color: theme.color.onSurface, fontWeight: '700' },
  accountOptionType: { color: theme.color.muted, fontSize: 12, marginTop: 3, textTransform: 'capitalize' },
});
