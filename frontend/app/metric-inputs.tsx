import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { eligibleMetrics, activePersonaFor } from '@/src/utils/capabilities';
import { GlowPressable } from '@/src/components/GlowPressable';

type InputKey = 'acquisitionSpend' | 'newCustomers' | 'returnedOrders' | 'shippedOrders' | 'investmentReturn' | 'investmentCost' | 'priceToEarnings' | 'expectedGrowthPercent';
type MetricInput = { key: InputKey; label: string; placeholder: string; hint: string; group: 'CAC' | 'RTO' | 'ROI' | 'PEG' };

const INPUTS: MetricInput[] = [
  { key: 'acquisitionSpend', label: 'Acquisition spend', placeholder: '0.00', hint: 'Paid marketing and campaign spend for the selected period.', group: 'CAC' },
  { key: 'newCustomers', label: 'New customers', placeholder: '0', hint: 'New customers attributed to the same acquisition period.', group: 'CAC' },
  { key: 'returnedOrders', label: 'Returned-to-origin orders', placeholder: '0', hint: 'Orders returned to origin or failed delivery outcomes.', group: 'RTO' },
  { key: 'shippedOrders', label: 'Shipped orders', placeholder: '0', hint: 'Orders shipped in the same period.', group: 'RTO' },
  { key: 'investmentReturn', label: 'Attributable return', placeholder: '0.00', hint: 'Revenue or return attributable to the investment or campaign.', group: 'ROI' },
  { key: 'investmentCost', label: 'Investment cost', placeholder: '0.00', hint: 'The cost of the investment, campaign, or initiative.', group: 'ROI' },
  { key: 'priceToEarnings', label: 'Price-to-earnings ratio', placeholder: '0.00', hint: 'Valuation multiple used for the PEG calculation.', group: 'PEG' },
  { key: 'expectedGrowthPercent', label: 'Expected earnings growth (%)', placeholder: '0.00', hint: 'Expected earnings growth percentage for the same forecast period.', group: 'PEG' },
];

export default function MetricInputsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [settings, setSettings] = useState<any>({});
  const [values, setValues] = useState<Record<InputKey, string>>({} as Record<InputKey, string>);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await api.getSettings();
      setSettings(current || {});
      const saved = current?.workspaceMetricInputs || {};
      setValues(Object.fromEntries(INPUTS.map((input) => [input.key, saved[input.key] == null ? '' : String(saved[input.key])])) as Record<InputKey, string>);
    } catch (error) {
      console.warn('Failed to load metric inputs', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const enabledMetricKeys = new Set(eligibleMetrics(settings).map((metric) => metric.key));
  const visibleGroups = new Set((['CAC', 'RTO', 'ROI', 'PEG'] as const).filter((group) => {
    const key = group === 'CAC' ? 'cac' : group === 'RTO' ? 'rto' : group === 'ROI' ? 'roi' : 'peg';
    return enabledMetricKeys.has(key);
  }));

  const save = async () => {
    setSaving(true); setStatus('');
    try {
      const normalized = Object.fromEntries(INPUTS.map((input) => [input.key, values[input.key].trim() === '' ? null : Number(values[input.key])])) as Record<InputKey, number | null>;
      const invalid = Object.values(normalized).some((value) => value !== null && !Number.isFinite(value));
      if (invalid) { setStatus('Enter numbers only, or leave a field blank.'); return; }
      await api.updateSettings({ workspaceMetricInputs: normalized });
      setStatus('Metric inputs saved. Home and Reports will recalculate on refresh.');
    } catch (error: any) {
      setStatus(error?.message || 'Could not save metric inputs.');
    } finally { setSaving(false); }
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  return <SafeAreaView style={styles.container} edges={['top']}>
    <View style={styles.header}><GlowPressable topHighlight={false} animateBorder={false} restingBorderColor="transparent" onPress={() => router.back()} accessibilityLabel="Back to settings" style={styles.back}><Ionicons name="arrow-back" size={22} color={theme.color.onSurface} /></GlowPressable><View style={{ flex: 1 }}><Text style={styles.title}>Metric inputs</Text><Text style={styles.subtitle}>Workspace: {activePersonaFor(settings).replace(/_/g, ' ')}</Text></View><GlowPressable topHighlight={false} haptic onPress={save} disabled={saving} style={styles.save}>{saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.saveText}>Save</Text>}</GlowPressable></View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>Enter operational inputs that cannot be inferred reliably from ledger postings. COGS, gross margin, and ROE continue to derive from the authoritative ledger.</Text>
        {(['CAC', 'RTO', 'ROI', 'PEG'] as const).filter((group) => visibleGroups.has(group)).map((group) => <View key={group} style={styles.group}><Text style={styles.groupTitle}>{group}</Text>{INPUTS.filter((input) => input.group === group).map((input) => <View key={input.key} style={styles.field}><Text style={styles.label}>{input.label}</Text><TextInput value={values[input.key] || ''} onChangeText={(value) => setValues((current) => ({ ...current, [input.key]: value }))} keyboardType="decimal-pad" placeholder={input.placeholder} placeholderTextColor={theme.color.muted} style={styles.input} accessibilityLabel={input.label} /><Text style={styles.hint}>{input.hint}</Text></View>)}</View>)}
        {!visibleGroups.size && <View style={styles.empty}><Ionicons name="analytics-outline" size={30} color={theme.color.muted} /><Text style={styles.emptyTitle}>No optional metric inputs are enabled</Text><Text style={styles.emptyText}>Enable Growth Analytics for CAC, RTO, ROI, or PEG from Workspace Capabilities.</Text></View>}
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  back: { padding: 4 }, title: { color: theme.color.onSurface, fontSize: 17, fontWeight: '800' }, subtitle: { color: theme.color.muted, fontSize: 11, marginTop: 3, textTransform: 'capitalize' },
  save: { backgroundColor: theme.color.brandPrimary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 15 }, saveText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  content: { padding: 16, paddingBottom: 60 }, intro: { color: theme.color.muted, fontSize: 13, lineHeight: 19, marginBottom: 18 }, group: { marginBottom: 18 }, groupTitle: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '900', letterSpacing: 1.1, marginBottom: 10 }, field: { marginBottom: 13 }, label: { color: theme.color.onSurface, fontSize: 13, fontWeight: '800' }, input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 12, padding: 12, color: theme.color.onSurface, fontSize: 14 }, hint: { color: theme.color.muted, fontSize: 10, lineHeight: 14, marginTop: 4 }, status: { color: theme.color.brandPrimary, fontSize: 12, lineHeight: 17, paddingVertical: 12 }, empty: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 14, padding: 20, alignItems: 'center' }, emptyTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '800', marginTop: 8 }, emptyText: { color: theme.color.muted, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 5 },
}); }
