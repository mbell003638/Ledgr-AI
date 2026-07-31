import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Dimensions, TextInput, Share, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { LineChart, PieChart } from "react-native-gifted-charts";
import { Linking } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { fmt as fmtBase, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import { printHtml } from "@/src/utils/print";
import { showAlert } from "@/src/utils/alerts";
import { GlowPressable } from "@/src/components/GlowPressable";
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
  const [bizSettings, setBizSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rangePresetSel, setRangePresetSel] = useState("This Month");
  const [from, setFrom] = useState(() => rangePreset("This Month").from);
  const [to, setTo] = useState(() => rangePreset("This Month").to);
  const [reportSource, setReportSource] = useState<"v2" | "legacy">("legacy");
  const [segmentEdges, setSegmentEdges] = useState({ left: false, right: true });
  const [dateEdges, setDateEdges] = useState({ left: false, right: true });

  const updateRailEdges = useCallback((event: any, setter: React.Dispatch<React.SetStateAction<{ left: boolean; right: boolean }>>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const x = Math.max(0, contentOffset.x);
    setter({
      left: x > 3,
      right: x + layoutMeasurement.width < contentSize.width - 3,
    });
  }, []);

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
      setBizSettings(s);
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
        `— PROFIT (LIVE)`,
        line("Sales", dash.totalSales),
        line("Purchases", dash.totalPurchases),
        line("Gross Profit", dash.grossProfit),
        line("Net Profit", dash.netProfit),
        ``,
        `— ASSETS`,
        line("Cash", dash.cash),
        line("Inventory", dash.inventoryValue),
        line("Outstanding Debtors", dash.accountsReceivable || 0),
        line("Total Assets", dash.cash + dash.inventoryValue + (dash.accountsReceivable || 0)),
        ``,
        `— LIABILITIES`,
        line("Creditors", dash.liabilities),
        `Registered Suppliers: ${dash.suppliers}`,
        line("Net Worth (Equity)", dash.netWorth),
        ``,
        ...(bizSettings?.accountingStyle === 'retail_partnership' ? [
          `— PARTNER STAKES RECONCILIATION`,
          line("Total Profit (legacy)", legacy.totalProfit),
          line("Total Drawings (legacy)", legacy.totalDrawings),
          ...(cap ? cap.partners.map((p: any) => line(`${p.name} drawings`, p.drawings)) : []),
          cap ? line("Closing Capital", cap.closingCapital) : "",
        ] : []),
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
    const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const biz = bizSettings || {};
    let primary = "#000000";
    let accent = "#FDBA21";

    if (biz.invoiceTheme === "navy_gold") {
      primary = "#000000";
      accent = "#FDBA21";
    } else if (biz.invoiceTheme === "amoled_blue") {
      primary = "#000000";
      accent = "#3498db";
    } else if (biz.invoiceTheme === "emerald") {
      primary = "#1C4030";
      accent = "#2ecc71";
    } else if (biz.invoiceTheme === "minimal") {
      primary = "#111513";
      accent = "#8FB99A";
    } else {
      const tc = theme.color || {};
      primary = tc.surfaceInverse || tc.surface || "#000000";
      accent  = tc.brandPrimary || tc.brand || "#3498db";
    }

    const lines = buildText().split("\n");
    // Remove legacy text header lines if present
    if (lines[0] && lines[0].includes("REPORT")) lines.shift();
    if (lines[0] && lines[0].includes("Period")) lines.shift();

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(seg)} Report</title>
  <style>
    :root{
      --dark: ${primary};
      --gold: ${accent};
      --gray-row: #eef0f2;
      --text: #1e222b;
      --muted: #7a7f8a;
    }

    @media print {
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      body { background: #fff !important; padding: 0 !important; }
      .report-container { box-shadow: none !important; width: 100% !important; max-width: 100% !important; margin: 0 !important; }
    }

    @page {
      size: A4;
      margin: 10mm;
    }

    *{ box-sizing: border-box; margin:0; padding:0; }

    body{
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background:#e9e9e9;
      display:flex;
      justify-content:center;
      padding:20px 0;
      color: #1e222b;
    }

    .report-container{
      width: 850px;
      background:#fff;
      box-shadow: 0 10px 30px rgba(0,0,0,0.15);
      overflow:hidden;
      border-radius: 8px;
    }

    /* ---------- HEADER ---------- */
    .header{
      position:relative;
      background:#fff;
      color:#fff;
      min-height:140px;
      overflow:hidden;
    }

    .header-panel-left{
      position:absolute;
      top:0; left:0; bottom:0;
      width:100%;
      background:var(--dark);
      clip-path: polygon(0 0, 37% 0, 44% 100%, 0% 100%);
    }

    .header-panel-right{
      position:absolute;
      top:0; left:0; bottom:0;
      width:100%;
      background:var(--dark);
      clip-path: polygon(38% 0, 100% 0, 100% 100%, 45% 100%);
    }

    .header-content{
      position:relative;
      z-index:2;
      display:flex;
      min-height:140px;
    }

    .header-left{
      width:44%;
      padding:30px 25px;
      display:flex;
      flex-direction:column;
      justify-content:center;
    }

    .logo{
      font-size:32px;
      font-weight:800;
      letter-spacing:1px;
      color:#ffffff;
      text-transform: uppercase;
    }
    .header-logo { max-height: 75px; max-width: 180px; object-fit: contain; }

    .header-right{
      flex:1;
      padding:25px 35px 25px 10px;
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
    }

    .invoice-to h4{
      color:var(--gold);
      font-size:13px;
      letter-spacing:1px;
      margin-bottom:6px;
      text-transform: uppercase;
      font-weight: 800;
    }

    .invoice-to p{
      font-size:14px;
      line-height:1.5;
      color:#ffffff;
      font-weight:700;
      text-transform: uppercase;
    }

    /* ---------- TITLE BAR ---------- */
    .title-bar{
      position:relative;
      background:var(--gold);
      color:#fff;
      min-height:80px;
      overflow:hidden;
    }

    .title-bar-panel-left{
      position:absolute;
      top:0; left:0; bottom:0;
      width:100%;
      background:#fff;
      clip-path: polygon(0 0, 45% 0, 48% 100%, 0% 100%);
    }

    .title-bar-panel-right{
      position:absolute;
      top:0; left:0; bottom:0;
      width:100%;
      background:var(--gold);
      clip-path: polygon(45.5% 0, 100% 0, 100% 100%, 48.5% 100%);
    }

    .title-bar-content{
      position:relative;
      z-index:2;
      display:flex;
      align-items:center;
      min-height:80px;
    }

    .title-left{
      width:48%;
      padding:0 25px;
      font-size:22px;
      font-weight:900;
      letter-spacing:2px;
      color:#1e222b;
      text-transform:uppercase;
    }

    .title-right{
      flex:1;
      display:flex;
      justify-content:flex-start;
      padding-left:15px;
      color:#1e222b;
    }

    .title-col{
      border-left:1px solid rgba(0,0,0,0.3);
      padding-left:18px;
      margin-right:20px;
    }

    .title-col:first-child{ border-left:none; padding-left:0; }

    .title-label{ font-size:10px; text-transform:uppercase; color:#222; font-weight:700; }
    .title-val{ font-size:12px; font-weight:800; margin-top:2px; }

    .content { padding: 24px 30px; }
    
    .box-green { background: #fafafa; border: 1px solid #eaeaea; border-top: 3px solid var(--dark); border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; page-break-inside: avoid; break-inside: avoid; }
    .box-yellow { background: #fafafa; border: 1px solid #eaeaea; border-top: 3px solid var(--gold); border-radius: 10px; padding: 18px 22px; margin-top: 20px; page-break-inside: avoid; break-inside: avoid; }
    
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eef0f2; font-size: 13px; }
    .row:last-child { border-bottom: none; }
    .row-key { color: #57606a; font-weight: 500; }
    .row-val { color: #1f2328; font-weight: 700; font-variant-numeric: tabular-nums; }
    
    .box-green .row { border-bottom: 1px solid #eaeaea; }
    .box-green .row:last-child { border-bottom: none; }
    .box-green .row-key { color: var(--dark); font-weight: 600; }
    .box-green .row-val { color: var(--dark); font-weight: 800; }
    
    .box-yellow .row { border-bottom: 1px dashed #eaeaea; }
    .box-yellow .row:last-child { border-bottom: none; }
    .box-yellow .row-key { color: var(--dark); font-weight: 500; }
    .box-yellow .row-val { color: var(--dark); font-weight: 700; }
    .box-yellow .section-title { color: var(--gold); font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; margin-top: 0; }

    .section-title { font-size: 11px; font-weight: 800; color: #6e7781; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; margin-top: 14px; }
    .grid { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid; }
    .col { flex: 1; min-width: 260px; }
    
    .total-row { border-top: 2px solid var(--dark); border-bottom: none; padding-top: 8px; font-weight: 800; font-size: 14px; }
    .total-row .row-key { color: var(--dark); font-weight: 800; }
    .total-row .row-val { color: var(--dark); font-weight: 800; font-size: 14px; }

    .footer-bar { background: var(--dark); color: #fff; padding: 18px 30px; font-size: 10px; border-top: 5px solid var(--gold); margin-top: 24px; display: flex; justify-content: space-between; align-items: center; }
    .thank-you { color: var(--gold); font-weight: 800; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="report-container">
    <div class="header">
      <div class="header-panel-left"></div>
      <div class="header-panel-right"></div>
      <div class="header-content">
        <div class="header-left">
          ${biz.logo ? `<img src="${biz.logo}" class="header-logo" />` : `<div class="logo">${esc(bizName || "Ledgr")}</div>`}
        </div>
        <div class="header-right">
          <div class="invoice-to">
            <h4>FINANCIAL REPORT</h4>
            <p>${esc(bizName || "Ledgr")}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="title-bar">
      <div class="title-bar-panel-left"></div>
      <div class="title-bar-panel-right"></div>
      <div class="title-bar-content">
        <div class="title-left">${esc(seg === 'Summary' ? 'REPORT' : seg.toUpperCase())}</div>
        <div class="title-right">
          <div class="title-col">
            <div class="title-label">Period</div>
            <div class="title-val">${esc(from)} to ${esc(to)}</div>
          </div>
          <div class="title-col">
            <div class="title-label">Generated</div>
            <div class="title-val">${new Date().toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="content">
`;

    let currentSection = "";
    let sections: { title: string; lines: string[] }[] = [];
    let currentLines: string[] = [];
    
    for (const l of lines) {
      if (!l.trim()) continue;
      if (l.startsWith("—") && l.includes("Sent from Ledgr")) continue;
      
      if (l.startsWith("—")) {
        if (currentLines.length > 0 || currentSection) {
          sections.push({ title: currentSection, lines: currentLines });
        }
        currentSection = l.replace(/—/g, "").trim();
        currentLines = [];
      } else {
        currentLines.push(l);
      }
    }
    if (currentLines.length > 0 || currentSection) {
      sections.push({ title: currentSection, lines: currentLines });
    }

    let htmlContent = "";
    
    const renderRow = (l: string, isLast: boolean) => {
      const parts = l.split(":");
      if (parts.length > 1) {
        const k = parts.shift()!;
        const v = parts.join(":");
        let valStyle = "";
        const valStr = v.trim();
        if (valStr.startsWith("+")) valStyle = "color:#2d5a37;font-weight:700;";
        else if (valStr.startsWith("-") || valStr.startsWith("−")) valStyle = "color:#a93226;font-weight:700;";

        const isTotal = k.toLowerCase().includes("total") || k.toLowerCase().includes("ending stake");
        return `<div class="row ${isLast ? 'no-border' : ''} ${isTotal ? 'total-row' : ''}">
          <span class="row-key">${esc(k.trim())}</span>
          <span class="row-val" style="${valStyle}">${esc(valStr)}</span>
        </div>`;
      }
      return `<div class="row ${isLast ? 'no-border' : ''}"><span class="row-key" style="color:#111;font-weight:700">${esc(l)}</span></div>`;
    };

    const renderSection = (s: { title: string; lines: string[] }, style: 'normal' | 'green' | 'yellow') => {
      if (style === 'green') {
        return `<div class="box-green">
          ${s.title ? `<div class="section-title" style="color:#2d5a37;font-size:13px;margin-bottom:8px;">${esc(s.title)}</div>` : ''}
          ${s.lines.map((l, i) => renderRow(l, i === s.lines.length - 1)).join("")}
        </div>`;
      } else if (style === 'yellow') {
        return `<div class="box-yellow">
          ${s.title ? `<div class="section-title" style="color:#a88117;font-size:15px;margin-bottom:12px;">${esc(s.title)}</div>` : ''}
          ${s.lines.map((l, i) => renderRow(l, i === s.lines.length - 1)).join("")}
        </div>`;
      } else {
        return `<div style="margin-bottom:20px;">
          ${s.title ? `<div class="section-title">${esc(s.title)}</div>` : ''}
          ${s.lines.map((l, i) => renderRow(l, i === s.lines.length - 1)).join("")}
        </div>`;
      }
    };
    
    if (sections.length === 1 && !sections[0].title) {
       htmlContent += renderSection(sections[0], 'normal');
    } else {
      let i = 0;
      if (sections[0] && (sections[0].title.toUpperCase().includes("LIVE") || sections[0].title.toUpperCase().includes("PROFIT") || sections[0].title.toUpperCase().includes("SUMMARY"))) {
        htmlContent += renderSection(sections[0], 'green');
        i++;
      } else if (sections.length > 1 && (!sections[0].title || sections[0].title === '')) {
        htmlContent += renderSection(sections[0], 'green');
        i++;
      }

      let gridSections: { title: string; lines: string[] }[] = [];
      let yellowSections: { title: string; lines: string[] }[] = [];

      while (i < sections.length) {
        const s = sections[i];
        const t = (s.title || "").toUpperCase();
        if (t.includes("PARTNER") || t.includes("RECONCILIATION") || t.includes("STAKE") || t.includes("LEGACY")) {
          yellowSections.push(s);
        } else {
          gridSections.push(s);
        }
        i++;
      }
      
      if (gridSections.length > 0) {
        htmlContent += `<div class="grid">`;
        const col1: any[] = [];
        const col2: any[] = [];
        
        gridSections.forEach((s) => {
          const t = (s.title || "").toUpperCase();
          if (t.includes("ASSET")) {
            col1.push(s);
          } else if (t.includes("LIABILIT") || t.includes("DRAWING")) {
            col2.push(s);
          } else {
            if (col1.length <= col2.length) col1.push(s);
            else col2.push(s);
          }
        });
        
        htmlContent += `<div class="col">${col1.map(s => renderSection(s, 'normal')).join("")}</div>`;
        if (col2.length > 0) {
          htmlContent += `<div class="col">${col2.map(s => renderSection(s, 'normal')).join("")}</div>`;
        }
        htmlContent += `</div>`;
      }
      
      yellowSections.forEach((s) => {
        htmlContent += renderSection(s, 'yellow');
      });
    }

    html += htmlContent;
    html += `
    </div>
    <div class="footer-bar">
      <div class="thank-you">Generated by Ledgr</div>
      <div>Official financial report for ${esc(bizName || "Ledgr")} &middot; ${new Date().toLocaleDateString()}</div>
    </div>
  </div>
</body>
</html>`;
    return html;
  };

  const shareWhatsApp = async () => {
    try { await Share.share({ message: buildText(), title: `${seg} Report` }); }
    catch (e) { console.warn(e); }
  };

  const sharePdf = async () => {
    try {
      if (!bizSettings) {
        const s = await api.getSettings().catch(() => ({}));
        setBizSettings(s);
      }
      const html = buildHtml();
      if (Platform.OS === 'web') {
        await printHtml(html, `${seg} Report`);
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const can = await Sharing.isAvailableAsync();
        if (can) {
          await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `${seg} Report` });
        } else {
          showAlert("Sharing Unavailable", "Sharing is not available on this device.");
        }
      }
    } catch (e: any) {
      console.warn(e);
      showAlert("Share Failed", e?.message || "Could not generate report PDF.");
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader 
        title="Reports" 
        subtitle="Financial statements"
        rightAction={
          <GlowPressable
            testID="btn-custom-report"
            onPress={() => router.push("/custom-report")}
            topHighlight={false}
            haptic
            hoverLift={-1}
            style={styles.customReportBtn}
          >
            <Ionicons name="options-outline" size={16} color={theme.color.brandPrimary} />
            <Text style={styles.customReportBtnText}>Custom Report</Text>
          </GlowPressable>
        }
      />

      {/* Report category segments */}
      <View style={styles.filterRail}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segScroll} contentContainerStyle={styles.segRow}
          scrollEventThrottle={16} onScroll={(event) => updateRailEdges(event, setSegmentEdges)}>
          {(bizSettings?.accountingStyle === 'retail_partnership' ? SEGMENTS : SEGMENTS.filter(s => s !== "Capital" && s !== "Drawings")).map((s) => (
            <GlowPressable
              key={s}
              testID={`report-seg-${s}`}
              topHighlight={false}
              haptic
              hoverLift={0}
              glowRadius={8}
              hoverScale={1.03}
              restingBorderColor={seg === s ? theme.color.brandPrimary : theme.color.border}
              onPress={() => setSeg(s)} style={[styles.seg, seg === s && styles.segActive]}>
              <Text style={[styles.segText, seg === s && styles.segTextActive]}>{s}</Text>
            </GlowPressable>
          ))}
        </ScrollView>
        {segmentEdges.left && <LinearGradient pointerEvents="none" colors={[theme.color.surface, "transparent"]} style={[styles.railFade, styles.railFadeLeft]} />}
        {segmentEdges.right && <LinearGradient pointerEvents="none" colors={["transparent", theme.color.surface]} style={[styles.railFade, styles.railFadeRight]} />}
      </View>

      {/* Date range preset filters */}
      <View style={styles.filterRail}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateScroll} contentContainerStyle={styles.dateRow}
          scrollEventThrottle={16} onScroll={(event) => updateRailEdges(event, setDateEdges)}>
          {RANGE_PRESETS.map((p) => (
            <GlowPressable
              key={p}
              topHighlight={false}
              haptic
              hoverLift={0}
              hoverScale={1.03}
              glowRadius={8}
              restingBorderColor={rangePresetSel === p ? theme.color.brandPrimary : theme.color.border}
              onPress={() => applyPreset(p)} style={[styles.dateChip, rangePresetSel === p && styles.dateChipActive]}>
              <Text style={[styles.dateChipText, rangePresetSel === p && styles.dateChipTextActive]}>{p}</Text>
            </GlowPressable>
          ))}
        </ScrollView>
        {dateEdges.left && <LinearGradient pointerEvents="none" colors={[theme.color.surface, "transparent"]} style={[styles.railFade, styles.railFadeLeft]} />}
        {dateEdges.right && <LinearGradient pointerEvents="none" colors={["transparent", theme.color.surface]} style={[styles.railFade, styles.railFadeRight]} />}
      </View>

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
          <GlowPressable topHighlight={false} prominent haptic hoverLift={-1} onPress={() => load()} style={styles.applyBtn}>
            <Text style={styles.applyText}>Apply</Text>
          </GlowPressable>
        </View>
      )}

      {/* Share bar */}
      <View style={styles.shareBar}>
        <GlowPressable topHighlight={false} haptic hoverLift={-1} onPress={shareWhatsApp} style={[styles.shareBtn, { backgroundColor: "#25D366" }]}>
          <Ionicons name="logo-whatsapp" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>WhatsApp</Text>
        </GlowPressable>
        <GlowPressable topHighlight={false} prominent haptic hoverLift={-1} onPress={sharePdf} style={[styles.shareBtn, { backgroundColor: theme.color.brandPrimary }]}>
          <Ionicons name="document-outline" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>PDF</Text>
        </GlowPressable>
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
              <Card testID="report-summary-live" style={{ backgroundColor: theme.color.brandPrimary + "15", borderColor: theme.color.brandPrimary, borderWidth: 1, elevation: 0, shadowOpacity: 0 }}>
                <Text style={[styles.rTitle, { color: theme.color.brandPrimary }]}>PROFIT (LIVE)</Text>
                <RowKV label="Sales" value={fmt(dash.totalSales)} theme={theme} styles={styles} />
                <RowKV label={reportSource === "v2" ? "Expenses" : "Purchases"} value={fmt(dash.totalPurchases)} theme={theme} styles={styles} />
                <RowKV label="Gross Profit" value={fmt(dash.grossProfit)} theme={theme} styles={styles} />
                <View style={styles.divider} />
                <RowKV label="Net Profit" value={fmt(dash.netProfit)} strong big theme={theme} styles={styles} />
              </Card>

              <View style={{ flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rTitle, { fontSize: 11, marginBottom: 8 }]}>ASSETS</Text>
                  <RowKV label="Cash" value={fmt(dash.cash)} theme={theme} styles={styles} />
                  <RowKV label="Inventory" value={fmt(dash.inventoryValue)} theme={theme} styles={styles} />
                  <RowKV label="Debtors" value={fmt(dash.accountsReceivable || 0)} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Total Assets" value={fmt(dash.cash + dash.inventoryValue + (dash.accountsReceivable || 0))} strong theme={theme} styles={styles} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rTitle, { fontSize: 11, marginBottom: 8 }]}>LIABILITIES</Text>
                  <RowKV label="Creditors" value={fmt(dash.liabilities)} theme={theme} styles={styles} />
                  <RowKV label="Suppliers" value={String(dash.suppliers)} theme={theme} styles={styles} />
                  <RowKV label="Net Worth" value={fmt(dash.netWorth)} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Liab. & Equity" value={fmt(dash.liabilities + dash.netWorth)} strong theme={theme} styles={styles} />
                </View>
              </View>

              {bizSettings?.accountingStyle === 'retail_partnership' && (
                <Card style={{ marginTop: theme.spacing.md, backgroundColor: theme.color.brandTertiary + "15", borderColor: theme.color.brandTertiary, borderWidth: 1, elevation: 0, shadowOpacity: 0 }} testID="report-summary-reconciliation">
                  <Text style={[styles.rTitle, { color: theme.color.onSurface }]}>PARTNER STAKES RECONCILIATION</Text>
                  <RowKV label="Total Profit (legacy)" value={fmt(legacy.totalProfit)} theme={theme} styles={styles} />
                  <RowKV label="Total Drawings (legacy)" value={fmt(legacy.totalDrawings)} theme={theme} styles={styles} danger />
                  {cap && cap.partners.map((p: any) => (
                    <RowKV key={p.name} label={`${p.name} — drawings`} value={fmt(p.drawings)} theme={theme} styles={styles} />
                  ))}
                  {cap && (
                    <>
                      <View style={styles.divider} />
                      <RowKV label="Closing Capital" value={fmt(cap.closingCapital)} strong big theme={theme} styles={styles} />
                    </>
                  )}
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
  filterRail: { position: "relative" },
  railFade: { position: "absolute", top: 0, bottom: 0, width: 34, zIndex: 10 },
  railFadeLeft: { left: 0 },
  railFadeRight: { right: 0 },
  segScroll: { height: 56, flexGrow: 0, marginTop: theme.spacing.xs, marginBottom: 6, overflow: "visible" },
  segRow: {
    flexDirection: "row", alignItems: "center", paddingLeft: theme.spacing.md, paddingRight: 44, paddingVertical: 10, gap: 6,
  },
  seg: {
    paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20,
    backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border,
  },
  segActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "600", fontSize: 13 },
  segTextActive: { color: "#fff", fontWeight: "700" },
  dateScroll: { height: 52, flexGrow: 0, marginTop: 4, marginBottom: 8, overflow: "visible" },
  dateRow: {
    flexDirection: "row", alignItems: "center", paddingLeft: theme.spacing.md, paddingRight: 44, paddingVertical: 10, gap: 4,
  },
  dateChip: {
    paddingVertical: 4, paddingHorizontal: 7, borderRadius: 12,
    backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border,
  },
  dateChipActive: { backgroundColor: theme.color.surfaceTertiary, borderColor: theme.color.brandPrimary },
  dateChipText: { color: theme.color.muted, fontWeight: "600", fontSize: 10 },
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
