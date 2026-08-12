import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '@/src/api';
import { Card, Empty } from '@/src/components/UI';
import { GlowPressable } from '@/src/components/GlowPressable';
import { FormField, FormActions } from '@/src/components/FormCard';
import { useTheme } from '@/src/context/ThemeContext';
import { fmt, shortDate } from '@/src/theme';
import { getCurrencySymbol } from '@/src/db/local';
import { isValidDateString, normalizeDateInput } from '@/src/utils/dateValidation';
import type { InvestorLedgerDetail, InvestorLedgerTransaction } from '@/src/accountingV2/investorLedgerService';
import { OpeningBalancesModal } from '@/src/components/OpeningBalancesModal';

type Action = 'deposit' | 'draw';
const actionMeta = {
  deposit: { title: 'Add Capital', subtitle: 'Debit Cash · Credit Capital Accounts', icon: 'arrow-down-circle-outline' as const },
  draw: { title: 'Withdraw Capital', subtitle: 'Debit Capital Withdrawals · Credit Cash', icon: 'arrow-up-circle-outline' as const },
};

export default function InvestorDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[]; action?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const requestedAction = Array.isArray(params.action) ? params.action[0] : params.action;
  const [data, setData] = useState<InvestorLedgerDetail | null>(null);
  const [currency, setCurrency] = useState('$');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [openingVisible, setOpeningVisible] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError('');
    try {
      const [settings, config] = await Promise.all([api.getSettings(), api.getV2BookConfig()]);
      if (config?.style !== 'retail_partnership') {
        router.replace('/(tabs)/suppliers' as any);
        return;
      }
      const detail = await api.getInvestorLedger(id);
      setData(detail);
      setCurrency(getCurrencySymbol(settings.currency || 'USD'));
    } catch (e: any) {
      setError(e?.message || 'Could not load this capital statement.');
    } finally { setLoading(false); }
  }, [id, router]);

  useFocusEffect(useCallback(() => { setLoading(true); load(); }, [load]));

  // Quick action from the Parties list ("+ Capital"): auto-open the SAME
  // Deposit Capital sheet the on-screen button uses, then consume the param.
  React.useEffect(() => {
    if (requestedAction === 'deposit' || requestedAction === 'draw') {
      setAction(requestedAction);
      router.setParams({ action: undefined } as any);
    }
  }, [requestedAction, router]);

  const closeForm = () => { setAction(null); setEditSourceId(null); setAmount(''); setNotes(''); setFormError(''); };
  const editTransaction = (item: InvestorLedgerTransaction) => {
    if (item.type === 'opening_capital') { setOpeningVisible(true); return; }
    if (item.type !== 'capital_injection') return;
    setEditSourceId(item.id);
    setAction('deposit');
    setAmount(String(item.amount));
    setDate(item.date);
    setNotes(item.notes || '');
  };
  const deleteCapital = (item: InvestorLedgerTransaction) => {
    if (!id || item.type !== 'capital_injection') return;
    Alert.alert('Reverse added capital?', 'The amount will be removed from cash and the capital account with an equal reversal. The audit trail is retained.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reverse', style: 'destructive', onPress: async () => {
        try { await api.deleteInvestorCapital(id, item.id); setLoading(true); await load(); }
        catch (e: any) { Alert.alert('Could not reverse deposit', e?.message || 'Please try again.'); }
      } },
    ]);
  };
  const save = async () => {
    if (!id || !action) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { setFormError('Enter an amount greater than zero.'); return; }
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setFormError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    setSaving(true); setFormError('');
    try {
      const input = { amount: value, date: dateIso, notes: notes.trim() };
      if (action === 'deposit' && editSourceId) await api.updateInvestorCapital(id, editSourceId, input);
      else if (action === 'deposit') await api.depositInvestorCapital(id, input);
      else await api.drawInvestorFunds(id, input);
      closeForm();
      setLoading(true);
      await load();
    } catch (e: any) { setFormError(e?.message || 'Could not post this transaction.'); }
    finally { setSaving(false); }
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 64 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back to Accounts" onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{data?.name || 'Capital Statement'}</Text>
          {data ? <Text style={styles.headerSub}>{data.profitSharePct}% profit share · Active period</Text> : null}
        </View>
      </View>

      {error || !data ? (
        <Empty icon={<Ionicons name="alert-circle-outline" size={40} color={theme.color.error} />} title="Capital statement unavailable" hint={error || 'Capital account not found.'} />
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.hero}>
            <Text style={styles.heroLabel}>CURRENT CAPITAL BALANCE</Text>
            <Text style={styles.heroValue}>{fmt(data.currentCapitalBalance, currency)}</Text>
            <Text style={styles.heroHint}>Opening + capital added + profit share − capital withdrawn</Text>
          </View>

          <View style={styles.statsRow}>
            <Summary label="Capital Added" value={fmt(data.totalInjected, currency)} color={theme.color.success} icon="arrow-down" styles={styles} />
            <Summary label="Capital Withdrawn" value={fmt(data.totalDrawings, currency)} color={theme.color.warning} icon="arrow-up" styles={styles} />
            <Summary label="Profit Share" value={fmt(data.profitShare, currency)} color={data.profitShare < 0 ? theme.color.error : theme.color.brandPrimary} icon="pie-chart-outline" styles={styles} />
          </View>

          <View style={styles.actionsRow}>
            <GlowPressable testID="investor-deposit-capital" haptic prominent onPress={() => setAction('deposit')} style={[styles.actionButton, { backgroundColor: theme.color.success }]}>
              <Ionicons name="add-circle-outline" size={20} color="#fff" /><Text style={styles.actionText}>Add Capital</Text>
            </GlowPressable>
            <GlowPressable testID="investor-draw-funds" haptic onPress={() => setAction('draw')} style={[styles.actionButton, styles.drawButton]}>
              <Ionicons name="remove-circle-outline" size={20} color={theme.color.warning} /><Text style={[styles.actionText, { color: theme.color.warning }]}>Withdraw Capital</Text>
            </GlowPressable>
          </View>

          <Card style={styles.ledgerCard}>
            <View style={styles.sectionHeader}>
              <View><Text style={styles.sectionTitle}>Transaction Ledger</Text><Text style={styles.sectionSub}>{shortDate(data.periodStart)} – {shortDate(data.periodEnd)}</Text></View>
              <View style={styles.countBadge}><Text style={styles.countText}>{data.transactions.length}</Text></View>
            </View>
            {data.transactions.length ? data.transactions.map((item, index) => (
              <TransactionRow key={item.id} item={item} currency={currency} isLast={index === data.transactions.length - 1} theme={theme} styles={styles} onEdit={editTransaction} onDelete={deleteCapital} />
            )) : <Empty title="No capital activity yet" hint="Capital added, capital withdrawn, and profit share will appear here." />}
          </Card>
          <View style={{ height: 48 }} />
        </ScrollView>
      )}

      <Modal visible={action !== null} transparent animationType={Platform.OS === 'web' ? 'fade' : 'slide'} onRequestClose={closeForm}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
              <View style={styles.sheetHandle} />
              {action ? <>
              <View style={styles.sheetTitleRow}>
                <View style={styles.sheetIcon}><Ionicons name={actionMeta[action].icon} size={22} color={theme.color.brandPrimary} /></View>
                <View style={{ flex: 1 }}><Text style={styles.sheetTitle}>{editSourceId ? 'Edit Added Capital' : actionMeta[action].title}</Text><Text style={styles.sheetSub}>{actionMeta[action].subtitle}</Text></View>
                <Pressable onPress={closeForm}><Ionicons name="close" size={24} color={theme.color.muted} /></Pressable>
              </View>
              <FormField label="Amount" first testID="investor-action-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
              <FormField label="Date" value={date} onChangeText={setDate} autoCapitalize="none" placeholder="YYYY-MM-DD" />
              <FormField label="Notes" multiline value={notes} onChangeText={setNotes} placeholder="Optional transaction note" />
              <FormActions
                primaryLabel={editSourceId ? 'Save Correction' : `Post ${actionMeta[action].title}`}
                primaryTestID="investor-action-save"
                onPrimary={save}
                primaryBusy={saving}
                error={formError}
              />
              </> : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <OpeningBalancesModal visible={openingVisible} mode="investor" onClose={() => setOpeningVisible(false)} onSuccess={() => { setOpeningVisible(false); setLoading(true); load(); }} />
    </SafeAreaView>
  );
}

function Summary({ label, value, color, icon, styles }: any) {
  return <View style={styles.summary}><Ionicons name={icon} size={17} color={color} /><Text style={styles.summaryLabel}>{label}</Text><Text numberOfLines={1} adjustsFontSizeToFit style={[styles.summaryValue, { color }]}>{value}</Text></View>;
}

function TransactionRow({ item, currency, isLast, theme, styles, onEdit, onDelete }: { item: InvestorLedgerTransaction; currency: string; isLast: boolean; theme: any; styles: any; onEdit: (item: InvestorLedgerTransaction) => void; onDelete: (item: InvestorLedgerTransaction) => void }) {
  const drawing = item.type === 'drawing';
  const meta = item.type === 'capital_injection' ? { label: 'Capital Added', icon: 'arrow-down' as const, color: theme.color.success }
    : drawing ? { label: 'Capital Withdrawal', icon: 'arrow-up' as const, color: theme.color.warning }
    : item.type === 'profit_allocation' ? { label: 'Profit Allocation', icon: 'pie-chart-outline' as const, color: theme.color.brandPrimary }
    : { label: 'Opening Capital', icon: 'flag-outline' as const, color: theme.color.info };
  const correctable = item.type === 'capital_injection' || item.type === 'opening_capital';
  return <Pressable onPress={() => correctable && onEdit(item)} style={[styles.txRow, !isLast && styles.txDivider]}>
    <View style={[styles.txIcon, { backgroundColor: meta.color + '18' }]}><Ionicons name={meta.icon} size={17} color={meta.color} /></View>
    <View style={{ flex: 1 }}><Text style={styles.txTitle}>{meta.label}</Text><Text numberOfLines={1} style={styles.txNote}>{shortDate(item.date)} · {item.notes}</Text></View>
    <View style={{ alignItems: 'flex-end', gap: 6 }}>
      <Text style={[styles.txAmount, { color: drawing ? theme.color.warning : meta.color }]}>{drawing ? '−' : '+'}{fmt(item.amount, currency)}</Text>
      {correctable ? <View style={{ flexDirection: 'row', gap: 10 }}><Ionicons name="pencil-outline" size={15} color={theme.color.muted} />{item.type === 'capital_injection' ? <Pressable hitSlop={8} onPress={(event) => { event.stopPropagation(); onDelete(item); }}><Ionicons name="trash-outline" size={15} color={theme.color.error} /></Pressable> : null}</View> : null}
    </View>
  </Pressable>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
  headerTitle: { fontSize: 20, fontWeight: '800', color: theme.color.onSurface },
  headerSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  content: { padding: 18, gap: 16 },
  hero: { padding: 22, borderRadius: theme.radius.hero, backgroundColor: theme.color.brandPrimary, shadowColor: theme.color.brandPrimary, shadowOpacity: .25, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  heroLabel: { fontSize: 11, fontWeight: '800', letterSpacing: .6, color: theme.color.onBrandPrimary, opacity: .8 },
  heroValue: { fontSize: 34, fontWeight: '900', color: theme.color.onBrandPrimary, marginTop: 8, letterSpacing: -1 },
  heroHint: { fontSize: 12, color: theme.color.onBrandPrimary, opacity: .72, marginTop: 5 },
  statsRow: { flexDirection: 'row', gap: 8 },
  summary: { flex: 1, minWidth: 0, padding: 12, borderRadius: theme.radius.kpi, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
  summaryLabel: { fontSize: 10, color: theme.color.muted, marginTop: 8, fontWeight: '600' },
  summaryValue: { fontSize: 14, color: theme.color.onSurface, marginTop: 4, fontWeight: '800' },
  actionsRow: { flexDirection: 'row', gap: 10 },
  actionButton: { flex: 1, minHeight: 50, borderRadius: theme.radius.button, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 10 },
  drawButton: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.warning },
  actionText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  ledgerCard: { padding: 0, overflow: 'hidden' },
  sectionHeader: { padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: theme.color.border },
  sectionTitle: { fontSize: 17, fontWeight: '800', color: theme.color.onSurface },
  sectionSub: { fontSize: 11, color: theme.color.muted, marginTop: 3 },
  countBadge: { minWidth: 28, height: 28, borderRadius: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.brandPrimary + '18' },
  countText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800' },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginHorizontal: 16, paddingVertical: 14 },
  txDivider: { borderBottomWidth: 1, borderBottomColor: theme.color.divider },
  txIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  txTitle: { fontSize: 13, fontWeight: '700', color: theme.color.onSurface },
  txNote: { fontSize: 11, color: theme.color.muted, marginTop: 3 },
  txAmount: { fontSize: 13, fontWeight: '800' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.56)' },
  sheet: { maxHeight: '88%', backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, padding: 22, paddingBottom: Platform.OS === 'ios' ? 38 : 24, borderWidth: 1, borderColor: theme.color.border },
  sheetHandle: { width: 42, height: 4, borderRadius: 2, backgroundColor: theme.color.borderStrong, alignSelf: 'center', marginBottom: 18 },
  sheetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 18 },
  sheetIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.color.brandPrimary + '18', alignItems: 'center', justifyContent: 'center' },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: theme.color.onSurface },
  sheetSub: { fontSize: 11, color: theme.color.muted, marginTop: 3 },
}); }
