import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Dimensions, TextInput, Share, Platform , Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { LineChart, PieChart } from "react-native-gifted-charts";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { fmt as fmtBase, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/utils/currency";
import { ScreenHeader, Card } from "@/src/components/UI";
import { printHtml } from "@/src/utils/print";
import { showAlert } from "@/src/utils/alerts";
import { GlowPressable } from "@/src/components/GlowPressable";
import { round2 } from "@/src/money";
import { v2Reports } from "@/src/accountingV2/runtime";
import { partnershipDisplayFromReports } from "@/src/accountingV2/reports";
import { buildStatementDocument } from "@/src/utils/statementDocument";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { getDataVersion } from "@/src/utils/dataVersion";
import { isCapabilityEnabled, reportSegmentsFor, selectedWorkspaceMetrics, type ReportSegmentKey } from "@/src/utils/capabilities";
import { metricsFromDashboard } from "@/src/utils/metrics";
import * as localDb from "@/src/db/local";

type Seg = ReportSegmentKey;

const PIE_COLORS = ["#4F8EF7", "#34C759", "#FF9500", "#AF52DE", "#FF2D55", "#5AC8FA", "#FFCC00"];

function normalizeCapitalStatement(value: any) {
  const partners = Array.isArray(value?.partners)
    ? value.partners
    : Array.isArray(value?.investors)
      ? value.investors
      : [];
  const openingCapital = Number(value?.openingCapital ?? partners.reduce((sum: number, partner: any) => sum + Number(partner.contributed || 0), 0));
  const totalDrawings = Number(value?.totalDrawings ?? partners.reduce((sum: number, partner: any) => sum + Number(partner.drawings || 0), 0));
  const closingCapital = Number(value?.closingCapital ?? partners.reduce((sum: number, partner: any) => sum + Number(partner.balance || 0), 0));
  return { ...value, partners, openingCapital, totalDrawings, closingCapital, otherDrawings: Number(value?.otherDrawings || 0) };
}

function rangePreset(preset: string): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const iso = (d: Date) => localTodayIso(d);
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

export default function ReportsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [seg, setSeg] = useState<Seg>("Summary");
  const [displaySeg, setDisplaySeg] = useState<Seg>("Summary");
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
  const [sectionLoading, setSectionLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [rangePresetSel, setRangePresetSel] = useState("This Month");
  const [from, setFrom] = useState(() => rangePreset("This Month").from);
  const [to, setTo] = useState(() => rangePreset("This Month").to);
  const [customFrom, setCustomFrom] = useState(() => rangePreset("This Month").from);
  const [customTo, setCustomTo] = useState(() => rangePreset("This Month").to);
  const [rangeNotice, setRangeNotice] = useState("");
  const [provisionalNotice, setProvisionalNotice] = useState("");
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [locationId, setLocationId] = useState("");
  const [segmentEdges, setSegmentEdges] = useState({ left: false, right: true });
  const [dateEdges, setDateEdges] = useState({ left: false, right: true });
  const visibleSegments = useMemo(() => reportSegmentsFor(bizSettings), [bizSettings]);
  const workspaceMetrics = useMemo(() => {
    const selected = new Set(selectedWorkspaceMetrics(bizSettings).map((metric) => metric.key));
    return metricsFromDashboard(dash, bizSettings?.workspaceMetricInputs || {}).filter((metric) => selected.has(metric.key));
  }, [bizSettings, dash]);
  useEffect(() => {
    if (!visibleSegments.includes(seg)) setSeg("Summary");
  }, [seg, visibleSegments]);
  const loadRequest = useRef(0);
  const sectionRequest = useRef(0);
  const loadedVersion = useRef(-1);
  const hasLoaded = useRef(false);
  const loadedSections = useRef(new Set<string>());

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
      setLoading(true); setRangeNotice("");
      setFrom(r.from); setTo(r.to);
      setCustomFrom(r.from); setCustomTo(r.to);
    } else {
      setCustomFrom(from); setCustomTo(to); setRangeNotice("");
    }
  };

  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    sectionRequest.current += 1;
    setSectionLoading(false);
    setLoading(true);
    setLoadError("");
    try {
      const [s, config] = await Promise.all([api.getSettings(), api.getV2BookConfig().catch(() => null)]);
      if (Platform.OS !== "web" && isCapabilityEnabled(s, "multi_location")) {
        const rows = await api.listLocations().catch(() => []);
        setShops((Array.isArray(rows) ? rows : []).map((row: any) => ({ id: String(row.id), name: String(row.name) })));
      } else {
        setShops([]);
      }
      const shopId = locationId || undefined;
      if (Platform.OS === "web") {
        const [range, current, pd] = await Promise.all([
          localDb.pnlRange(from, to),
          localDb.dashboard(),
          localDb.listPeriods(),
        ]);
        if (requestId !== loadRequest.current) return;
        setBizSettings({ ...s, accountingStyle: config?.style || s.accountingStyle || "standard" });
        setCurrSym(getCurrencySymbol(s.currency || "USD"));
        setBizName(s.businessName || "");
        setProvisionalNotice("");
        setDash({
          totalSales: range.revenue,
          totalPurchases: range.purchases,
          grossProfit: range.grossProfit,
          netProfit: range.netProfit,
          cash: current.cash,
          inventoryValue: current.inventoryValue,
          accountsReceivable: current.accountsReceivable,
          supplierAdvances: 0,
          otherAssets: current.extraAssetsTotal || 0,
          accountsPayable: current.liabilities,
          customerAdvances: 0,
          commissionPayable: current.outstandingCommission || 0,
          otherLiabilities: current.extraLiabTotal || 0,
          assets: current.assets,
          netWorth: current.netWorth,
          liabilities: current.totalLiabilities,
          suppliers: current.suppliers,
        });
        setPnl({
          revenue: range.revenue,
          cogs: range.cogs,
          grossProfit: range.grossProfit,
          operatingExpenses: range.expenses,
          managerCommissionPct: range.managerCommissionPct,
          commission: range.commission,
          drawings: range.drawings,
          netProfit: range.netProfit,
        });
        setBs(await localDb.balanceSheet());
        setTb(await localDb.trialBalance());
        setAssetDist(await localDb.assetDistribution());
        setPeriods(Array.isArray(pd) ? pd : []);
        loadedSections.current.clear();
        loadedVersion.current = getDataVersion();
        hasLoaded.current = true;
        setRangeNotice(`Showing ${from} to ${to} · Browser local summary`);
        return;
      }
      const [core, snapshotDash, pd] = await Promise.all([
        v2Reports({ from, to, locationId: shopId }),
        api.dashboard(shopId),
        api.listPeriods(),
      ]);
      if (requestId !== loadRequest.current) return;
      setBizSettings({ ...s, accountingStyle: config?.style || 'standard' });
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setBizName(s.businessName || "");
      {
        const report = core.report;
        setProvisionalNotice(report.provisionalReason || "");
        const current: any = snapshotDash;
        const commissionPct = Number(config?.retailPartnership?.commissionPct ?? s.managerCommissionPct ?? 0);
        const profit = partnershipDisplayFromReports(report, commissionPct);
        setDash({
          totalSales: report.profitAndLoss.revenue,
          totalPurchases: report.profitAndLoss.expenses,
          grossProfit: report.profitAndLoss.grossProfit,
          netProfit: profit.netProfit,
          cash: current.cash,
          inventoryValue: current.inventoryValue,
          accountsReceivable: current.accountsReceivable,
          supplierAdvances: current.supplierAdvances,
          otherAssets: current.otherAssets,
          accountsPayable: current.accountsPayable,
          customerAdvances: current.customerAdvances,
          commissionPayable: current.commissionPayable,
          otherLiabilities: current.otherLiabilities,
          assets: current.assets,
          netWorth: current.netWorth,
          liabilities: current.liabilities,
          suppliers: current.suppliers,
        });
        setPnl({
          revenue: report.profitAndLoss.revenue,
          cogs: report.profitAndLoss.cogs,
          grossProfit: report.profitAndLoss.grossProfit,
          // OpEx excludes posted 6100 so Gross − OpEx − Commission = overlay net.
          operatingExpenses: profit.operatingExpenses,
          managerCommissionPct: commissionPct,
          commission: profit.commission,
          drawings: 0,
          netProfit: profit.netProfit,
        });
        const tbAccounts = report.trialBalance.accounts || [];
        const findBal = (codes: string[]) => tbAccounts.filter((a: any) => codes.includes(a.code)).reduce((s: number, a: any) => s + (a.normalBalance || 0), 0);
        const cashBal = findBal(['1000', '1010', '1020', '1030']);
        const invBal = findBal(['1200']);
        const arBal = findBal(['1100']);
        const suppAdvBal = findBal(['1210']);
        const fixedAssetBal = findBal(['1400', '1450']);
        const otherAssetBal = findBal(['1300', '1500']);
        const totalAssets = report.balanceSheet?.assets ?? round2(cashBal + invBal + arBal + suppAdvBal + fixedAssetBal + otherAssetBal);

        const apBal = findBal(['2000']);
        const commPayBal = findBal(['2200']);
        const custAdvBal = findBal(['2100']);
        const taxPayBal = findBal(['2300', '2310']);
        const otherLiabBal = findBal(['2400', '2500']);
        const totalLiabilities = report.balanceSheet?.liabilities ?? round2(apBal + commPayBal + custAdvBal + taxPayBal + otherLiabBal);
        const equity = report.balanceSheet?.equity ?? round2(totalAssets - totalLiabilities);

        setBs({
          assets: { cash: cashBal, inventory: invBal, extra: [
            { name: "Customers", amount: arBal },
            { name: "Supplier Advances", amount: suppAdvBal },
            { name: "Fixed Assets (net)", amount: fixedAssetBal },
            { name: "Other Assets", amount: otherAssetBal },
          ].filter((a) => a.amount), total: totalAssets },
          liabilities: { suppliersPayable: apBal, extra: [
            { name: "Commission Payable", amount: commPayBal },
            { name: "Customer Advances", amount: custAdvBal },
            { name: "Tax Payable", amount: taxPayBal },
            { name: "Other Liabilities", amount: otherLiabBal },
          ].filter((l) => l.amount), total: totalLiabilities },
          equity,
        });
        setTb({
          debits: report.trialBalance.accounts.filter((a) => a.debit > 0).map((a) => ({ account: a.name, amount: a.debit })),
          credits: report.trialBalance.accounts.filter((a) => a.credit > 0).map((a) => ({ account: a.name, amount: a.credit })),
        });
        setAssetDist([
          { label: "Cash", value: cashBal },
          { label: "Inventory", value: invBal },
          { label: "Receivables", value: arBal },
          { label: "Other Assets", value: otherAssetBal },
        ].filter((item) => item.value !== 0));
      }
      setPeriods(Array.isArray(pd) ? pd : []);
      loadedSections.current.clear();
      loadedVersion.current = getDataVersion();
      hasLoaded.current = true;
      setRangeNotice(`Showing ${from} to ${to}`);
    } catch (e: any) {
      if (requestId === loadRequest.current) setLoadError(e?.message || "Reports could not be loaded.");
    } finally {
      if (requestId === loadRequest.current) { setLoading(false); setRefreshing(false); }
    }
  }, [from, to, locationId]);

  const loadSection = useCallback(async (section: Seg) => {
    const key = `${from}|${to}|${section}|${locationId}|${bizSettings?.accountingStyle || 'standard'}`;
    if (loadedSections.current.has(key)) return;
    const requestId = ++sectionRequest.current;
    setSectionLoading(true);
    try {
      if (Platform.OS === "web") {
        if (section === "Summary" && bizSettings?.accountingStyle === "retail_partnership") {
          const value = await localDb.capitalStatement(); if (requestId !== sectionRequest.current) return;
          setCap(normalizeCapitalStatement(value));
        } else if (section === "P&L") {
          const trend: any = await localDb.monthlyProfitTrend(6);
          if (requestId !== sectionRequest.current) return;
          setProfitTrend((Array.isArray(trend) ? trend : []).map((item: any) => ({ label: item.label || String(item.month || "").slice(5), profit: Number(item.profit ?? item.netProfit ?? 0) })));
        } else if (section === "Capital Statement") {
          const value = await localDb.capitalStatement(); if (requestId !== sectionRequest.current) return;
          setCap(normalizeCapitalStatement(value));
        } else if (section === "Capital Withdrawals") {
          const value = await localDb.drawingsHistory(); if (requestId !== sectionRequest.current) return; setDraws(Array.isArray(value) ? value : []);
        } else if (section === "Suppliers") {
          const value = await localDb.creditorsReport(from, to); if (requestId !== sectionRequest.current) return; setCreditors(Array.isArray(value) ? value : []);
        } else if (section === "Customers") {
          const value = await localDb.debtorsReport(from, to); if (requestId !== sectionRequest.current) return; setDebtors(Array.isArray(value) ? value : []);
        } else if (section === "Tax") {
          const value = await localDb.taxReport(from, to); if (requestId !== sectionRequest.current) return; setTaxRep(value);
        } else if (section === "Sales Reg") {
          const value: any = await localDb.salesRegister(from, to);
          if (requestId !== sectionRequest.current) return;
          setSalesReg({ ...(value || {}), rows: Array.isArray(value?.rows) ? value.rows : [] });
        } else if (section === "Receipts") {
          const value: any = await localDb.receiptsRegister(from, to);
          if (requestId !== sectionRequest.current) return;
          setReceiptsReg({ ...(value || {}), rows: Array.isArray(value?.rows) ? value.rows : [], byMethod: value?.byMethod || {} });
        }
      } else if (section === "Summary" && bizSettings?.accountingStyle === "retail_partnership") {
        const value = await api.capitalStatement(); if (requestId !== sectionRequest.current) return;
        setCap(normalizeCapitalStatement(value));
      } else if (section === "P&L") {
        const trend: any = await api.monthlyProfitTrend(6);
        if (requestId !== sectionRequest.current) return;
        setProfitTrend((Array.isArray(trend) ? trend : []).map((item: any) => ({
          label: item.label || String(item.month || "").slice(5),
          profit: Number(item.profit ?? item.netProfit ?? 0),
        })));
      } else if (section === "Capital Statement") {
        const value = await api.capitalStatement(); if (requestId !== sectionRequest.current) return;
        setCap(normalizeCapitalStatement(value));
      } else if (section === "Capital Withdrawals") {
        const value = await api.drawingsHistory(); if (requestId !== sectionRequest.current) return; setDraws(Array.isArray(value) ? value : []);
      } else if (section === "Suppliers") {
        const value = await api.creditorsReport(from, to, locationId || undefined); if (requestId !== sectionRequest.current) return; setCreditors(Array.isArray(value) ? value : []);
      } else if (section === "Customers") {
        const value = await api.debtorsReport(from, to, locationId || undefined); if (requestId !== sectionRequest.current) return; setDebtors(Array.isArray(value) ? value : []);
      } else if (section === "Tax") {
        const value = await api.taxReport(from, to); if (requestId !== sectionRequest.current) return; setTaxRep(value);
      } else if (section === "Sales Reg") {
        const value: any = await api.salesRegister(from, to);
        if (requestId !== sectionRequest.current) return;
        setSalesReg({ ...(value || {}), rows: Array.isArray(value?.rows) ? value.rows : [] });
      } else if (section === "Receipts") {
        const value: any = await api.receiptsRegister(from, to);
        if (requestId !== sectionRequest.current) return;
        setReceiptsReg({ ...(value || {}), rows: Array.isArray(value?.rows) ? value.rows : [], byMethod: value?.byMethod || {} });
      }
      loadedSections.current.add(key);
    } catch (e: any) {
      setLoadError(e?.message || `The ${section} report could not be loaded.`);
    } finally {
      if (requestId === sectionRequest.current) setSectionLoading(false);
    }
  }, [bizSettings?.accountingStyle, from, locationId, to]);

  useFocusEffect(useCallback(() => {
    if (hasLoaded.current && loadedVersion.current === getDataVersion()) return;
    load();
  }, [load]));

  useEffect(() => {
    if (loading || !hasLoaded.current) return;
    let active = true;
    void loadSection(seg).finally(() => {
      if (active) setDisplaySeg(seg);
    });
    return () => { active = false; };
  }, [loadSection, loading, seg]);

  // Custom fields are drafts. Reports change only when Apply succeeds, so
  // typing a partial date cannot silently issue a different report query.
  const applyCustomRange = () => {
    const f = normalizeDateInput(customFrom);
    if (!isValidDateString(f)) { showAlert("Invalid date", `Couldn't read "${customFrom.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    const t = normalizeDateInput(customTo);
    if (!isValidDateString(t)) { showAlert("Invalid date", `Couldn't read "${customTo.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (f > t) { showAlert("Invalid range", "The From date must be on or before the To date."); return; }
    setCustomFrom(f); setCustomTo(t); setLoading(true); setRangeNotice("Applying custom range…");
    if (f === from && t === to) { load(); return; }
    setFrom(f); setTo(t);
  };

  const screenW = Dimensions.get("window").width;

  // ------- Closed-period figures for the Summary tab -------
  const closedPeriodSummary = useMemo(() => {
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
        line("Customer Receivables", dash.accountsReceivable || 0),
        line("Total Assets", dash.assets),
        ``,
        `— LIABILITIES`,
        line("Supplier Payables", dash.accountsPayable || 0),
        line("Total Liabilities", dash.liabilities),
        `Registered Suppliers: ${dash.suppliers}`,
        line("Net Worth (Equity)", dash.netWorth),
        ``,
        ...(bizSettings?.accountingStyle === 'retail_partnership' ? [
          `— CAPITAL ACCOUNTS RECONCILIATION`,
          line("Closed-period Profit", closedPeriodSummary.totalProfit),
          line("Closed-period Capital Withdrawals", closedPeriodSummary.totalDrawings),
          ...(cap ? cap.partners.map((p: any) => line(`${p.name} capital withdrawn`, p.drawings)) : []),
          cap ? line("Closing Capital", cap.closingCapital) : "",
        ] : []),
      ].join("\n");
    } else if (seg === "P&L" && pnl) {
      body = [
        line("Revenue", pnl.revenue),
        line("COGS", pnl.cogs),
        line("Gross Profit", pnl.grossProfit),
        line("Operating Expenses", pnl.operatingExpenses || 0),
        ...(pnl.managerCommissionPct > 0 ? [line(`Manager Commission (${pnl.managerCommissionPct}%)`, pnl.commission)] : []),
        line("Net Profit", pnl.netProfit),
      ].join("\n");
    } else if (seg === "Balance" && bs) {
      body = [line("Total Assets", bs.assets.total), line("Total Liabilities", bs.liabilities.total), line("Equity", bs.equity)].join("\n");
    } else if (seg === "Capital Statement" && cap) {
      body = [line("Opening Capital", cap.openingCapital), line("Net Profit", cap.netProfit), line("Capital Withdrawn", cap.totalDrawings), line("Closing Capital", cap.closingCapital)].join("\n");
    } else if (seg === "Suppliers") {
      body = creditors.map((c) => `${c.name}: ${fmt(c.balance)}`).join("\n") || "No supplier balances.";
    } else if (seg === "Customers") {
      body = debtors.map((d) => `${d.name}: ${fmt(d.balance)}`).join("\n") || "No customer balances.";
    } else if (seg === "Capital Withdrawals") {
      body = draws.map((d) => `${d.partnerName} ${shortDate(d.date)}: ${fmt(d.amount)}`).join("\n") || "No capital withdrawals.";
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
  const buildHtml = (): string => buildStatementDocument({
    businessName: bizName || "Ledgr",
    title: seg === "Summary" ? "Financial Statement" : `${seg} Report`,
    from,
    to,
    text: buildText(),
    accent: theme.color.brandPrimary,
  });

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
        subtitle={locationId ? "Selected location" : "All locations"}
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
      {shops.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locationScroll} contentContainerStyle={styles.locationRow}>
          <GlowPressable accessibilityRole="radio" accessibilityLabel="All locations" accessibilityState={{ selected: !locationId }} onPress={() => setLocationId("")} topHighlight={false} haptic={false} hoverLift={0} style={[styles.locationChip, !locationId && styles.locationChipActive]}>
            <Text style={[styles.locationChipText, !locationId && styles.locationChipTextActive]}>All locations</Text>
          </GlowPressable>
          {shops.map((shop) => (
            <GlowPressable key={shop.id} accessibilityRole="radio" accessibilityLabel={shop.name} accessibilityState={{ selected: locationId === shop.id }} onPress={() => setLocationId(shop.id)} topHighlight={false} haptic={false} hoverLift={0} style={[styles.locationChip, locationId === shop.id && styles.locationChipActive]}>
              <Text style={[styles.locationChipText, locationId === shop.id && styles.locationChipTextActive]}>{shop.name}</Text>
            </GlowPressable>
          ))}
        </ScrollView>
      ) : null}
      {Platform.OS === "web" ? <View accessibilityRole="alert" style={styles.browserNotice}><Ionicons name="information-circle-outline" size={18} color={theme.color.warning} /><Text style={styles.browserNoticeText}>Browser local summary — this view reads the device’s local AsyncStorage book. Native SQLite reports and location-scoped ledger filters are available in the mobile app.</Text></View> : null}
      {provisionalNotice && locationId ? <View accessibilityRole="alert" style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: theme.color.warning + "66", backgroundColor: theme.color.surfaceSecondary, flexDirection: "row", gap: 8 }}><Ionicons name="information-circle-outline" size={18} color={theme.color.warning} /><Text style={{ flex: 1, color: theme.color.onSurface, fontSize: 12, lineHeight: 17 }}>{provisionalNotice}</Text></View> : null}

      {/* Report category segments */}
      <View style={styles.filterRail}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segScroll} contentContainerStyle={styles.segRow}
          scrollEventThrottle={16} onScroll={(event) => updateRailEdges(event, setSegmentEdges)}>
          {visibleSegments.map((s) => (
            <GlowPressable
              key={s}
              testID={`report-seg-${s}`}
              topHighlight={false}
              haptic
              hoverLift={0}
              glowRadius={8}
              hoverScale={1.03}
              restingBorderColor={seg === s ? theme.color.brandPrimary : theme.color.border}
              accessibilityRole="radio"
              accessibilityLabel={`${s} report`}
              accessibilityState={{ selected: seg === s }}
              onPress={() => setSeg(s)} style={[styles.seg, seg === s && styles.segActive]}>
              <Text style={[styles.segText, seg === s && styles.segTextActive]}>{s}</Text>
            </GlowPressable>
          ))}
        </ScrollView>
        {segmentEdges.left && <LinearGradient colors={[theme.color.surface, "transparent"]} style={[styles.railFade, styles.railFadeLeft, { pointerEvents: "none" }]} />}
        {segmentEdges.right && <LinearGradient colors={["transparent", theme.color.surface]} style={[styles.railFade, styles.railFadeRight, { pointerEvents: "none" }]} />}
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
              accessibilityRole="radio"
              accessibilityLabel={`${p} date range`}
              accessibilityState={{ selected: rangePresetSel === p }}
              onPress={() => applyPreset(p)} style={[styles.dateChip, rangePresetSel === p && styles.dateChipActive]}>
              <Text style={[styles.dateChipText, rangePresetSel === p && styles.dateChipTextActive]}>{p}</Text>
            </GlowPressable>
          ))}
        </ScrollView>
        {dateEdges.left && <LinearGradient colors={[theme.color.surface, "transparent"]} style={[styles.railFade, styles.railFadeLeft, { pointerEvents: "none" }]} />}
        {dateEdges.right && <LinearGradient colors={["transparent", theme.color.surface]} style={[styles.railFade, styles.railFadeRight, { pointerEvents: "none" }]} />}
      </View>

      {/* Custom date inputs (shown when Custom selected) */}
      {rangePresetSel === "Custom" && (
        <View>
        <View style={styles.customRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.customLabel}>From</Text>
            <TextInput value={customFrom} onChangeText={setCustomFrom} onBlur={() => { if (customFrom.trim()) setCustomFrom(normalizeDateInput(customFrom)); }} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.customInput} autoCapitalize="none" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.customLabel}>To</Text>
            <TextInput value={customTo} onChangeText={setCustomTo} onBlur={() => { if (customTo.trim()) setCustomTo(normalizeDateInput(customTo)); }} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.customInput} autoCapitalize="none" />
          </View>
          <GlowPressable accessibilityRole="button" accessibilityLabel="Apply custom date range" topHighlight={false} prominent haptic hoverLift={-1} onPress={() => applyCustomRange()} style={styles.applyBtn}>
            <Text style={styles.applyText}>Apply</Text>
          </GlowPressable>
        </View>
        {rangeNotice ? <Text style={styles.rangeNotice}>{rangeNotice}</Text> : null}
        </View>
      )}

      {/* Share bar */}
      <View style={styles.shareBar}>
        <GlowPressable accessibilityRole="button" accessibilityLabel="Share report to WhatsApp" topHighlight={false} haptic hoverLift={-1} onPress={shareWhatsApp} style={[styles.shareBtn, { backgroundColor: "#25D366" }]}>
          <Ionicons name="logo-whatsapp" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>WhatsApp</Text>
        </GlowPressable>
        <GlowPressable accessibilityRole="button" accessibilityLabel="Export report PDF" topHighlight={false} prominent haptic hoverLift={-1} onPress={sharePdf} style={[styles.shareBtn, { backgroundColor: theme.color.brandPrimary }]}>
          <Ionicons name="document-outline" size={16} color="#fff" />
          <Text style={styles.shareBtnText}>PDF</Text>
        </GlowPressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { loadedSections.current.clear(); setRefreshing(true); load(); }} />}
      >
          {loading ? <View accessibilityLiveRegion="polite" style={styles.inlineLoading}><ActivityIndicator color={theme.color.brandPrimary} /><Text style={styles.inlineLoadingText}>{hasLoaded.current ? "Refreshing report…" : "Loading report…"}</Text></View> : null}
          {loadError ? (
            <Card style={{ marginBottom: theme.spacing.md, borderColor: theme.color.error, borderWidth: 1 }}>
              <Text style={[styles.hint, { color: theme.color.error }]}>{loadError}</Text>
              <Pressable onPress={() => { setLoadError(""); loadedSections.current.clear(); load(); }} style={{ paddingTop: 10 }}>
                <Text style={{ color: theme.color.brandPrimary, fontWeight: "700" }}>Try again</Text>
              </Pressable>
            </Card>
          ) : null}
          {sectionLoading ? <View accessibilityLiveRegion="polite" style={styles.inlineLoading}><ActivityIndicator color={theme.color.brandPrimary} /><Text style={styles.inlineLoadingText}>Refreshing report…</Text></View> : null}
          {displaySeg === "Summary" && dash && (
            <>
              <Card testID="report-summary-live" style={{ backgroundColor: theme.color.brandPrimary + "15", borderColor: theme.color.brandPrimary, borderWidth: 1, elevation: 0, shadowOpacity: 0 }}>
                <Text style={[styles.rTitle, { color: theme.color.brandPrimary }]}>PROFIT (LIVE)</Text>
                <RowKV label="Sales" value={fmt(dash.totalSales)} theme={theme} styles={styles} />
                <RowKV label="Expenses" value={fmt(dash.totalPurchases)} theme={theme} styles={styles} />
                <RowKV label="Gross Profit" value={fmt(dash.grossProfit)} theme={theme} styles={styles} />
                <View style={styles.divider} />
                <RowKV label="Net Profit" value={fmt(dash.netProfit)} strong big theme={theme} styles={styles} />
              </Card>

              {workspaceMetrics.length > 0 && <Card style={{ marginTop: theme.spacing.md }} testID="report-workspace-metrics">
                <Text style={styles.rTitle}>Workspace metrics</Text>
                <Text style={styles.hint}>Only the metrics selected during setup are shown here. Add missing inputs from Workspace capabilities when needed.</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 10 }}>
                  {workspaceMetrics.map((metric) => <View key={metric.key} style={{ width: 126, padding: 10, borderRadius: 12, backgroundColor: theme.color.surfaceSecondary }}><Text style={{ color: theme.color.muted, fontSize: 10, fontWeight: "800" }}>{metric.label}</Text><Text style={{ color: metric.value === null ? theme.color.muted : theme.color.onSurface, fontSize: 16, fontWeight: "900", marginTop: 4 }}>{metric.value === null ? "—" : metric.unit === "percent" ? `${metric.value}%` : metric.unit === "ratio" ? String(metric.value) : fmt(metric.value)}</Text><Text style={{ color: metric.value === null ? theme.color.warning : theme.color.muted, fontSize: 9, lineHeight: 12, marginTop: 3 }} numberOfLines={3}>{metric.value === null ? metric.explanation : metric.state === "estimated" ? "Estimated" : "Posted inputs"}</Text></View>)}
                </ScrollView>
              </Card>}

              <View style={{ flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rTitle, { fontSize: 11, marginBottom: 8 }]}>ASSETS</Text>
                  <RowKV label="Cash" value={fmt(dash.cash)} theme={theme} styles={styles} />
                  <RowKV label="Inventory" value={fmt(dash.inventoryValue)} theme={theme} styles={styles} />
                  <RowKV label="Customers" value={fmt(dash.accountsReceivable || 0)} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Other assets" value={fmt((dash.supplierAdvances || 0) + (dash.otherAssets || 0))} theme={theme} styles={styles} />
                  <RowKV label="Total Assets" value={fmt(dash.assets)} strong theme={theme} styles={styles} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rTitle, { fontSize: 11, marginBottom: 8 }]}>LIABILITIES</Text>
                  <RowKV label="Supplier Payables" value={fmt(dash.accountsPayable || 0)} theme={theme} styles={styles} />
                  <RowKV label="Other liabilities" value={fmt((dash.customerAdvances || 0) + (dash.commissionPayable || 0) + (dash.otherLiabilities || 0))} theme={theme} styles={styles} />
                  <RowKV label="Suppliers" value={String(dash.suppliers)} theme={theme} styles={styles} />
                  <RowKV label="Net Worth" value={fmt(dash.netWorth)} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Liab. & Equity" value={fmt(dash.liabilities + dash.netWorth)} strong theme={theme} styles={styles} />
                </View>
              </View>

              {bizSettings?.accountingStyle === 'retail_partnership' && (
                <Card style={{ marginTop: theme.spacing.md, backgroundColor: theme.color.brandTertiary + "15", borderColor: theme.color.brandTertiary, borderWidth: 1, elevation: 0, shadowOpacity: 0 }} testID="report-summary-reconciliation">
                  <Text style={[styles.rTitle, { color: theme.color.onSurface }]}>CAPITAL ACCOUNTS RECONCILIATION</Text>
                  <RowKV label="Closed-period Profit" value={fmt(closedPeriodSummary.totalProfit)} theme={theme} styles={styles} />
                  <RowKV label="Closed-period Capital Withdrawals" value={fmt(closedPeriodSummary.totalDrawings)} theme={theme} styles={styles} danger />
                  {cap && cap.partners.map((p: any) => (
                    <RowKV key={p.name} label={`${p.name} — capital withdrawn`} value={fmt(p.drawings)} theme={theme} styles={styles} />
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

          {displaySeg === "P&L" && pnl && (
            <>
              <Card testID="report-pnl">
                <Text style={styles.rTitle}>Profit &amp; Loss</Text>
                <RowKV label="Revenue" value={fmt(pnl.revenue)} theme={theme} styles={styles} />
                <RowKV label="Cost of Goods Sold" value={`- ${fmt(pnl.cogs)}`} theme={theme} styles={styles} />
                <RowKV label="Gross Profit" value={fmt(pnl.grossProfit)} strong theme={theme} styles={styles} />
                <RowKV label="Operating Expenses" value={`- ${fmt(pnl.operatingExpenses || 0)}`} theme={theme} styles={styles} />
                {pnl.managerCommissionPct > 0 && (
                  <RowKV label={`Manager Commission (${pnl.managerCommissionPct}%)`} value={`- ${fmt(pnl.commission)}`} theme={theme} styles={styles} />
                )}
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

          {displaySeg === "Balance" && bs && (
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

          {displaySeg === "Trial" && tb && (
            <Card testID="report-tb">
              <Text style={styles.rTitle}>Trial Balance</Text>
              <Text style={styles.groupHeader}>Debits</Text>
              {tb.debits.map((d: any) => <RowKV key={d.account} label={d.account} value={fmt(d.amount)} theme={theme} styles={styles} />)}
              <Text style={styles.groupHeader}>Credits</Text>
              {tb.credits.map((c: any) => <RowKV key={c.account} label={c.account} value={fmt(c.amount)} theme={theme} styles={styles} />)}
            </Card>
          )}

          {displaySeg === "Capital Statement" && cap && (
            <Card testID="report-capital">
              <Text style={styles.rTitle}>Capital Statement</Text>
              <RowKV label="Opening Capital (combined)" value={fmt(cap.openingCapital)} theme={theme} styles={styles} />
              <RowKV label="Net Profit" value={`+ ${fmt(cap.netProfit)}`} theme={theme} styles={styles} />
              <RowKV label="Capital Withdrawn" value={`- ${fmt(cap.totalDrawings)}`} theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Closing Capital" value={fmt(cap.closingCapital)} strong big theme={theme} styles={styles} />

              <Text style={styles.groupHeader}>Withdrawals by Capital Account</Text>
              {cap.partners.map((p: any) => (
                <RowKV key={p.name} label={p.name} value={fmt(p.drawings)} theme={theme} styles={styles} />
              ))}
              {cap.otherDrawings > 0 && (
                <RowKV label="Other / Unattributed" value={fmt(cap.otherDrawings)} theme={theme} styles={styles} />
              )}
            </Card>
          )}

          {displaySeg === "Capital Withdrawals" && (
            <Card testID="report-drawings">
              <Text style={styles.rTitle}>Capital Withdrawals</Text>
              {draws.length === 0 ? (
                <Text style={styles.empty}>No capital withdrawals recorded yet.</Text>
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

          {displaySeg === "Suppliers" && (
            <Card testID="report-creditors">
              <Text style={styles.rTitle}>Supplier Balances</Text>
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

          {displaySeg === "Customers" && (
            <Card testID="report-debtors">
              <Text style={styles.rTitle}>Customer Balances</Text>
              <Text style={styles.hint}>{from} → {to}</Text>
              {debtors.length === 0 ? (
                <Text style={styles.empty}>No customer balances found. Add customers from Accounts.</Text>
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

          {displaySeg === "Tax" && taxRep && (
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

          {displaySeg === "Sales Reg" && salesReg && (
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

          {displaySeg === "Receipts" && receiptsReg && (
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
  locationScroll: { height: 52, flexGrow: 0, marginBottom: 2, overflow: "hidden" },
  locationRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.spacing.lg, gap: 8 },
  locationChip: { minHeight: 40, maxHeight: 40, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.color.border, backgroundColor: "transparent" },
  locationChipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary },
  locationChipText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 13 },
  locationChipTextActive: { color: "#fff" },
  filterRail: { position: "relative", height: 56 },
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
  rangeNotice: { color: theme.color.muted, fontSize: 11, paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
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
  browserNotice: { marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.color.warning + "66", backgroundColor: theme.color.surfaceSecondary, flexDirection: "row", gap: 8 },
  browserNoticeText: { flex: 1, color: theme.color.onSurface, fontSize: 12, lineHeight: 17 },
  inlineLoading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 10 },
  inlineLoadingText: { color: theme.color.muted, fontSize: 12, fontWeight: "600" },
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
