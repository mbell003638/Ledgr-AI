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
  const toggle = (section: string) => setSelected((current) => current.includes(section) ? current.filter((value) => value !== section) : [...current, section]);

  const loadLegacy = async (): Promise<LegacyReports> => {
    const [pnl, balanceSheet, trialBalance, sales, receipts, debtors, creditors] = await Promise.all([
      api.pnlRange(from, to), api.balanceSheet(), api.trialBalance(), api.salesRegister(from, to),
      api.receiptsRegister(from, to), api.debtorsReport(from, to), api.creditorsReport(from, to),
    ]);
    return { pnl, balanceSheet, trialBalance, sales, receipts, debtors, creditors };
  };

  const generate = async (): Promise<string> => {
    setBusy(true);
    try {
      const result = await v2ReportsOrFallback({ from, to }, loadLegacy);
      const lines = ['Ledgr Custom Report', `Period: ${from} to ${to}`, `Source: ${result.source === 'v2' ? 'V2 journal' : 'Legacy reports'}`, ''];
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

  const buildStyledHtml = (text: string) => {
    const lines = text.split('\n');
    let bodyHtml = '';
    let currentSection = '';
    let tableRows = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed === trimmed.toUpperCase() && trimmed.length > 3 && !trimmed.includes(':')) {
        if (tableRows) {
          bodyHtml += `<table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${tableRows}</tbody></table>`;
          tableRows = '';
        }
        currentSection = trimmed;
        bodyHtml += `<div class="section-title">${currentSection}</div>`;
      } else if (trimmed.includes(':')) {
        const [label, val] = trimmed.split(':');
        tableRows += `<tr><td>${label.trim()}</td><td class="num">${val ? val.trim() : ''}</td></tr>`;
      } else {
        tableRows += `<tr><td colspan="2" class="subheader">${trimmed}</td></tr>`;
      }
    }
    if (tableRows) {
      bodyHtml += `<table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    }

    const tc = theme.color || {};
    const primary = tc.surfaceInverse || tc.surface || "#1e202c";
    const accent  = tc.brandPrimary || tc.brand || "#FDBA21";
    const accentText = tc.onBrandPrimary || "#111111";

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; color: #333; background: #fff; }
    .page-container { width: 100%; max-width: 800px; margin: 0 auto; background: #fff; position: relative; }
    .top-bg-container { position: absolute; top: 0; left: 0; width: 100%; height: 264px; z-index: 0; overflow: hidden; }
    .bg-dark { position: absolute; top: 0; left: 0; width: 100%; height: 160px; background: ${primary}; }
    .bg-white-slant { position: absolute; top: 0; left: 40%; width: 12px; height: 160px; background: #fff; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-slant { position: absolute; top: 160px; left: calc(40% - 46px); width: 100px; height: 100px; background: ${accent}; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-rect { position: absolute; top: 160px; left: calc(40% - 46px); right: 0; height: 100px; background: ${accent}; }
    .bg-yellow-border { position: absolute; top: 260px; left: 0; right: 0; height: 4px; background: ${accent}; }
    .header-content { display: flex; height: 160px; position: relative; z-index: 10; }
    .header-left { width: 40%; padding: 40px; display: flex; align-items: center; justify-content: center; }
    .header-logo-text { font-size: 48px; font-weight: 900; color: #fff; letter-spacing: 2px; }
    .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; }
    .report-top-title { color: ${accent}; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .biz-name { font-size: 16px; font-weight: 700; color: #ffffff; margin-bottom: 4px; text-transform: uppercase; }
    .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
    .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
    .report-heading { font-size: 26px; font-weight: 900; color: #111; letter-spacing: 1.5px; text-transform: uppercase; margin: 0; }
    .banner-right { width: 60%; display: flex; align-items: center; padding: 0 40px 0 20px; }
    .banner-col { text-align: left; border-left: 1.5px solid rgba(0,0,0,0.6); padding-left: 15px; flex: 1; margin-left: 10px; }
    .banner-col:first-child { border-left: none; padding-left: 0; margin-left: 0; }
    .banner-label { font-size: 11px; font-weight: 700; color: #222; }
    .banner-val { font-size: 13px; font-weight: 800; margin-top: 4px; color: #111; }
    .content { padding: 40px; }
    .section-title { font-size: 14px; font-weight: 800; color: ${primary}; background: #f9f9f9; padding: 10px 14px; border-left: 5px solid ${accent}; margin-top: 28px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
    th { background: ${primary}; color: #ffffff; text-align: left; padding: 10px 14px; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    td { padding: 10px 14px; border-bottom: 1px solid #eee; color: #333; }
    tr:nth-child(even) td { background-color: #fafafa; }
    .num { text-align: right; font-weight: 600; }
    .subheader { font-weight: 700; color: ${primary}; background: #f4f5f7; font-size: 12px; text-transform: uppercase; }
    .footer-bar { background: ${primary}; color: #fff; padding: 24px 40px; font-size: 10px; border-top: 6px solid ${accent}; margin-top: 40px; }
    .thank-you { color: ${accent}; font-weight: 800; font-size: 13px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="top-bg-container">
      <div class="bg-dark"></div>
      <div class="bg-white-slant"></div>
      <div class="bg-yellow-slant"></div>
      <div class="bg-yellow-rect"></div>
      <div class="bg-yellow-border"></div>
    </div>

    <div class="header-content">
      <div class="header-left">
        <div class="header-logo-text">L</div>
      </div>
      <div class="header-right">
        <div class="report-top-title">CUSTOM FINANCIAL STATEMENT</div>
      </div>
    </div>

    <div class="banner-content">
      <div class="banner-left">
        <h1 class="report-heading">STATEMENT</h1>
      </div>
      <div class="banner-right">
        <div class="banner-col">
          <div class="banner-label">Period</div>
          <div class="banner-val">${from} to ${to}</div>
        </div>
        <div class="banner-col">
          <div class="banner-label">Generated</div>
          <div class="banner-val">${new Date().toLocaleDateString()}</div>
        </div>
      </div>
    </div>

    <div class="content">
      ${bodyHtml}
    </div>

    <div class="footer-bar">
      <div class="thank-you">Generated by Ledgr</div>
      <div>Official custom accounting report &middot; ${new Date().toLocaleDateString()}</div>
    </div>
  </div>
</body>
</html>`;
  };

  const pdf = async () => {
    const text = preview || await generate();
    const { uri } = await Print.printToFileAsync({ html: buildStyledHtml(text) });
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Share Custom Report' });
  };

  return <SafeAreaView style={styles.container}><View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface}/></Pressable><Text style={styles.title}>Custom Report</Text><View style={{ width: 26 }}/></View><ScrollView contentContainerStyle={styles.content}><Text style={styles.hint}>Financial statements use the persistent V2 journal when available, with automatic legacy fallback. Generate, print, or share through other apps.</Text><View style={styles.dates}><TextInput value={from} onChangeText={setFrom} style={styles.input} placeholder="From YYYY-MM-DD"/><TextInput value={to} onChangeText={setTo} style={styles.input} placeholder="To YYYY-MM-DD"/></View><Text style={styles.section}>Include sections</Text><View style={styles.chips}>{SECTIONS.map((section) => <Pressable key={section} onPress={() => toggle(section)} style={[styles.chip, selected.includes(section) && styles.chipOn]}><Ionicons name={selected.includes(section) ? 'checkmark-circle' : 'ellipse-outline'} size={17} color={selected.includes(section) ? '#fff' : theme.color.muted}/><Text style={[styles.chipText, selected.includes(section) && { color: '#fff' }]}>{section}</Text></Pressable>)}</View><Text style={styles.section}>Fields</Text><View style={styles.chips}>{CUSTOM_REPORT_FIELDS.map((field) => <Pressable key={field} onPress={() => setFields((current) => current.includes(field) ? current.filter((value) => value !== field) : [...current, field])} style={[styles.chip, fields.includes(field) && styles.chipOn]}><Text style={[styles.chipText, fields.includes(field) && { color: '#fff' }]}>{FIELD_LABELS[field]}</Text></Pressable>)}</View><Text style={styles.section}>Group by</Text><View style={styles.chips}>{(['none', 'day', 'month', 'account', 'party'] as CustomReportGroup[]).map((group) => <Pressable key={group} onPress={() => setGroupBy(group)} style={[styles.chip, groupBy === group && styles.chipOn]}><Text style={[styles.chipText, groupBy === group && { color: '#fff' }]}>{group === 'none' ? 'No grouping' : group}</Text></Pressable>)}</View><Text style={styles.section}>PDF orientation</Text><View style={styles.chips}>{[false, true].map((wide) => <Pressable key={String(wide)} onPress={() => setLandscape(wide)} style={[styles.chip, landscape === wide && styles.chipOn]}><Text style={[styles.chipText, landscape === wide && { color: '#fff' }]}>{wide ? 'Landscape' : 'Portrait'}</Text></Pressable>)}</View><Pressable onPress={generate} style={styles.primary}>{busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.primaryText}>Generate Preview</Text>}</Pressable>{preview ? <><View style={styles.preview}><Text style={styles.previewText}>{preview}</Text></View><View style={styles.actions}><Pressable onPress={() => Share.share({ message: preview, title: 'Ledgr Custom Report' })} style={styles.secondary}><Ionicons name="share-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>Share text</Text></Pressable><Pressable onPress={pdf} style={styles.secondary}><Ionicons name="document-outline" size={18} color={theme.color.brandPrimary}/><Text style={styles.secondaryText}>PDF / Print</Text></Pressable></View></> : null}</ScrollView></SafeAreaView>;
}

function makeStyles(t: any) { return StyleSheet.create({ container: { flex: 1, backgroundColor: t.color.surface }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: t.spacing.lg, borderBottomWidth: 1, borderColor: t.color.border }, title: { fontSize: 18, fontWeight: '800', color: t.color.onSurface }, content: { padding: t.spacing.lg, paddingBottom: 80 }, hint: { color: t.color.muted, lineHeight: 21 }, dates: { gap: 10, marginTop: 18 }, input: { backgroundColor: t.color.surfaceSecondary, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.md, padding: 13, color: t.color.onSurface }, section: { fontSize: 15, fontWeight: '700', color: t.color.onSurface, marginTop: 22, marginBottom: 10 }, chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9, paddingHorizontal: 12, borderWidth: 1, borderColor: t.color.border, borderRadius: 999, backgroundColor: t.color.surfaceSecondary }, chipOn: { backgroundColor: t.color.brandPrimary, borderColor: t.color.brandPrimary }, chipText: { fontSize: 13, fontWeight: '600', color: t.color.onSurface }, primary: { marginTop: 24, backgroundColor: t.color.brandPrimary, borderRadius: t.radius.md, padding: 15, alignItems: 'center' }, primaryText: { color: '#fff', fontWeight: '800' }, preview: { marginTop: 20, padding: 18, borderWidth: 1, borderColor: t.color.border, borderRadius: t.radius.lg, backgroundColor: t.color.surfaceSecondary }, previewText: { color: t.color.onSurface, lineHeight: 20 }, actions: { flexDirection: 'row', gap: 10, marginTop: 12 }, secondary: { flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', alignItems: 'center', padding: 13, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.border }, secondaryText: { fontWeight: '700', color: t.color.brandPrimary } }); }
