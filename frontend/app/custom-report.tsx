import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Share, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { v2ReportsOrFallback } from '@/src/accountingV2/runtime';
import { buildCustomReport, customReportText, CUSTOM_REPORT_FIELDS, type CustomReportField, type CustomReportGroup, type CustomReportSectionId } from '@/src/accountingV2/customReports';
import { buildStatementDocument } from '@/src/utils/statementDocument';
import { isValidDateString, normalizeDateInput } from '@/src/utils/dateValidation';

const SECTIONS = ['Trial Balance', 'Profit & Loss', 'Balance Sheet', 'Sales', 'Purchases', 'Receipts', 'Expenses', 'Inventory & COGS', 'Debtors', 'Creditors'] as const;
const SECTION_IDS: Record<string, CustomReportSectionId> = { 'Trial Balance': 'trialBalance', 'Profit & Loss': 'profit', 'Balance Sheet': 'balanceSheet', Sales: 'sales', Purchases: 'purchases', Receipts: 'receipts', Expenses: 'expenses', 'Inventory & COGS': 'inventory', Debtors: 'debtors', Creditors: 'creditors' };
const FIELD_LABELS: Record<CustomReportField, string> = { date: 'Date', memo: 'Notes', reference: 'Reference', accountCode: 'Account code', accountName: 'Account', partyId: 'Party', debit: 'Debit', credit: 'Credit', amount: 'Amount', revenue: 'Revenue', expenses: 'Expenses', netProfit: 'Net profit', assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity' };
type LegacyReports = { pnl: any; balanceSheet: any; trialBalance: any; sales: any; receipts: any; debtors: any[]; creditors: any[] };
const amount = (value: unknown) => Number(value || 0).toFixed(2);

export default function CustomReportScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [selected, setSelected] = useState<string[]>(['Trial Balance', 'Profit & Loss', 'Balance Sheet']);
  const [fields, setFields] = useState<CustomReportField[]>([...CUSTOM_REPORT_FIELDS]);
  const [groupBy, setGroupBy] = useState<CustomReportGroup>('none');
  const [landscape, setLandscape] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const [dateError, setDateError] = useState('');
  const toggle = (section: string) => setSelected((current) => current.includes(section) ? current.filter((value) => value !== section) : [...current, section]);

  const loadLegacy = async (fromIso: string, toIso: string): Promise<LegacyReports> => {
    const [pnl, balanceSheet, trialBalance, sales, receipts, debtors, creditors] = await Promise.all([
      api.pnlRange(fromIso, toIso), api.balanceSheet(), api.trialBalance(), api.salesRegister(fromIso, toIso),
      api.receiptsRegister(fromIso, toIso), api.debtorsReport(fromIso, toIso), api.creditorsReport(fromIso, toIso),
    ]);
    return { pnl, balanceSheet, trialBalance, sales, receipts, debtors, creditors };
  };

  const generate = async (): Promise<string> => {
    // Manual range inputs: normalize (Samsung minus signs, DD/MM, dots, exotic
    // digits) then validate, reflecting the canonical form back into the fields.
    const fromIso = normalizeDateInput(from);
    if (!isValidDateString(fromIso)) { setDateError(`Couldn't read "${from.trim()}" as a date. Please use YYYY-MM-DD.`); return ''; }
    const toIso = normalizeDateInput(to);
    if (!isValidDateString(toIso)) { setDateError(`Couldn't read "${to.trim()}" as a date. Please use YYYY-MM-DD.`); return ''; }
    setDateError('');
    setFrom(fromIso); setTo(toIso);
    setBusy(true);
    try {
      const result = await v2ReportsOrFallback({ from: fromIso, to: toIso }, () => loadLegacy(fromIso, toIso));
      const lines = ['Ledgr Custom Report', `Period: ${fromIso} to ${toIso}`, `Source: ${result.source === 'v2' ? 'V2 journal' : 'Legacy reports'}`, ''];
      if (result.source === 'v2') {
        const output = buildCustomReport(result.report, { sections: selected.map((section) => SECTION_IDS[section]), fields, groupBy, sortBy: 'date', sortDirection: 'asc' });
        const text = customReportText(output);
        setPreview(text);
        return text;
      } else {
        const { pnl, balanceSheet, trialBalance, sales, receipts, debtors, creditors } = result.report;
        if (selected.includes('Trial Balance')) lines.push(`TRIAL BALANCE\nDebits\n${trialBalance.debits.map((x: any) => `${x.account}: ${amount(x.amount)}`).join('\n') || 'None'}\nCredits\n${trialBalance.credits.map((x: any) => `${x.account}: ${amount(x.amount)}`).join('\n') || 'None'}`);
        if (selected.includes('Profit & Loss')) lines.push(`PROFIT & LOSS\nRevenue: ${amount(pnl.revenue ?? pnl.sales)}\nPurchases: ${amount(pnl.purchases)}\nExpenses: ${amount(pnl.expenses)}\nNet profit: ${amount(pnl.netProfit)}`);
        if (selected.includes('Balance Sheet')) lines.push(`BALANCE SHEET\nAssets: ${amount(balanceSheet.assets?.total)}\nLiabilities: ${amount(balanceSheet.liabilities?.total)}\nEquity: ${amount(balanceSheet.equity)}`);
        if (selected.includes('Sales')) lines.push(`SALES\nTotal: ${amount(sales.total)}\nCash: ${amount(sales.cashTotal)}\nCredit invoices: ${amount(sales.invoiceTotal)}`);
        if (selected.includes('Receipts')) lines.push(`RECEIPTS\nTotal received: ${amount(receipts.total)}`);
        if (selected.includes('Purchases')) lines.push(`PURCHASES\n${amount(pnl.purchases)}`);
        if (selected.includes('Expenses')) lines.push(`EXPENSES\n${amount(pnl.expenses)}`);
        if (selected.includes('Inventory & COGS')) lines.push(`INVENTORY & COGS\nOpening: ${amount(pnl.openingStock)}\nClosing: ${amount(pnl.closingStock)}\nCOGS: ${amount(pnl.cogs)}`);
        if (selected.includes('Debtors')) lines.push(`DEBTORS\n${debtors.map((x: any) => `${x.name}: ${amount(x.balance)}`).join('\n') || 'None'}`);
        if (selected.includes('Creditors')) lines.push(`CREDITORS\n${creditors.map((x: any) => `${x.name}: ${amount(x.balance)}`).join('\n') || 'None'}`);
      }
      const text = lines.join('\n\n');
      setPreview(text);
      return text;
    } finally { setBusy(false); }
  };

  const buildStyledHtml = (text: string, businessName = "Ledgr") => buildStatementDocument({
    businessName,
    title: "Custom Financial Statement",
    from,
    to,
    text,
    accent: theme.color.brandPrimary,
    landscape,
  });

  const pdf = async () => {
    const text = preview || await generate();
    if (!text) return; // invalid range input — error already shown inline
    const settings: any = await api.getSettings().catch(() => ({}));
    const { uri } = await Print.printToFileAsync({ html: buildStyledHtml(text, String(settings.businessName || settings.name || 'Ledgr')) });
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Custom Report' });
  };

  return <SafeAreaView style={styles.container}><View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface}/></Pressable><Text style={styles.title}>Custom Report</Text><View style={{ width: 26 }}/></View><ScrollView contentContainerStyle={styles.content}><Text style={styles.hint}>Financial statements use the persistent V2 journal when available, with automatic legacy fallback. Generate, print, or share through other apps.</Text><View style={styles.dates}><TextInput value={from} onChangeText={setFrom} onBlur={() => { if (from.trim()) setFrom(normalizeDateInput(from)); }} autoCapitalize="none" style={styles.input} placeholder="From YYYY-MM-DD"/><TextInput value={to} onChangeText={setTo} onBlur={() => { if (to.trim()) setTo(normalizeDateInput(to)); }} autoCapitalize="none" style={styles.input} placeholder="To YYYY-MM-DD"/>{dateError ? <Text style={{ color: theme.color.error, fontSize: 12 }}>{dateError}</Text> : null}</View><Text style={styles.section}>Include sections</Text><View style={styles.chips}>{SECTIONS.map((section) => <Pressable key={section} onPress={() => toggle(section)} style={[styles.chip, selected.includes(section) && styles.chipOn]}><Ionicons name={selected.includes(section) ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={selected.includes(section) ? '#fff' : theme.color.muted}/><Text style={[styles.chipText, selected.includes(section) && { color: '#fff' }]}>{section}</Text></Pressable>)}</View><Text style={styles.section}>Fields</Text><View style={styles.chips}>{CUSTOM_REPORT_FIELDS.map((field) => <Pressable key={field} onPress={() => setFields((current) => current.includes(field) ? current.filter((value) => value !== field) : [...current, field])} style={[styles.chip, fields.includes(field) && styles.chipOn]}><Text style={[styles.chipText, fields.includes(field) && { color: '#fff' }]}>{FIELD_LABELS[field]}</Text></Pressable>)}</View><Text style={styles.section}>Group by</Text><View style={styles.chips}>{(['none', 'day', 'month', 'account', 'party'] as CustomReportGroup[]).map((group) => <Pressable key={group} onPress={() => setGroupBy(group)} style={[styles.chip, groupBy === group && styles.chipOn]}><Text style={[styles.chipText, groupBy === group && { color: '#fff' }]}>{group === 'none' ? 'No grouping' : group}</Text></Pressable>)}</View><Text style={styles.section}>PDF orientation</Text><View style={styles.chips}>{[false, true].map((wide) => <Pressable key={String(wide)} onPress={() => setLandscape(wide)} style={[styles.chip, landscape === wide && styles.chipOn]}><Text style={[styles.chipText, landscape === wide && { color: '#fff' }]}>{wide ? 'Landscape' : 'Portrait'}</Text></Pressable>)}</View><Pressable onPress={generate} style={styles.primary}>{busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryText}>Generate Preview</Text>}</Pressable>{preview ? <><CustomReportPreview text={preview} styles={styles} theme={theme}/><View style={styles.actions}><Pressable onPress={() => Share.share({ message: preview, title: 'Ledgr Custom Report' })} style={styles.secondary}><Ionicons name="share-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>Share text</Text></Pressable><Pressable onPress={pdf} style={styles.secondary}><Ionicons name="document-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>PDF / Print</Text></Pressable></View></> : null}</ScrollView></SafeAreaView>;
}

function CustomReportPreview({ text, styles, theme }: { text: string; styles: any; theme: any }) {
  const sections: { title: string; rows: string[] }[] = [];
  let current: { title: string; rows: string[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Ledgr Custom Report$/i.test(line) || /^Period:/i.test(line) || /^Source:/i.test(line)) continue;
    const heading = line === line.toUpperCase() && /[A-Z]/.test(line) && !line.includes(':');
    if (heading) { current = { title: line, rows: [] }; sections.push(current); }
    else { if (!current) { current = { title: 'REPORT', rows: [] }; sections.push(current); } current.rows.push(line); }
  }
  const renderRow = (line: string, index: number) => {
    const fields = Object.fromEntries(line.split('|').map((part) => { const i = part.indexOf(':'); return i > -1 ? [part.slice(0, i).trim(), part.slice(i + 1).trim()] : ['detail', part.trim()]; }));
    if (fields.accountName) {
      const value = [fields.debit && `Dr ${fields.debit}`, fields.credit && `Cr ${fields.credit}`].filter(Boolean).join(' · ');
      return <View key={`${line}-${index}`} style={styles.previewRow}><Text style={styles.previewKey}>{fields.accountName}{fields.accountCode ? ` (${fields.accountCode})` : ''}</Text><Text style={styles.previewValue}>{value || '—'}</Text></View>;
    }
    const first = line.indexOf(':');
    if (first > -1 && !line.includes('|')) return <View key={`${line}-${index}`} style={styles.previewRow}><Text style={styles.previewKey}>{line.slice(0, first).trim()}</Text><Text style={styles.previewValue}>{line.slice(first + 1).trim()}</Text></View>;
    return <Text key={`${line}-${index}`} style={styles.previewDetail}>{line.replace(/\|/g, ' · ')}</Text>;
  };
  return <View style={styles.preview}>
    {sections.map((section) => <View key={section.title} style={styles.previewSection}><Text style={[styles.previewHeader, { color: theme.color.brandPrimary }]}>{section.title}</Text>{section.rows.map(renderRow)}</View>)}
  </View>;
}
function makeStyles(t: any) { return StyleSheet.create({ container: { flex: 1, backgroundColor: t.color.surface }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: t.spacing.lg, borderBottomWidth: 1, borderColor: t.color.border }, title: { fontSize: 18, fontWeight: '800', color: t.color.onSurface }, content: { padding: t.spacing.lg, paddingBottom: 80 }, hint: { color: t.color.muted, lineHeight: 21 }, dates: { gap: 10, marginTop: 18 }, input: { backgroundColor: t.color.surfaceSecondary, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.md, padding: 13, color: t.color.onSurface }, section: { fontSize: 15, fontWeight: '700', color: t.color.onSurface, marginTop: 22, marginBottom: 10 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: t.color.border, borderRadius: 999, backgroundColor: t.color.surfaceSecondary }, chipOn: { backgroundColor: t.color.brandPrimary, borderColor: t.color.brandPrimary }, chipText: { fontSize: 13, fontWeight: '600', color: t.color.onSurface }, primary: { marginTop: 24, backgroundColor: t.color.brandPrimary, borderRadius: t.radius.md, padding: 15, alignItems: 'center' }, primaryText: { color: '#fff', fontWeight: '800' }, preview: { marginTop: 20, padding: 14, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.lg, backgroundColor: t.color.surfaceSecondary }, previewText: { color: t.color.onSurface, lineHeight: 20 }, previewSection: { marginBottom: 15 }, previewHeader: { fontSize: 12, fontWeight: '800', letterSpacing: .6, marginBottom: 6 }, previewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.color.border }, previewKey: { flex: 1, color: t.color.onSurface, fontSize: 12, fontWeight: '600' }, previewValue: { color: t.color.muted, fontSize: 11, textAlign: 'right', maxWidth: '48%' }, previewDetail: { color: t.color.muted, fontSize: 11, lineHeight: 16, paddingVertical: 4 }, actions: { flexDirection: 'row', gap: 10, marginTop: 12 }, secondary: { flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', alignItems: 'center', padding: 13, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.border }, secondaryText: { fontWeight: '700', color: t.color.brandPrimary } }); }
