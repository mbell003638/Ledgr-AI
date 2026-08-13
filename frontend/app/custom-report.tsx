import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Share, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { v2Reports } from '@/src/accountingV2/runtime';
import { buildCustomReport, customReportBreakdownRows, summarizeCustomReport, CUSTOM_REPORT_FIELDS, type CustomReportBreakdown, type CustomReportDetailLevel, type CustomReportField, type CustomReportGroup, type CustomReportOutput, type CustomReportRow, type CustomReportSection, type CustomReportSectionId } from '@/src/accountingV2/customReports';
import { buildCustomReportHtml, buildPnlRows, customReportShareText, drCrLabel, registerRowLabel, registerRowValue, trialBalanceTotals, type CustomReportPnl } from '@/src/utils/customReportDocument';
import { money, symbolFor } from '@/src/utils/reportDocument';
import { printHtml } from '@/src/utils/print';
import { isValidDateString, normalizeDateInput, localTodayIso } from '@/src/utils/dateValidation';

const SECTIONS = ['Trial Balance', 'Profit & Loss', 'Balance Sheet', 'Sales', 'Purchases', 'Receipts', 'Expenses', 'Inventory & COGS', 'Customers', 'Suppliers', 'Capital Statement'] as const;
const SECTION_IDS: Record<string, CustomReportSectionId> = { 'Trial Balance': 'trialBalance', 'Profit & Loss': 'profit', 'Balance Sheet': 'balanceSheet', Sales: 'sales', Purchases: 'purchases', Receipts: 'receipts', Expenses: 'expenses', 'Inventory & COGS': 'inventory', Customers: 'debtors', Suppliers: 'creditors', 'Capital Statement': 'members' };
const FIELD_LABELS: Record<CustomReportField, string> = { date: 'Date', memo: 'Notes', reference: 'Reference', accountCode: 'Account code', accountName: 'Account', partyId: 'Business account', debit: 'Debit', credit: 'Credit', amount: 'Amount', revenue: 'Revenue', expenses: 'Expenses', netProfit: 'Net profit', assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity' };
type StructuredDoc = { output: CustomReportOutput; pnl: CustomReportPnl; summary: string };
type ReportMeta = { businessName: string; invoiceTheme: string; currencySymbol: string };
type GenResult = { text: string; doc: StructuredDoc; meta: ReportMeta } | null;
const DEFAULT_META: ReportMeta = { businessName: 'Ledgr', invoiceTheme: 'navy_gold', currencySymbol: '$' };

export default function CustomReportScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [from, setFrom] = useState(localTodayIso(new Date(new Date().getFullYear(), 0, 1)));
  const [to, setTo] = useState(localTodayIso());
  const [selected, setSelected] = useState<string[]>(['Trial Balance', 'Profit & Loss', 'Balance Sheet']);
  const [fields, setFields] = useState<CustomReportField[]>([...CUSTOM_REPORT_FIELDS]);
  const [groupBy, setGroupBy] = useState<CustomReportGroup>('none');
  const [detailLevel, setDetailLevel] = useState<CustomReportDetailLevel>('consolidated');
  const [landscape, setLandscape] = useState(false);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [preview, setPreview] = useState('');
  const [doc, setDoc] = useState<StructuredDoc | null>(null);
  const [meta, setMeta] = useState<ReportMeta>(DEFAULT_META);
  const [dateError, setDateError] = useState('');
  const toggle = (section: string) => setSelected((current) => current.includes(section) ? current.filter((value) => value !== section) : [...current, section]);

  const generate = async (): Promise<GenResult> => {
    // Manual range inputs: normalize (Samsung minus signs, DD/MM, dots, exotic
    // digits) then validate, reflecting the canonical form back into the fields.
    const fromIso = normalizeDateInput(from);
    if (!isValidDateString(fromIso)) { setDateError(`Couldn't read "${from.trim()}" as a date. Please use YYYY-MM-DD.`); return null; }
    const toIso = normalizeDateInput(to);
    if (!isValidDateString(toIso)) { setDateError(`Couldn't read "${to.trim()}" as a date. Please use YYYY-MM-DD.`); return null; }
    setDateError('');
    setFrom(fromIso); setTo(toIso);
    setBusy(true);
    try {
      const [result, settings] = await Promise.all([
        v2Reports({ from: fromIso, to: toIso }),
        api.getSettings().catch(() => ({} as any)),
      ]);
      const nextMeta: ReportMeta = {
        businessName: String((settings as any).businessName || (settings as any).name || 'Ledgr'),
        invoiceTheme: String((settings as any).invoiceTheme || 'navy_gold'),
        currencySymbol: symbolFor((settings as any).currency),
      };
      setMeta(nextMeta);
      const output = buildCustomReport(result.report, { sections: selected.map((section) => SECTION_IDS[section]), fields, groupBy, detailLevel, sortBy: 'date', sortDirection: 'asc' });
      const pnl: CustomReportPnl = { ...result.report.profitAndLoss };
      const summary = summarizeCustomReport(output);
      const nextDoc: StructuredDoc = { output, pnl, summary };
      const text = customReportShareText(output, { pnl, summary, currencySymbol: nextMeta.currencySymbol });
      setDoc(nextDoc);
      setPreview(text);
      return { text, doc: nextDoc, meta: nextMeta };
    } finally { setBusy(false); }
  };

  const ensureGenerated = async (): Promise<GenResult> => (preview && doc ? { text: preview, doc, meta } : await generate());

  const htmlFor = (result: NonNullable<GenResult>): string => buildCustomReportHtml({
        output: result.doc.output,
        pnl: result.doc.pnl,
        summary: result.doc.summary,
        businessName: result.meta.businessName,
        currencySymbol: result.meta.currencySymbol,
        from, to,
        generatedAt: new Date().toLocaleString(),
        landscape,
      }, result.meta.invoiceTheme);

  const pdf = async () => {
    const result = await ensureGenerated();
    if (!result) return; // invalid range input — error already shown inline
    const { uri } = await Print.printToFileAsync({ html: htmlFor(result) });
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Custom Report' });
  };

  const printReport = async () => {
    const result = await ensureGenerated();
    if (!result) return;
    setPrinting(true);
    try { await printHtml(htmlFor(result), 'Ledgr Custom Report'); }
    finally { setPrinting(false); }
  };

  return <SafeAreaView style={styles.container}><View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface}/></Pressable><Text style={styles.title}>Custom Report</Text><View style={{ width: 26 }}/></View><ScrollView contentContainerStyle={styles.content}><Text style={styles.hint}>Financial statements use the authoritative V2 journal. Generate, print, or share through other apps.</Text><View style={styles.dates}><TextInput value={from} onChangeText={setFrom} onBlur={() => { if (from.trim()) setFrom(normalizeDateInput(from)); }} autoCapitalize="none" style={styles.input} placeholder="From YYYY-MM-DD"/><TextInput value={to} onChangeText={setTo} onBlur={() => { if (to.trim()) setTo(normalizeDateInput(to)); }} autoCapitalize="none" style={styles.input} placeholder="To YYYY-MM-DD"/>{dateError ? <Text style={{ color: theme.color.error, fontSize: 12 }}>{dateError}</Text> : null}</View><Text style={styles.section}>Include sections</Text><View style={styles.chips}>{SECTIONS.map((section) => <Pressable key={section} onPress={() => toggle(section)} style={[styles.chip, selected.includes(section) && styles.chipOn]}><Ionicons name={selected.includes(section) ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={selected.includes(section) ? '#fff' : theme.color.muted}/><Text style={[styles.chipText, selected.includes(section) && { color: '#fff' }]}>{section}</Text></Pressable>)}</View><Text style={styles.section}>Fields</Text><View style={styles.chips}>{CUSTOM_REPORT_FIELDS.map((field) => <Pressable key={field} onPress={() => setFields((current) => current.includes(field) ? current.filter((value) => value !== field) : [...current, field])} style={[styles.chip, fields.includes(field) && styles.chipOn]}><Text style={[styles.chipText, fields.includes(field) && { color: '#fff' }]}>{FIELD_LABELS[field]}</Text></Pressable>)}</View><Text style={styles.section}>Report detail</Text><Text style={styles.hint}>Choose account totals, individual names, or both. Detailed subtotals must reconcile to the consolidated ledger.</Text><View style={styles.chips}>{(['consolidated', 'detailed', 'both'] as CustomReportDetailLevel[]).map((level) => <Pressable testID={`report-detail-${level}`} key={level} onPress={() => setDetailLevel(level)} style={[styles.chip, detailLevel === level && styles.chipOn]}><Text style={[styles.chipText, detailLevel === level && { color: '#fff' }]}>{level === 'consolidated' ? 'Consolidated' : level === 'detailed' ? 'Detailed' : 'Both'}</Text></Pressable>)}</View><Text style={styles.section}>Group transactions by</Text><View style={styles.chips}>{(['none', 'day', 'month', 'account', 'party'] as CustomReportGroup[]).map((group) => <Pressable key={group} onPress={() => setGroupBy(group)} style={[styles.chip, groupBy === group && styles.chipOn]}><Text style={[styles.chipText, groupBy === group && { color: '#fff' }]}>{group === 'none' ? 'No grouping' : group === 'party' ? 'Business account' : group}</Text></Pressable>)}</View><Text style={styles.section}>PDF orientation</Text><View style={styles.chips}>{[false, true].map((wide) => <Pressable key={String(wide)} onPress={() => setLandscape(wide)} style={[styles.chip, landscape === wide && styles.chipOn]}><Text style={[styles.chipText, landscape === wide && { color: '#fff' }]}>{wide ? 'Landscape' : 'Portrait'}</Text></Pressable>)}</View><Pressable onPress={generate} style={styles.primary}>{busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryText}>Generate Preview</Text>}</Pressable>{preview && doc ? <><StructuredPreview doc={doc} sym={meta.currencySymbol} styles={styles} theme={theme}/><View style={styles.actions}><Pressable testID="btn-custom-share-text" onPress={() => Share.share({ message: preview, title: 'Ledgr Custom Report' })} style={styles.secondary}><Ionicons name="share-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>Share text</Text></Pressable><Pressable testID="btn-custom-print" onPress={printReport} disabled={printing} style={styles.secondary}>{printing ? <ActivityIndicator color={theme.color.brandPrimary}/> : <><Ionicons name="print-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>Print</Text></>}</Pressable><Pressable testID="btn-custom-share-pdf" onPress={pdf} style={styles.secondary}><Ionicons name="document-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>PDF</Text></Pressable></View></> : null}</ScrollView></SafeAreaView>;
}

/**
 * Structured MINI preview in the app's approved report grammar (mirrors the
 * monthly-summary mini-preview): uppercase section labels, hairline-separated
 * label-left / monospace-value-right rows, a multi-row P&L hero card, a real
 * trial-balance listing with a bold totals row, grouped balance-sheet rows and
 * a prose summary card. Uses app theme tokens so it respects dark mode; the
 * PDF stays print-light with invoice-theme accents.
 */
function StructuredPreview({ doc, sym, styles, theme }: { doc: StructuredDoc; sym: string; styles: any; theme: any }) {
  const breakdownRows = (group: CustomReportBreakdown, useDrCr: boolean) => customReportBreakdownRows(group, doc.output.detailLevel).map((row, index) => (
    <View key={`${group.accountCode}-${row.kind}-${row.label}-${index}`} style={[styles.previewLineRow, row.kind === 'subtotal' && styles.previewTotalRow]}>
      <Text style={[styles.previewLineLabel, row.kind === 'detail' && styles.previewDetailLabel, row.kind === 'subtotal' && styles.previewTotalLabel]} numberOfLines={1}>
        {row.label}{row.accountCode && row.kind !== 'detail' ? ` (${row.accountCode})` : ''}
      </Text>
      <Text style={[styles.previewNum, row.kind === 'subtotal' && styles.previewTotalNum]}>{useDrCr ? drCrLabel(row, sym) : money(row.amount, sym)}</Text>
    </View>
  ));

  const renderBreakdownSection = (section: CustomReportSection) => (
    <View key={section.id} style={styles.previewSection} testID={`custom-report-${section.id}-breakdown`}>
      <Text style={styles.previewSectionLabel}>{section.title.toUpperCase()}</Text>
      {(section.breakdown || []).length ? section.breakdown!.map((group) => <View key={group.accountCode}>{breakdownRows(group, false)}</View>) : <Text style={styles.previewEmpty}>No entries</Text>}
    </View>
  );

  const renderProfit = (section: CustomReportSection) => (
    <View key={section.id} style={styles.previewSection}>
      <Text style={styles.previewSectionLabel}>{section.title.toUpperCase()}</Text>
      <View style={styles.previewHero} testID="custom-report-hero">
        {buildPnlRows(doc.pnl).map((row, index, all) => (
          <View key={row.label} style={[styles.previewHeroRow, index === all.length - 1 && styles.previewHeroRowLast]}>
            <Text style={[styles.previewHeroLabel, row.net && styles.previewHeroNetLabel]}>{row.label}</Text>
            <Text style={row.net ? styles.previewHeroNetValue : [styles.previewNum, row.strong && styles.previewTotalNum, row.amount < 0 && styles.previewNumNeg]}>{money(row.amount, sym)}</Text>
          </View>
        ))}
      </View>
    </View>
  );

  const renderTrialBalance = (section: CustomReportSection) => {
    const totals = trialBalanceTotals(section.rows);
    return (
      <View key={section.id} style={styles.previewSection} testID="custom-report-trial-balance">
        <Text style={styles.previewSectionLabel}>{section.title.toUpperCase()}</Text>
        {section.rows.length ? <>
          {section.rows.map((row, index) => {
            const breakdown = section.breakdown?.find((group) => group.accountCode === String(row.accountCode));
            if (breakdown && doc.output.detailLevel !== 'consolidated' && breakdown.items.length) {
              return <View key={`${row.accountCode ?? row.accountName ?? index}`}>{breakdownRows(breakdown, true)}</View>;
            }
            const zero = !Number(row.debit || 0) && !Number(row.credit || 0);
            return (
              <View key={`${row.accountCode ?? row.accountName ?? index}`} style={styles.previewLineRow}>
                <Text style={[styles.previewLineLabel, zero && styles.previewMuted]} numberOfLines={1}>{String(row.accountName || 'Account')}{row.accountCode !== undefined ? ` (${row.accountCode})` : ''}</Text>
                <Text style={[styles.previewNum, zero && styles.previewMuted]}>{drCrLabel(row, sym)}</Text>
              </View>
            );
          })}
          <View style={[styles.previewLineRow, styles.previewTotalRow]}>
            <Text style={[styles.previewLineLabel, styles.previewTotalLabel]}>Totals</Text>
            <Text style={[styles.previewNum, styles.previewTotalNum]}>{`Dr ${money(totals.debit, sym)} · Cr ${money(totals.credit, sym)}`}</Text>
          </View>
        </> : <Text style={styles.previewEmpty}>No entries</Text>}
      </View>
    );
  };

  const renderBalanceSheet = (section: CustomReportSection) => {
    const row = section.rows[0] || {};
    const groups = [
      { label: 'Assets', value: Number(row.assets || 0) },
      { label: 'Liabilities', value: Number(row.liabilities || 0) },
      { label: 'Equity', value: Number(row.equity || 0) },
    ];
    return (
      <View key={section.id} style={styles.previewSection} testID="custom-report-balance-sheet">
        <Text style={styles.previewSectionLabel}>{section.title.toUpperCase()}</Text>
        {groups.map((group) => (
          <View key={group.label} style={styles.previewLineRow}>
            <Text style={styles.previewLineLabel}>{group.label}</Text>
            <Text style={[styles.previewNum, group.value < 0 && styles.previewNumNeg]}>{money(group.value, sym)}</Text>
          </View>
        ))}
        {doc.output.detailLevel !== 'consolidated' && (section.breakdown || []).length ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <Text style={styles.previewGroupLabel}>ACCOUNT BREAKDOWN</Text>
            {section.breakdown!.map((group) => <View key={group.accountCode}>{breakdownRows(group, false)}</View>)}
          </View>
        ) : null}
        <View style={[styles.previewLineRow, styles.previewTotalRow]}>
          <Text style={[styles.previewLineLabel, styles.previewTotalLabel]}>Liabilities + Equity</Text>
          <Text style={[styles.previewNum, styles.previewTotalNum]}>{money(Number(row.liabilities || 0) + Number(row.equity || 0), sym)}</Text>
        </View>
      </View>
    );
  };

  const renderRegister = (section: CustomReportSection) => {
    const rowView = (row: CustomReportRow, index: number) => (
      <View key={index} style={styles.previewLineRow}>
        {row.date !== undefined ? <Text style={styles.previewDate}>{String(row.date)}</Text> : null}
        <Text style={styles.previewLineLabel} numberOfLines={1}>{registerRowLabel(row)}</Text>
        <Text style={styles.previewNum}>{registerRowValue(row, sym)}</Text>
      </View>
    );
    return (
      <View key={section.id} style={styles.previewSection}>
        <Text style={styles.previewSectionLabel}>{section.title.toUpperCase()}</Text>
        {section.rows.length ? <>
          {section.groups ? section.groups.map((group) => (
            <View key={group.key}>
              <Text style={styles.previewGroupLabel}>{group.key}</Text>
              {group.rows.map(rowView)}
              <View style={styles.previewLineRow}>
                <Text style={[styles.previewLineLabel, styles.previewMuted]}>Group total</Text>
                <Text style={[styles.previewNum, styles.previewMuted]}>{money(group.total, sym)}</Text>
              </View>
            </View>
          )) : section.rows.map(rowView)}
          {section.total !== undefined ? (
            <View style={[styles.previewLineRow, styles.previewTotalRow]}>
              <Text style={[styles.previewLineLabel, styles.previewTotalLabel]}>Total {section.title}</Text>
              <Text style={[styles.previewNum, styles.previewTotalNum]}>{money(Number(section.total || 0), sym)}</Text>
            </View>
          ) : null}
        </> : <Text style={styles.previewEmpty}>No entries</Text>}
      </View>
    );
  };

  return (
    <View style={styles.preview} testID="custom-report-preview">
      {doc.output.sections.map((section) => {
        if (section.id === 'profit') return renderProfit(section);
        if (section.id === 'trialBalance') return renderTrialBalance(section);
        if (section.id === 'balanceSheet') return renderBalanceSheet(section);
        if (section.id === 'debtors' || section.id === 'creditors' || section.id === 'members') return renderBreakdownSection(section);
        return renderRegister(section);
      })}
      {doc.summary ? (
        <View style={styles.summaryCard} testID="custom-report-summary">
          <Text style={styles.summaryHeading}>Summary</Text>
          <Text style={styles.summaryText}>{doc.summary}</Text>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(t: any) {
  const mono = 'monospace';
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: t.spacing.lg, borderBottomWidth: 1, borderColor: t.color.border },
    title: { fontSize: 18, fontWeight: '800', color: t.color.onSurface },
    content: { padding: t.spacing.lg, paddingBottom: 80 },
    hint: { color: t.color.muted, lineHeight: 21 },
    dates: { gap: 10, marginTop: 18 },
    input: { backgroundColor: t.color.surfaceSecondary, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.md, padding: 13, color: t.color.onSurface },
    section: { fontSize: 15, fontWeight: '700', color: t.color.onSurface, marginTop: 22, marginBottom: 10 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: t.color.border, borderRadius: 999, backgroundColor: t.color.surfaceSecondary },
    chipOn: { backgroundColor: t.color.brandPrimary, borderColor: t.color.brandPrimary },
    chipText: { fontSize: 13, fontWeight: '600', color: t.color.onSurface },
    primary: { marginTop: 24, backgroundColor: t.color.brandPrimary, borderRadius: t.radius.md, padding: 15, alignItems: 'center' },
    primaryText: { color: '#fff', fontWeight: '800' },

    // Preview container + report grammar (matches monthly-summary's mini preview).
    preview: { marginTop: 20, padding: 14, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.lg, backgroundColor: t.color.surfaceSecondary },
    previewSection: { marginBottom: 18 },
    previewSectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase', color: t.color.muted, marginBottom: 6 },
    previewDetailLabel: { paddingLeft: 16, color: t.color.muted },
    previewHero: { backgroundColor: t.color.successBg, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.color.divider, paddingHorizontal: t.spacing.md },
    previewHeroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.color.divider, gap: 12 },
    previewHeroRowLast: { borderBottomWidth: 0 },
    previewHeroLabel: { fontSize: 13, fontWeight: '700', color: t.color.onSurface, flexShrink: 1 },
    previewHeroNetLabel: { fontSize: 14 },
    previewHeroNetValue: { fontFamily: mono, fontSize: 20, fontWeight: '800', color: t.color.onSurface, textAlign: 'right' },
    previewLineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.color.divider, gap: 10 },
    previewLineLabel: { flex: 1, fontSize: 13, color: t.color.onSurface },
    previewNum: { fontFamily: mono, fontSize: 12, fontWeight: '600', color: t.color.onSurface, textAlign: 'right' },
    previewNumNeg: { color: t.color.error },
    previewMuted: { color: t.color.muted, fontWeight: '400' },
    previewDate: { fontFamily: mono, fontSize: 11, color: t.color.muted },
    previewGroupLabel: { fontSize: 11, fontWeight: '700', color: t.color.brandPrimary, marginTop: 8 },
    previewTotalRow: { borderBottomWidth: 0, borderTopWidth: 2, borderTopColor: t.color.onSurface, marginTop: 2 },
    previewTotalLabel: { fontWeight: '800' },
    previewTotalNum: { fontWeight: '800' },
    previewEmpty: { color: t.color.muted, fontSize: 12, paddingVertical: 6 },
    previewDetail: { color: t.color.muted, fontSize: 11, lineHeight: 16, paddingVertical: 4 },
    summaryCard: { backgroundColor: t.color.surface, borderWidth: 1, borderColor: t.color.divider, borderRadius: t.radius.lg, padding: t.spacing.md, marginTop: 4 },
    summaryHeading: { fontSize: 13, fontWeight: '800', color: t.color.brandPrimary, marginBottom: 4 },
    summaryText: { fontSize: 12, color: t.color.onSurface, lineHeight: 18 },

    actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
    secondary: { flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', alignItems: 'center', padding: 13, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.border },
    secondaryText: { fontWeight: '700', color: t.color.brandPrimary },
  });
}
