import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Dimensions, TextInput, Share } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { LineChart, PieChart } from "react-native-gifted-charts";
import { Linking } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { fmt as fmtBase, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import { v2ReportsOrFallback } from "@/src/accountingV2/runtime";

const SEGMENTS = ["Summary", "P&L", "Balance", "Trial", "Capital", "Drawings", "Creditors", "Debtors", "Tax", "Sales Reg", "Receipts"] as const;
type Seg = typeof SEGMENTS[number];

const PIE_COLORS = ["#4F8EF7", "#34C759", "#FF9500", "#AF52DE", "#FF2D55", "#5AC8FA", "#FFCC00"];

function rangePreset(preset: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  switch (preset) {
    case "This Month": return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case "Last Month": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "This Quarter": { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) }; }
    case "This Year": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "All Time": return { from: "1970-01-01", to: "2999-12-31" };
    default: return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  }
}
const RANGE_PRESETS = ["This Month", "Last Month", "This Quarter", "This Year", "All Time", "Custom"] as const;

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default function ReportsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [seg, setSeg] = useState<Seg>("Summary");
  const [dash, setDash] = useState<any>(null);
  const [periods, setPeriods] = useState<any[]>([]);
  const [pnl, setPnl] = useState<any>(null);
  const [bs, setBs] = useState<any>(null);
  const [tb, setTb] = useState<any>(null);
  const [cap, setCap] = useState<any>(null);
  const [draws, setDraws] = useState<any[]>([]);
  const [profitTrend, setProfitTrend] = useState<any[]>([]);
  const [assetDist, setAssetDist] = useState<any[]>([]);
  const [creditors, setCreditors] = useState<any[]>([]);
  const [debtors, setDebtors] = useState<any[]>([]);
  const [taxRep, setTaxRep] = useState<any>(null);
  const [salesReg, setSalesReg] = useState<any>(null);
  const [receiptsReg, setReceiptsReg] = useState<any>(null);
  const [currSym, setCurrSym] = useState("$");
  const [bizName, setBizName] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rangePresetSel, setRangePresetSel] = useState("This Month");
  const [from, setFrom] = useState(() => rangePreset("This Month").from);
  const [to, setTo] = useState(() => rangePreset("This Month").to);
  const [reportSource, setReportSource] = useState<"v2" | "legacy">("legacy");

  const fmt = useCallback((n: number | null | undefined) => fmtBase(n, currSym), [currSym]);

  const applyPreset = (p: string) => {
    setRangePresetSel(p);
    if (p !== "Custom") {
      const r = rangePreset(p);
      setFrom(r.from); setTo(r.to);
    }
  };

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setBizName(s.businessName || "");
      const [core, pd, c, dh, pt, ad, cr, dr, tx, sr, rr] = await Promise.all([
        v2ReportsOrFallback({ from, to }, async () => ({
          dash: await api.dashboard(),
          pnl: await api.pnlRange(from, to),
          balanceSheet: await api.balanceSheet(),
          trialBalance: await api.trialBalance(),
        })),
        api.listPeriods(),
        api.capitalStatement(), api.drawingsHistory(),
        api.monthlyProfitTrend(6), api.assetDistribution(),
        api.creditorsReport(from, to), api.debtorsReport(from, to),
        api.taxReport(from, to), api.salesRegister(from, to), api.receiptsRegister(from, to),
      ]);
      setReportSource(core.source);
      if (core.source === "v2") {
        const report = core.report;
        setDash({
          totalSales: report.profitAndLoss.revenue,
          totalPurchases: report.profitAndLoss.expenses,
          grossProfit: report.profitAndLoss.netProfit,
          netProfit: report.profitAndLoss.netProfit,
          cash: report.balanceSheet.assets,
          inventoryValue: 0,
          netWorth: report.balanceSheet.equity + report.balanceSheet.currentEarnings,
          liabilities: report.balanceSheet.liabilities,
          suppliers: 0,
        });
        setPnl({
          revenue: report.profitAndLoss.revenue,
          cogs: report.profitAndLoss.expenses,
          grossProfit: report.profitAndLoss.netProfit,
          managerCommissionPct: 0,
          commission: 0,
          drawings: 0,
          netProfit: report.profitAndLoss.netProfit,
        });
        setBs({
          assets: { cash: report.balanceSheet.assets, inventory: 0, extra: [], total: report.balanceSheet.assets },
          liabilities: { suppliersPayable: report.balanceSheet.liabilities, extra: [], total: report.balanceSheet.liabilities },
          equity: report.balanceSheet.equity + report.balanceSheet.currentEarnings,
        });
        setTb({
          debits: report.trialBalance.accounts.filter((a) => a.debit > 0).map((a) => ({ account: a.name, amount: a.debit })),
          credits: report.trialBalance.accounts.filter((a) => a.credit > 0).map((a) => ({ account: a.name, amount: a.credit })),
        });
      } else {
        setDash(core.report.dash); setPnl(core.report.pnl); setBs(core.report.balanceSheet); setTb(core.report.trialBalance);
      }
      setPeriods(pd); setCap(c); setDraws(dh);
      setProfitTrend(pt); setAssetDist(ad);
      setCreditors(cr); setDebtors(dr);
      setTaxRep(tx); setSalesReg(sr); setReceiptsReg(rr);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [from, to]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const screenW = Dimensions.get("window").width;

  // ------- Legacy vs Live figures for the Summary tab -------
  const legacy = useMemo(() => {
    const sum = (k: string) => periods.reduce((s, p) => s + (Number(p[k]) || 0), 0);
    return {
      totalProfit: +sum("netProfit").toFixed(2),
      totalDrawings: +sum("drawings").toFixed(2),
      entries: periods.length,
      lastAssets: periods[0] ? (Number(periods[0].closingCash) || 0) + (Number(periods[0].closingInventory) || 0) : 0,
    };
  }, [periods]);

  // ------- Build a shareable plain-text report for the active segment -------
  const buildText = (): string => {
    const head = `${bizName || "Ledgr"} — ${seg} Report\n${from} → ${to}\n`;
    const line = (l: string, v: any) => `${l}: ${fmt(v)}`;
    let body = "";
    if (seg === "Summary" && dash) {
      body = [
        `— LIVE (current period)`,
        line("Sales", dash.totalSales),
        line("Purchases", dash.totalPurchases),
        line("Gross Profit", dash.grossProfit),
        line("Net Profit", dash.netProfit),
        line("Cash", dash.cash),
        line("Inventory", dash.inventoryValue),
        line("Outstanding Debtors", dash.accountsReceivable || 0),
        line("Net Worth", dash.netWorth),
        line("Creditors", dash.liabilities),
        `Registered Suppliers: ${dash.suppliers}`,
        ``,
        `— LEGACY (closed periods: ${legacy.entries})`,
        line("Total Profit (legacy)", legacy.totalProfit),
        line("Total Drawings (legacy)", legacy.totalDrawings),
        ``,
        `— PARTNER CAPITAL`,
        ...(cap ? cap.partners.map((p: any) => line(`${p.name} drawings`, p.drawings)) : []),
        cap ? line("Closing Capital", cap.closingCapital) : "",
      ].join("\n");
    } else if (seg === "P&L" && pnl) {
      body = [line("Revenue", pnl.revenue), line("COGS", pnl.cogs), line("Gross Profit", pnl.grossProfit), line("Net Profit", pnl.netProfit)].join("\n");
    } else if (seg === "Balance" && bs) {
      body = [line("Total Assets", bs.assets.total), line("Total Liabilities", bs.liabilities.total), line("Equity", bs.equity)].join("\n");
    } else if (seg === "Capital" && cap) {
      body = [line("Opening Capital", cap.openingCapital), line("Net Profit", cap.netProfit), line("Drawings", cap.totalDrawings), line("Closing Capital", cap.closingCapital)].join("\n");
    } else if (seg === "Creditors") {
      body = creditors.map((c) => `${c.name}: ${fmt(c.balance)}`).join("\n") || "No creditors.";
    } else if (seg === "Debtors") {
      body = debtors.map((d) => `${d.name}: ${fmt(d.balance)}`).join("\n") || "No debtors.";
    } else if (seg === "Drawings") {
      body = draws.map((d) => `${d.partnerName} ${shortDate(d.date)}: ${fmt(d.amount)}`).join("\n") || "No drawings.";
    } else if (seg === "Trial" && tb) {
      body = ["Debits", ...tb.debits.map((d: any) => `  ${d.account}: ${fmt(d.amount)}`), "Credits", ...tb.credits.map((c: any) => `  ${c.account}: ${fmt(c.amount)}`)].join("\n");
    } else if (seg === "Tax" && taxRep) {
      body = [
        `— ${taxRep.taxLabel} (${taxRep.taxRate}%) · ${taxRep.basis} basis`,
        `Output tax base: ${fmt(taxRep.outputBase)}`,
        `Output tax: ${fmt(taxRep.outputTax)}`,
        `Less credit notes: ${fmt(taxRep.creditNoteTax)}`,
        `Add debit notes: ${fmt(taxRep.debitNoteTax)}`,
        `Net output tax: ${fmt(taxRep.netOutputTax)}`,
        `Input tax (purchases): ${fmt(taxRep.inputTax)}`,
        `Net tax payable: ${fmt(taxRep.netTaxPayable)}`,
      ].join("\n");
    } else if (seg === "Sales Reg" && salesReg) {
      body = [
        `Cash sales: ${fmt(salesReg.cashTotal)}`,
        `Invoiced: ${fmt(salesReg.invoiceTotal)}`,
        `Total: ${fmt(salesReg.total)} (${salesReg.count} entries)`,
        `—`,
        ...salesReg.rows.map((r: any) => `${shortDate(r.date)} ${r.type} ${r.ref}${r.party ? ` ${r.party}` : ""}: ${fmt(r.amount)}`),
      ].join("\n");
    } else if (seg === "Receipts" && receiptsReg) {
      body = [
        `Total received: ${fmt(receiptsReg.total)} (${receiptsReg.count})`,
        `— By method`,
        ...Object.entries(receiptsReg.byMethod).map(([k, v]) => `${k}: ${fmt(v as number)}`),
        `— Entries`,
        ...receiptsReg.rows.map((r: any) => `${shortDate(r.date)} ${r.ref} ${r.party} (${r.method}): ${fmt(r.amount)}`),
      ].join("\n");
    }
    return `${head}\n${body}\n\n— Sent from Ledgr`;
  };

  // ------- Build an HTML document for PDF export -------
  const buildHtml = (): string => {
    const tc = theme.color || {};
    const primary = tc.surfaceInverse || tc.surface || "#1e202c";
    const accent  = tc.brandPrimary || tc.brand || "#FDBA21";
    const accentText = tc.onBrandPrimary || "#111111";

    const rows = buildText().split("\n").map((l) => {
      if (!l.trim()) return "<div style='height:12px'></div>";
      if (l.startsWith("—")) return `<h3 style='margin:24px 0 8px;color:${primary};font-size:14px;text-transform:uppercase;letter-spacing:1px;border-left:4px solid ${accent};padding-left:8px;background:#f9f9f9;padding-top:4px;padding-bottom:4px;'>${esc(l.replace(/—/g, "").trim())}</h3>`;
      const [k, ...rest] = l.split(":");
      if (rest.length) return `<div style='display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:13px;color:#333'><span>${esc(k)}</span><b style='color:${primary};font-weight:700'>${esc(rest.join(":").trim())}</b></div>`;
      return `<div style='padding:4px 0;font-size:13px;color:#555'>${esc(l)}</div>`;
    }).join("");
    return `<html><head><meta name='viewport' content='width=device-width,initial-scale=1'/>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; color: #333; background: #fff; }
        .page-container { width: 100%; max-width: 800px; margin: 0 auto; background: #fff; position: relative; }
        .top-bg-container { position: absolute; top: 0; left: 0; width: 100%; height: 264px; z-index: 0; overflow: hidden; }
        .bg-dark { position: absolute; top: 0; left: 0; width: 100%; height: 160px; background: ${primary}; }
        .bg-white-slant { position: absolute; top: 0; left: 40%; width: 12px; height: 160px; background: #fff; transform-origin: top left; transform: skewX(-20deg); }
        .bg-yellow-slant { position: absolute; top: 160px; left: calc(40% - 46px); width: 100px; height: 100px; background: ${accent}; transform-origin: top left; transform: skewX(-20deg); }
        .bg-yellow-rect { position: absolute; top: 160px; left: calc(40% - 46px); right: 0; height: 100px; background: ${accent}; }
        .bg-yellow-border { position: absolute; top: 260px; left: 0; right: 0; height: 4px; background: ${accent}; }
        .header-content { display: flex; height: 160px; position: relative; z-index: 10; }
        .header-left { width: 40%; padding: 40px; display: flex; align-items: center; justify-content: center; }
        .header-logo-text { font-size: 56px; font-weight: 900; color: #fff; letter-spacing: 2px; }
        .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
        .report-title { color: ${accent}; font-weight: 800; font-size: 20px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
        .biz-name { font-size: 14px; font-weight: 700; color: #ffffff; margin-bottom: 4px; text-transform: uppercase; }
        .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
        .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
        .report-heading { font-size: 36px; font-weight: 900; color: #111; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
        .banner-right { width: 60%; display: flex; align-items: center; padding: 0 40px 0 20px; }
        .banner-col { text-align: left; border-left: 1.5px solid rgba(0,0,0,0.6); padding-left: 15px; flex: 1; margin-left: 10px; }
        .banner-col:first-child { border-left: none; padding-left: 0; margin-left: 0; }
        .banner-label { font-size: 11px; font-weight: 700; color: #222; }
        .banner-val { font-size: 14px; font-weight: 800; margin-top: 4px; color: #111; }
        .content { padding: 40px; }
        .footer-bar { background: ${primary}; color: #fff; padding: 24px 40px; font-size: 10px; border-top: 6px solid ${accent}; }
        .thank-you { color: ${accent}; font-weight: 800; font-size: 13px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        .gen-date { color: #aaa; font-size: 10px; margin-top: 4px; }
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
            <div class="header-logo-text">${esc(bizName ? bizName.substring(0, 1) : 'L')}</div>
          </div>
          <div class="header-right">
            <div class="report-title">${esc(seg)} Report</div>
            <div class="biz-name">${esc(bizName || "Ledgr")}</div>
          </div>
        </div>

        <div class="banner-content">
          <div class="banner-left">
            <h1 class="report-heading">REPORT</h1>
          </div>
          <div class="banner-right">
            <div class="banner-col">
              <div class="banner-label">Report Type</div>
              <div class="banner-val">${esc(seg)}</div>
            </div>
            <div class="banner-col">
              <div class="banner-label">Period</div>
              <div class="banner-val">${esc(from)} to ${esc(to)}</div>
            </div>
          </div>
        </div>

        <div class="content">
          ${rows}
        </div>

        <div class="footer-bar">
          <div class="thank-you">Generated by Ledgr</div>
          <div class="gen-date">Date: ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div>
        </div>
      </div>
      </body></html>`;
  };

  const shareWhatsApp = async () => {
    try { await Share.share({ message: buildText(), title: `${seg} Report` }); }
    catch (e) { console.warn(e); }
  };

  const sharePdf = async () => {
    try {
      const { uri } = await Print.printToFileAsync({ html: buildHtml() });
      const can = await Sharing.isAvailableAsync();
      if (can) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `${seg} Report` });
    } catch (e) { console.warn(e); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: theme.spacing.lg }}>
        <ScreenHeader title="Reports" subtitle="Financial statements" />
        <Pressable
          testID="btn-custom-report"
          onPress={() => router.push("/custom-report")}
          style={({ pressed }) => [styles.customReportBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="options-outline" size={16} color={theme.color.brandPrimary} />
          <Text style={styles.customReportBtnText}>Custom Report</Text>
        </Pressable>
      </View>

      {/* Report category segments */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segScroll} contentContainerStyle={styles.segRow}>
        {SEGMENTS.map((s) => (
          <Pressable key={s} testID={`report-seg-${s}`} onPress={() => setSeg(s)} style={[styles.seg, seg === s && styles.segActive]}>
            <Text style={[styles.segText, seg === s && styles.segTextActive]}>{s}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Date range preset filters */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateScroll} contentContainerStyle={styles.dateRow}>
        {RANGE_PRESETS.map((p) => (
          <Pressable key={p} onPress={() => applyPreset(p)} style={[styles.dateChip, rangePresetSel === p && styles.dateChipActive]}>
            <Text style={[styles.dateChipText, rangePresetSel === p && styles.dateChipTextActive]}>{p}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Custom date inputs (shown when Custom selected) */}
      {rangePresetSel === "Custom" && (
        <View style={styles.customRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.customLabel}>From</Text>
            <TextInput value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.customInput} autoCapitalize="none" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.customLabel}>To</Text>
            <TextInput value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.customInput} autoCapitalize="none" />
          </View>
          <Pressable onPress={() => load()} style={styles.applyBtn}>
            <Text style={styles.applyText}>Apply</Text>
          </Pressable>
        </View>
      )}

      {/* Share bar */}
      <View style={styles.shareBar}>
        <Pressable onPress={shareWhatsApp} style={[styles.shareBtn, { backgroundColor: "#25D366" }]}>
          <Ionicons name="logo-whatsapp" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>WhatsApp</Text>
        </Pressable>
        <Pressable onPress={sharePdf} style={[styles.shareBtn, { backgroundColor: theme.color.brandPrimary }]}>
          <Ionicons name="document-outline" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>PDF</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {seg === "Summary" && dash && (
            <>
              <Card testID="report-summary-live">
                <Text style={styles.rTitle}>{reportSource === "v2" ? "V2 — Journal Report" : "Live — Current Period"}</Text>
                <RowKV label="Sales" value={fmt(dash.totalSales)} theme={theme} styles={styles} />
                <RowKV label={reportSource === "v2" ? "Expenses" : "Purchases"} value={fmt(dash.totalPurchases)} theme={theme} styles={styles} />
                <RowKV label="Gross Profit" value={fmt(dash.grossProfit)} strong theme={theme} styles={styles} />
                <RowKV label="Net Profit" value={fmt(dash.netProfit)} strong big theme={theme} styles={styles} />
                <View style={styles.divider} />
                <RowKV label="Cash" value={fmt(dash.cash)} theme={theme} styles={styles} />
                <RowKV label="Inventory Value" value={fmt(dash.inventoryValue)} theme={theme} styles={styles} />
                <RowKV label="Outstanding Debtors" value={fmt(dash.accountsReceivable || 0)} theme={theme} styles={styles} />
                <RowKV label="Net Worth" value={fmt(dash.netWorth)} strong theme={theme} styles={styles} />
                <RowKV label="Creditors" value={fmt(dash.liabilities)} theme={theme} styles={styles} danger />
                <RowKV label="Registered Suppliers" value={String(dash.suppliers)} theme={theme} styles={styles} />
              </Card>

              <Card style={{ marginTop: theme.spacing.md }} testID="report-summary-legacy">
                <Text style={styles.rTitle}>Legacy — Closed Periods</Text>
                <RowKV label="Total Profit (legacy)" value={fmt(legacy.totalProfit)} theme={theme} styles={styles} />
                <RowKV label="Total Drawings (legacy)" value={fmt(legacy.totalDrawings)} theme={theme} styles={styles} danger />
                <RowKV label="Last Period Assets" value={fmt(legacy.lastAssets)} theme={theme} styles={styles} />
                <RowKV label="Period Entries" value={String(legacy.entries)} theme={theme} styles={styles} />
              </Card>

              {cap && (
                <Card style={{ marginTop: theme.spacing.md }} testID="report-summary-capital">
                  <Text style={styles.rTitle}>Partner Capital</Text>
                  <RowKV label="Opening Capital" value={fmt(cap.openingCapital)} theme={theme} styles={styles} />
                  <RowKV label="Net Profit" value={`+ ${fmt(cap.netProfit)}`} theme={theme} styles={styles} />
                  <RowKV label="Total Drawings" value={`- ${fmt(cap.totalDrawings)}`} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  {cap.partners.map((p: any) => (
                    <RowKV key={p.name} label={`${p.name} — drawings`} value={fmt(p.drawings)} theme={theme} styles={styles} />
                  ))}
                  <View style={styles.divider} />
                  <RowKV label="Closing Capital" value={fmt(cap.closingCapital)} strong big theme={theme} styles={styles} />
                </Card>
              )}
            </>
          )}

          {seg === "P&L" && pnl && (
            <>
              <Card testID="report-pnl">
                <Text style={styles.rTitle}>Profit &amp; Loss</Text>
                <RowKV label="Revenue" value={fmt(pnl.revenue)} theme={theme} styles={styles} />
                <RowKV label={reportSource === "v2" ? "Expenses" : "Cost of Goods Sold"} value={`- ${fmt(pnl.cogs)}`} theme={theme} styles={styles} />
                <RowKV label="Gross Profit" value={fmt(pnl.grossProfit)} strong theme={theme} styles={styles} />
                {pnl.managerCommissionPct > 0 && (
                  <RowKV label={`Manager Commission (${pnl.managerCommissionPct}%)`} value={`- ${fmt(pnl.commission)}`} theme={theme} styles={styles} />
                )}
                <RowKV label="Drawings" value={`- ${fmt(pnl.drawings)}`} theme={theme} styles={styles} />
                <View style={styles.divider} />
                <RowKV label="Net Profit" value={fmt(pnl.netProfit)} strong big theme={theme} styles={styles} />
              </Card>

              {profitTrend.length > 0 && (
                <Card style={{ marginTop: theme.spacing.md }} testID="chart-profit-trend">
                  <Text style={styles.rTitle}>Monthly Profit Trend</Text>
                  <LineChart
                    data={profitTrend.map((m) => ({ value: m.profit, label: m.label }))}
                    color={theme.color.brandPrimary}
                    thickness={3}
                    dataPointsColor={theme.color.brandPrimary}
                    startFillColor={theme.color.brandPrimary}
                    areaChart
                    startOpacity={0.25}
                    endOpacity={0.02}
                    yAxisTextStyle={{ color: theme.color.muted, fontSize: 10 }}
                    xAxisLabelTextStyle={{ color: theme.color.muted, fontSize: 10 }}
                    noOfSections={4}
                    width={screenW - 96}
                    height={160}
                    yAxisColor={theme.color.border}
                    xAxisColor={theme.color.border}
                    rulesColor={theme.color.divider}
                  />
                </Card>
              )}
            </>
          )}

          {seg === "Balance" && bs && (
            <>
              <Card testID="report-bs-assets">
                <Text style={styles.rTitle}>Assets</Text>
                <RowKV label="Cash" value={fmt(bs.assets.cash)} theme={theme} styles={styles} />
                <RowKV label="Inventory" value={fmt(bs.assets.inventory)} theme={theme} styles={styles} />
                {(bs.assets.extra || []).map((a: any, i: number) => (
                  <RowKV key={i} label={a.name || "Other Asset"} value={fmt(Number(a.amount) || 0)} theme={theme} styles={styles} />
                ))}
                <View style={styles.divider} />
                <RowKV label="Total Assets" value={fmt(bs.assets.total)} strong theme={theme} styles={styles} />
              </Card>
              <Card style={{ marginTop: theme.spacing.md }} testID="report-bs-liab">
                <Text style={styles.rTitle}>Liabilities &amp; Equity</Text>
                <RowKV label="Suppliers Payable" value={fmt(bs.liabilities.suppliersPayable)} theme={theme} styles={styles} />
                {(bs.liabilities.extra || []).map((l: any, i: number) => (
                  <RowKV key={i} label={l.name || "Other Liability"} value={fmt(Number(l.amount) || 0)} theme={theme} styles={styles} />
                ))}
                <View style={styles.divider} />
                <RowKV label="Total Liabilities" value={fmt(bs.liabilities.total)} strong theme={theme} styles={styles} />
                <RowKV label="Owner's Equity" value={fmt(bs.equity)} strong theme={theme} styles={styles} />
              </Card>

              {assetDist.length > 0 && (
                <Card style={{ marginTop: theme.spacing.md }} testID="chart-asset-dist">
                  <Text style={styles.rTitle}>Asset Distribution</Text>
                  <View style={{ alignItems: "center", marginTop: theme.spacing.md }}>
                    <PieChart
                      data={assetDist.map((s: any, i: number) => ({ value: s.value, color: PIE_COLORS[i % PIE_COLORS.length], text: "" }))}
                      donut
                      radius={90}
                      innerRadius={55}
                      innerCircleColor={theme.color.surfaceSecondary}
                    />
                  </View>
                  <View style={{ marginTop: theme.spacing.md }}>
                    {assetDist.map((s: any, i: number) => (
                      <View key={i} style={styles.legendRow}>
                        <View style={[styles.legendDot, { backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }]} />
                        <Text style={styles.legendLabel}>{s.label}</Text>
                        <Text style={styles.legendValue}>{fmt(s.value)}</Text>
                      </View>
                    ))}
                  </View>
                </Card>
              )}
            </>
          )}

          {seg === "Trial" && tb && (
            <Card testID="report-tb">
              <Text style={styles.rTitle}>Trial Balance</Text>
              <Text style={styles.groupHeader}>Debits</Text>
              {tb.debits.map((d: any) => <RowKV key={d.account} label={d.account} value={fmt(d.amount)} theme={theme} styles={styles} />)}
              <Text style={styles.groupHeader}>Credits</Text>
              {tb.credits.map((c: any) => <RowKV key={c.account} label={c.account} value={fmt(c.amount)} theme={theme} styles={styles} />)}
            </Card>
          )}

          {seg === "Capital" && cap && (
            <Card testID="report-capital">
              <Text style={styles.rTitle}>Partner Capital Statement</Text>
              <RowKV label="Opening Capital (combined)" value={fmt(cap.openingCapital)} theme={theme} styles={styles} />
              <RowKV label="Net Profit" value={`+ ${fmt(cap.netProfit)}`} theme={theme} styles={styles} />
              <RowKV label="Total Drawings" value={`- ${fmt(cap.totalDrawings)}`} theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Closing Capital" value={fmt(cap.closingCapital)} strong big theme={theme} styles={styles} />

              <Text style={styles.groupHeader}>Drawings by Partner</Text>
              {cap.partners.map((p: any) => (
                <RowKV key={p.name} label={p.name} value={fmt(p.drawings)} theme={theme} styles={styles} />
              ))}
              {cap.otherDrawings > 0 && (
                <RowKV label="Other / Unattributed" value={fmt(cap.otherDrawings)} theme={theme} styles={styles} />
              )}
            </Card>
          )}

          {seg === "Drawings" && (
            <Card testID="report-drawings">
              <Text style={styles.rTitle}>Drawings History</Text>
              {draws.length === 0 ? (
                <Text style={styles.empty}>No drawings recorded yet.</Text>
              ) : (
                draws.map((d) => (
                  <View key={d.id} style={styles.drawRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.drawPartner}>{d.partnerName}</Text>
                      <Text style={styles.drawSub}>{shortDate(d.date)}{d.notes ? ` • ${d.notes}` : ""}</Text>
                    </View>
                    <Text style={styles.drawAmount}>- {fmt(d.amount)}</Text>
                  </View>
                ))
              )}
            </Card>
          )}

          {seg === "Creditors" && (
            <Card testID="report-creditors">
              <Text style={styles.rTitle}>Creditors Ledger</Text>
              <Text style={styles.hint}>{from} → {to}</Text>
              {creditors.length === 0 ? (
                <Text style={styles.empty}>No creditors found for this period.</Text>
              ) : creditors.map((c: any) => (
                <View key={c.supplierId} style={{ marginBottom: theme.spacing.md }}>
                  <View style={styles.kv}>
                    <Text style={[styles.kvLabel, { fontWeight: "700", color: theme.color.onSurface }]}>{c.name}</Text>
                    <Text style={[styles.kvValue, { color: c.balance > 0 ? theme.color.error : theme.color.success, fontWeight: "700" }]}>{fmt(c.balance)}</Text>
                  </View>
                  <RowKV label="Total Billed" value={fmt(c.totalBilled)} theme={theme} styles={styles} />
                  <RowKV label="Total Paid" value={fmt(c.totalPaid)} theme={theme} styles={styles} />
                  <View style={styles.reminderRow}>
                    {c.phone ? (
                      <Pressable onPress={() => Linking.openURL(`whatsapp://send?phone=${String(c.phone).replace(/\D/g, "")}&text=${encodeURIComponent(`Hi ${c.name}, your outstanding balance is ${fmt(c.balance)}. Please arrange payment.`)}`)}>
                        <Text style={styles.reminderLink}>📱 WhatsApp</Text>
                      </Pressable>
                    ) : null}
                    {c.email ? (
                      <Pressable onPress={() => Linking.openURL(`mailto:${c.email}?subject=${encodeURIComponent("Payment Reminder")}&body=${encodeURIComponent(`Hi ${c.name},\n\nYour outstanding balance is ${fmt(c.balance)}. Please arrange payment.\n\nThank you.`)}`)}>
                        <Text style={styles.reminderLink}>✉️ Email</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.divider} />
                </View>
              ))}
            </Card>
          )}

          {seg === "Debtors" && (
            <Card testID="report-debtors">
              <Text style={styles.rTitle}>Debtors Ledger</Text>
              <Text style={styles.hint}>{from} → {to}</Text>
              {debtors.length === 0 ? (
                <Text style={styles.empty}>No debtors found. Add debtors from the Debtors screen.</Text>
              ) : debtors.map((d: any) => (
                <View key={d.id} style={{ marginBottom: theme.spacing.md }}>
                  <View style={styles.kv}>
                    <Text style={[styles.kvLabel, { fontWeight: "700", color: theme.color.onSurface }]}>{d.name}</Text>
                    <Text style={[styles.kvValue, { color: d.balance > 0 ? theme.color.error : theme.color.success, fontWeight: "700" }]}>{fmt(d.balance)}</Text>
                  </View>
                  <RowKV label="Total Invoiced" value={fmt(d.totalInvoiced)} theme={theme} styles={styles} />
                  <RowKV label="Total Paid" value={fmt(d.totalPaid)} theme={theme} styles={styles} />
                  <View style={styles.reminderRow}>
                    {d.phone ? (
                      <Pressable onPress={() => Linking.openURL(`whatsapp://send?phone=${String(d.phone).replace(/\D/g, "")}&text=${encodeURIComponent(`Hi ${d.name}, your outstanding balance is ${fmt(d.balance)}. Please arrange payment. Thank you.`)}`)}>
                        <Text style={styles.reminderLink}>📱 WhatsApp</Text>
                      </Pressable>
                    ) : null}
                    {d.email ? (
                      <Pressable onPress={() => Linking.openURL(`mailto:${d.email}?subject=${encodeURIComponent("Payment Reminder")}&body=${encodeURIComponent(`Hi ${d.name},\n\nYour outstanding balance is ${fmt(d.balance)}. Please arrange payment.\n\nThank you.`)}`)}>
                        <Text style={styles.reminderLink}>✉️ Email</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.divider} />
                </View>
              ))}
            </Card>
          )}

          {seg === "Tax" && taxRep && (
            <Card testID="report-tax">
              <Text style={styles.rTitle}>{taxRep.taxLabel} Report</Text>
              <Text style={styles.hint}>{from} → {to} · {taxRep.taxRate}% · {taxRep.basis} basis</Text>
              <RowKV label="Output tax base" value={fmt(taxRep.outputBase)} theme={theme} styles={styles} />
              <RowKV label="Output tax collected" value={fmt(taxRep.outputTax)} theme={theme} styles={styles} />
              <RowKV label="Less: credit notes" value={fmt(taxRep.creditNoteTax)} theme={theme} styles={styles} />
              <RowKV label="Add: debit notes" value={fmt(taxRep.debitNoteTax)} theme={theme} styles={styles} />
              <RowKV label="Net output tax" value={fmt(taxRep.netOutputTax)} strong theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Input tax (purchases)" value={fmt(taxRep.inputTax)} theme={theme} styles={styles} />
              <RowKV label="Net tax payable" value={fmt(taxRep.netTaxPayable)} strong big theme={theme} styles={styles} />
              <Text style={styles.hint}>Input tax is estimated from purchase totals at the standard rate.</Text>
            </Card>
          )}

          {seg === "Sales Reg" && salesReg && (
            <Card testID="report-salesreg">
              <Text style={styles.rTitle}>Sales Register</Text>
              <Text style={styles.hint}>{from} → {to} · {salesReg.count} entries</Text>
              <RowKV label="Cash sales" value={fmt(salesReg.cashTotal)} theme={theme} styles={styles} />
              <RowKV label="Invoiced" value={fmt(salesReg.invoiceTotal)} theme={theme} styles={styles} />
              <RowKV label="Total" value={fmt(salesReg.total)} strong big theme={theme} styles={styles} />
              <View style={styles.divider} />
              {salesReg.rows.length === 0 ? (
                <Text style={styles.empty}>No sales in this range.</Text>
              ) : salesReg.rows.map((r: any, i: number) => (
                <View key={i} style={styles.kv}>
                  <Text style={styles.kvLabel}>{shortDate(r.date)} · {r.type}{r.ref ? ` · ${r.ref}` : ""}{r.party ? ` · ${r.party}` : ""}</Text>
                  <Text style={styles.kvValue}>{fmt(r.amount)}</Text>
                </View>
              ))}
            </Card>
          )}

          {seg === "Receipts" && receiptsReg && (
            <Card testID="report-receiptsreg">
              <Text style={styles.rTitle}>Receipts Register</Text>
              <Text style={styles.hint}>{from} → {to} · {receiptsReg.count} receipts</Text>
              <RowKV label="Total received" value={fmt(receiptsReg.total)} strong big theme={theme} styles={styles} />
              <View style={styles.divider} />
              <Text style={[styles.hint, { fontWeight: "700" }]}>By method</Text>
              {Object.entries(receiptsReg.byMethod).map(([k, v]) => (
                <RowKV key={k} label={k.toUpperCase()} value={fmt(v as number)} theme={theme} styles={styles} />
              ))}
              <View style={styles.divider} />
              {receiptsReg.rows.length === 0 ? (
                <Text style={styles.empty}>No receipts in this range.</Text>
              ) : receiptsReg.rows.map((r: any, i: number) => (
                <View key={i} style={styles.kv}>
                  <Text style={styles.kvLabel}>{shortDate(r.date)} · {r.ref} · {r.party} ({r.method})</Text>
                  <Text style={styles.kvValue}>{fmt(r.amount)}</Text>
                </View>
              ))}
            </Card>
          )}

          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function RowKV({ label, value, strong, big, danger, theme, styles }: { label: string; value: string; strong?: boolean; big?: boolean; danger?: boolean; theme: any; styles: any }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, strong && { fontWeight: "700", color: theme.color.onSurface }]}>{label}</Text>
      <Text style={[styles.kvValue, strong && { fontWeight: "700" }, big && { fontSize: 18 }, danger && { color: theme.color.error }]}>{value}</Text>
    </View>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  customReportBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, marginTop: theme.spacing.md },
  customReportBtnText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
  segScroll: { height: 44, flexGrow: 0, marginTop: theme.spacing.xs },
  segRow: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: theme.spacing.lg, gap: 8,
  },
  seg: {
    paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20,
    backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border,
  },
  segActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "600", fontSize: 13 },
  segTextActive: { color: "#fff", fontWeight: "700" },
  dateScroll: { height: 36, flexGrow: 0, marginVertical: 6 },
  dateRow: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: theme.spacing.lg, gap: 6,
  },
  dateChip: {
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
    backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border,
  },
  dateChipActive: { backgroundColor: theme.color.surfaceTertiary, borderColor: theme.color.brandPrimary },
  dateChipText: { color: theme.color.muted, fontWeight: "600", fontSize: 11 },
  dateChipTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  customRow: { flexDirection: "row", gap: 8, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.sm, alignItems: "flex-end" },
  customLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "600", marginBottom: 4 },
  customInput: { borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary },
  applyBtn: { backgroundColor: theme.color.brandPrimary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: theme.radius.md },
  applyText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  shareBar: { flexDirection: "row", gap: 8, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
  shareBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 16, borderRadius: theme.radius.md },
  shareBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  scroll: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md, paddingTop: theme.spacing.sm },
  rTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.md },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  kvLabel: { fontSize: 14, color: theme.color.onSurfaceTertiary, flex: 1 },
  kvValue: { fontSize: 14, color: theme.color.onSurface, fontWeight: "500" },
  divider: { height: 1, backgroundColor: theme.color.divider, marginVertical: theme.spacing.sm },
  groupHeader: { fontSize: 12, fontWeight: "700", color: theme.color.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
  empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.md, fontSize: 13, fontStyle: "italic" },
  hint: { color: theme.color.muted, fontSize: 12, marginBottom: theme.spacing.sm },
  reminderRow: { flexDirection: "row", gap: 16, marginTop: 4 },
  reminderLink: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "600" },
  legendRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5 },
  legendDot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  legendLabel: { flex: 1, fontSize: 13, color: theme.color.onSurface },
  legendValue: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  drawRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.color.divider },
  drawPartner: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
  drawSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  drawAmount: { fontSize: 15, fontWeight: "700", color: theme.color.error },
}); }
