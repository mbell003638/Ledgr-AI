import React, { useCallback, useMemo, useState } from "react";
import { Platform, View, Text, StyleSheet, Pressable, RefreshControl, ActivityIndicator, TextInput , InteractionManager, ScrollView } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BarChart } from "react-native-gifted-charts";


import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getDataVersion } from "@/src/utils/dataVersion";
import { ScreenHeader, KpiTile, Card } from "@/src/components/UI";
import { sharePlainText } from "@/src/utils/share";
import { isCapabilityEnabled } from "@/src/utils/capabilities";
import { showAlert } from "@/src/utils/alerts";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import Animated from "react-native-reanimated";
import { GlowPressable } from "@/src/components/GlowPressable";
import ArrowLeftRight from "lucide-react-native/icons/arrow-left-right";
import Package from "lucide-react-native/icons/package";
import Receipt from "lucide-react-native/icons/receipt";
import TrendingUp from "lucide-react-native/icons/trending-up";

type Dash = {
  assets: number; liabilities: number; netWorth: number;
  cash: number; inventoryValue: number;
  openingBalance: number; openingInventory: number; openingCash: number;
  closingBalance: number;
  totalPurchases: number; totalSales: number; grossProfit: number;
  managerCommissionPct: number; commission: number; netProfit: number;
  drawings: number; supplierPayments: number; suppliers: number;
  periodStart: string;
  salesTrend: { date: string; value: number }[];
};

type WorkflowTile = {
  key: string;
  label: string;
  subtitle: string;
  icon: string;
  color: string;
  capability: string;
  route: string;
};

const WORKFLOW_TILES: WorkflowTile[] = [
  { key: "purchases", label: "Purchases", subtitle: "", icon: "receipt-outline", color: "#34D399", capability: "procurement", route: "/bills" },
  { key: "sales", label: "Sales", subtitle: "", icon: "trending-up-outline", color: "#FBBF24", capability: "commerce", route: "/sales" },
  { key: "receipts", label: "Receipts", subtitle: "", icon: "arrow-down-outline", color: "#60A5FA", capability: "customers", route: "/receipts" },
  { key: "payments", label: "Payments", subtitle: "", icon: "card-outline", color: "#F87171", capability: "procurement", route: "/payments" },
  { key: "cashbook", label: "Cash Book", subtitle: "", icon: "swap-horizontal-outline", color: "#C084FC", capability: "cashbook", route: "/cashbook" },
  { key: "invoices", label: "Invoices", subtitle: "", icon: "document-text-outline", color: "#38BDF8", capability: "invoicing", route: "/invoices" },
  { key: "quotes", label: "Quotes", subtitle: "", icon: "pricetag-outline", color: "#FBBF24", capability: "invoicing", route: "/quotes" },
  { key: "delivery", label: "Delivery Notes", subtitle: "", icon: "cube-outline", color: "#A7F3D0", capability: "shipping_returns", route: "/delivery-notes" },
  { key: "expenses", label: "Expenses", subtitle: "", icon: "wallet-outline", color: "#F87171", capability: "core_ledger", route: "/expenses" },
  { key: "stock", label: "Stock", subtitle: "", icon: "cube-outline", color: "#34D399", capability: "inventory", route: "/products" },
  { key: "assets", label: "Assets & Liabilities", subtitle: "", icon: "pie-chart-outline", color: "#818CF8", capability: "core_ledger", route: "/assets" },
  { key: "daybook", label: "Day Book", subtitle: "", icon: "book-outline", color: "#EC4899", capability: "core_ledger", route: "/daybook" },
  { key: "reports", label: "Reports", subtitle: "", icon: "bar-chart-outline", color: "#FBBF24", capability: "reporting", route: "/reports" },
  { key: "monthly-report", label: "Monthly Report", subtitle: "", icon: "calendar-outline", color: "#F97316", capability: "reporting", route: "/monthly-summary" },
  { key: "ask-ai", label: "Ask AI", subtitle: "", icon: "sparkles-outline", color: "#A7F3D0", capability: "ai_assistant", route: "/ask" },
  { key: "ai-assistant", label: "AI Assistant", subtitle: "", icon: "mic-outline", color: "#A7F3D0", capability: "ai_assistant", route: "/voice" },
];

function workflowTilesFor(settings: any): WorkflowTile[] {
  const hasCommerce = isCapabilityEnabled(settings, "commerce");
  return WORKFLOW_TILES.filter((tile) => {
    if (tile.key === "sales") return hasCommerce;
    if (tile.key === "receipts") return isCapabilityEnabled(settings, "customers") || isCapabilityEnabled(settings, "invoicing");
    return isCapabilityEnabled(settings, tile.capability as any);
  });
}

function AnimatedHeroCard({ children, theme }: { children: React.ReactNode; theme: ReturnType<typeof useTheme> }) {
  // Keep the hero on the same safe transform-only touch treatment as every
  // interactive dashboard tile. Native shadows are deliberately not animated.
  return (
    <GlowPressable
      topHighlight={false}
      haptic={false}
      clipSafe
      pressScale={0.972}
      restingBorderColor="transparent"
      hoverBorderColor={theme.color.brandPrimary}
      style={{ borderRadius: theme.radius.lg, marginBottom: 16, shadowOffset: { width: 0, height: 10 } }}
    >
      {children}
    </GlowPressable>
  );
}
export default function Dashboard() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [dash, setDash] = useState<Dash | null>(null);
  const [daily, setDaily] = useState<any>(null);
  const localTodayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [dailyDate, setDailyDate] = useState(localTodayStr);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState<any>({});
  const [shops, setShops] = useState<{ id: string; name: string }[]>([]);
  const [locationId, setLocationId] = useState("");
  // Remember the (data version, dailyDate) at which the dashboard last loaded,
  // so a plain focus-return with nothing changed can skip the full re-read.
  const loadedRef = React.useRef<{ version: number; date: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      let shopId = locationId || (s.activeLocationId ? String(s.activeLocationId) : "");
      if (!locationId && shopId) setLocationId(shopId);
      if (isCapabilityEnabled(s, "multi_location")) {
        const rows = await api.listLocations().catch(() => []);
        const next = (Array.isArray(rows) ? rows : []).map((row: any) => ({ id: String(row.id), name: String(row.name) }));
        setShops(next);
        if (shopId && !next.some((shop) => shop.id === shopId)) shopId = "";
      } else {
        setShops([]);
        shopId = "";
      }
      const [d, day] = await Promise.all([
        api.dashboard(shopId || undefined),
        api.dailySummary(dailyDate),
      ]);
      setDash(d);
      setDaily(day);
      loadedRef.current = { version: getDataVersion(), date: dailyDate };
    } catch (e) {
      console.warn("dash", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dailyDate, locationId]);

  useFocusEffect(useCallback(() => {
    const last = loadedRef.current;
    const upToDate = last != null && last.version === getDataVersion() && last.date === dailyDate;
    if (upToDate) return; // nothing changed since last load — instant return
    // Defer the heavy dashboard aggregation past the tab/entering animation.
    const task = InteractionManager.runAfterInteractions(() => { load(); });
    return () => task.cancel();
  }, [load, dailyDate]));

  const onRefresh = () => { setRefreshing(true); load(); };

  const shareDaily = async () => {
    if (!daily) return;
    const dLabel = new Date(dailyDate + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    const lines = [
      `Ledgr — Daily Summary`,
      dLabel,
      ``,
      `Sales: ${fmt(daily.revenue)} (${daily.salesCount})`,
      `Purchases: ${fmt(daily.purchases)} (${daily.billsCount})`,
      `Gross Profit: ${fmt(daily.grossProfit)}`,
      `Net Cash: ${fmt(daily.netCash)}`,
    ];
    if (daily.drawings > 0) lines.push(`Capital withdrawn: ${fmt(daily.drawings)}`);
    lines.push(``, `— Sent from Ledgr`);
    await sharePlainText(lines.join("\n"), `Ledgr — ${dLabel}`);
  };

  const shiftDay = (delta: number) => {
    const d = new Date(dailyDate + "T00:00");
    d.setDate(d.getDate() + delta);
    setDailyDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  };
  const jumpToToday = () => setDailyDate(localTodayStr());
  const today = localTodayStr();
  const isToday = dailyDate === today;
  const dailyLabel = new Date(dailyDate + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  const barData = (dash?.salesTrend || []).map((s) => ({
    value: s.value,
    label: s.date.slice(5),
    frontColor: theme.color.brandSecondary,
  }));

  const [periodPreset, setPeriodPreset] = useState<"all" | "today" | "this_month" | "custom">("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rangeData, setRangeData] = useState<any>(null);

  const applyPeriod = useCallback(async (preset: "all" | "today" | "this_month" | "custom", fStr?: string, tStr?: string) => {
    setPeriodPreset(preset);
    const nowStr = localTodayStr();
    let f = fStr ?? fromDate;
    let t = tStr ?? toDate;

    if (preset === "all") {
      setFromDate(""); setToDate(""); setRangeData(null); return;
    } else if (preset === "today") {
      f = nowStr; t = nowStr;
      setFromDate(f); setToDate(t);
    } else if (preset === "this_month") {
      f = `${nowStr.slice(0, 7)}-01`; t = nowStr;
      setFromDate(f); setToDate(t);
    } else if (preset === "custom" && f.trim() && t.trim()) {
      // Typed dates: normalize (Samsung minus signs, DD/MM, dots, exotic digits)
      // then validate, reflecting the canonical form back into the inputs.
      const rawF = f, rawT = t;
      f = normalizeDateInput(f); t = normalizeDateInput(t);
      if (!isValidDateString(f)) { showAlert("Invalid date", `Couldn't read "${rawF.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
      if (!isValidDateString(t)) { showAlert("Invalid date", `Couldn't read "${rawT.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
      setFromDate(f); setToDate(t);
    }

    if (f && t) {
      try {
        const res = await api.pnlRange(f, t);
        setRangeData(res);
      } catch (e) { console.warn(e); }
    }
  }, [fromDate, toDate]);

  const displaySales = rangeData ? rangeData.revenue : (dash?.totalSales ?? 0);
  const displayPurchases = rangeData ? rangeData.purchases : (dash?.totalPurchases ?? 0);
  const displayGross = rangeData ? rangeData.grossProfit : (dash?.grossProfit ?? 0);
  const displayCommission = rangeData ? rangeData.commission : (dash?.commission ?? 0);
  const displayNetProfit = rangeData ? rangeData.netProfit : (dash?.netProfit ?? 0);
  const displayDrawings = rangeData ? rangeData.drawings : (dash?.drawings ?? 0);
  const salesEnabled = isCapabilityEnabled(settings, "commerce") || isCapabilityEnabled(settings, "invoicing");
  const purchasesEnabled = isCapabilityEnabled(settings, "procurement");
  const stockEnabled = isCapabilityEnabled(settings, "inventory");
  const salesRoute = isCapabilityEnabled(settings, "commerce") ? "/sales" : "/invoices";
  const workflowTiles = workflowTilesFor(settings);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Ledgr" subtitle="Your business finances, simplified" testID="dashboard-header" style={styles.homeHeader} titleStyle={styles.homeHeaderTitle} subtitleStyle={styles.homeHeaderSubtitle} />
      <Animated.ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandPrimary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && !dash ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
        ) : (
          <>
            {shops.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}><Pressable accessibilityRole="radio" accessibilityLabel="All locations" accessibilityState={{ selected: !locationId }} onPress={() => { setLocationId(""); void api.updateSettings({ activeLocationId: "" }); }} style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 15, borderWidth: 1, borderColor: !locationId ? theme.color.brandPrimary : theme.color.border, backgroundColor: !locationId ? theme.color.brandPrimary : "transparent" }}><Text style={{ color: !locationId ? "#fff" : theme.color.onSurface, fontSize: 11, fontWeight: "800" }}>All locations</Text></Pressable>{shops.map((shop) => <Pressable key={shop.id} accessibilityRole="radio" accessibilityLabel={shop.name} accessibilityState={{ selected: locationId === shop.id }} onPress={() => { setLocationId(shop.id); void api.updateSettings({ activeLocationId: shop.id }); }} style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 15, borderWidth: 1, borderColor: locationId === shop.id ? theme.color.brandPrimary : theme.color.border, backgroundColor: locationId === shop.id ? theme.color.brandPrimary : "transparent" }}><Text style={{ color: locationId === shop.id ? "#fff" : theme.color.onSurface, fontSize: 11, fontWeight: "800" }}>{shop.name}</Text></Pressable>)}</ScrollView> : null}
            {/* Period Filter Bar */}
            <View style={{ marginBottom: theme.spacing.md }}>
              <View style={styles.periodRow}>
                {[
                  { id: "all", label: "All Time" },
                  { id: "today", label: "Today" },
                  { id: "this_month", label: "This Month" },
                  { id: "custom", label: "Custom Period" },
                ].map((p) => {
                  const active = periodPreset === p.id;
                  return (
                    <GlowPressable
                      key={p.id}
                      topHighlight={false}
                      haptic
                      hoverLift={-2}
                      hoverScale={1.03}
                      pressScale={0.972}
                      restingBorderColor={active ? theme.color.brandPrimary : theme.color.glassBorder}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => applyPeriod(p.id as any)}
                      style={[styles.periodPill, active && styles.periodPillActive]}
                    >
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.78}
                        style={[styles.periodPillText, active && styles.periodPillTextActive]}
                      >
                        {p.label}
                      </Text>
                    </GlowPressable>
                  );
                })}
              </View>

              {periodPreset === "custom" && (
                <View style={styles.customPeriodRow}>
                  <TextInput
                    value={fromDate}
                    onChangeText={setFromDate}
                    onBlur={() => { if (fromDate.trim()) setFromDate(normalizeDateInput(fromDate)); }}
                    autoCapitalize="none"
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={theme.color.muted}
                    style={styles.customDateInput}
                  />
                  <Text style={{ color: theme.color.muted, fontSize: 12 }}>to</Text>
                  <TextInput
                    value={toDate}
                    onChangeText={setToDate}
                    onBlur={() => { if (toDate.trim()) setToDate(normalizeDateInput(toDate)); }}
                    autoCapitalize="none"
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={theme.color.muted}
                    style={styles.customDateInput}
                  />
                  <GlowPressable onPress={() => applyPeriod("custom", fromDate, toDate)} haptic topHighlight={false} animateBorder={false} pressScale={0.972} restingBorderColor="transparent" style={styles.customFilterButton}>
                    <Text style={{ color: theme.color.onBrandPrimary, fontWeight: "700", fontSize: 12 }}>Filter</Text>
                  </GlowPressable>
                </View>
              )}
            </View>

            {/* Net worth hero */}
            <AnimatedHeroCard theme={theme}>
              <LinearGradient
                colors={[theme.color.brandPrimary, theme.color.brandSecondary]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.hero}
              >
                <Text style={styles.heroLabel}>Net Profit {rangeData ? `(${fromDate} to ${toDate})` : ((dash?.periodStart && dash.periodStart !== "1970-01-01") ? `since ${dash.periodStart}` : "")}</Text>
                <Text style={styles.heroValue} testID="dashboard-net-profit">{fmt(displayNetProfit)}</Text>
                <View style={styles.heroRow}>
                  <View style={styles.heroMetric}>
                    <Text style={styles.heroSub}>Opening</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={styles.heroSubVal}>{fmt(dash?.openingBalance)}</Text>
                  </View>
                  <View style={styles.heroDivider} />
                  <View style={[styles.heroMetric, styles.heroMetricInset]}>
                    <Text style={styles.heroSub}>Closing</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={styles.heroSubVal}>{fmt(dash?.closingBalance)}</Text>
                  </View>
                  <View style={styles.heroDivider} />
                  <View style={[styles.heroMetric, styles.heroMetricInset]}>
                    <Text style={styles.heroSub}>Net Worth</Text>
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={styles.heroSubVal}>{fmt(dash?.netWorth)}</Text>
                  </View>
                </View>
              </LinearGradient>
            </AnimatedHeroCard>

            {/* Profit Flow breakdown */}
            {(displaySales || displayPurchases) ? (
              <Card style={styles.homeSummaryCard} testID="profit-flow" surfaceColor={theme.color.surfaceSecondary} hoverSurfaceColor={theme.color.surfaceSecondary} restingBorderColor={theme.color.border}>
                <Text style={styles.sectionTitleInline}>Profit Flow</Text>
                <View style={styles.pfRow}>
                  <Text style={styles.pfLabel}>Sales</Text>
                  <Text numberOfLines={1} style={[styles.pfVal, { color: theme.color.success }]}>+ {fmt(displaySales)}</Text>
                </View>
                <View style={styles.pfRow}>
                  <Text style={styles.pfLabel}>Purchases (COGS)</Text>
                  <Text numberOfLines={1} style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayPurchases)}</Text>
                </View>
                <View style={[styles.pfRow, styles.pfStrong]}>
                  <Text style={[styles.pfLabel, { fontWeight: "700" }]}>Gross Profit</Text>
                  <Text numberOfLines={1} style={[styles.pfVal, { fontWeight: "700" }]}>{fmt(displayGross)}</Text>
                </View>
                {displayCommission > 0 ? (
                  <View style={styles.pfRow}>
                    <Text style={styles.pfLabel}>Manager Commission</Text>
                    <Text numberOfLines={1} style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayCommission)}</Text>
                  </View>
                ) : null}
                {displayDrawings > 0 ? (
                  <View style={styles.pfRow}>
                    <Text style={styles.pfLabel}>Capital Withdrawals</Text>
                    <Text numberOfLines={1} style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayDrawings)}</Text>
                  </View>
                ) : null}
                <View style={[styles.pfRow, styles.pfStrong, { borderTopWidth: 2, borderTopColor: theme.color.brandPrimary, paddingTop: 8, marginTop: 4 }]}>
                  <Text style={[styles.pfLabel, { fontWeight: "700", color: theme.color.brandPrimary }]}>Net Profit</Text>
                  <Text numberOfLines={1} style={[styles.pfVal, { fontWeight: "700", color: theme.color.brandPrimary, fontSize: 16 }]}>{fmt(displayNetProfit)}</Text>
                </View>
              </Card>
            ) : null}

            {/* Daily quick summary — WhatsApp shareable. Same press treatment as
                the hero card (GlowPressable, pressScale 0.972, no haptic, clipSafe,
                animationsEnabled bypass handled inside GlowPressable). Nested
                controls (day-nav arrows, Today, WhatsApp share) are Pressables of
                their own, so they claim their touches first — the card press only
                fires on the body and opens the Day Book. */}
            <GlowPressable
              testID="daily-card-press"
              accessibilityRole="button"
              topHighlight={false}
              haptic={false}
              clipSafe
              pressScale={0.972}
              restingBorderColor="transparent"
              hoverBorderColor={theme.color.brandPrimary}
              onPress={() => router.push("/daybook")}
              style={{ borderRadius: theme.radius.lg, marginTop: theme.spacing.xs, marginBottom: theme.spacing.lg }}
            >
            <Card style={[styles.homeSummaryCard, styles.dailyCard, { marginTop: 0, marginBottom: 0, marginVertical: 0 }]} testID="daily-card" surfaceColor={theme.color.surfaceSecondary} hoverSurfaceColor={theme.color.surfaceSecondary} restingBorderColor={theme.color.border}>
              <View style={styles.dailyHead}>
                <View>
                  <Text numberOfLines={1} style={styles.dailyLabel}>{isToday ? "Today" : "Daily"} — {dailyLabel}</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={styles.dailyValue}>{fmt(daily?.netCash ?? 0)}</Text>
                  <Text style={styles.dailySub}>
                    {[salesEnabled ? `${daily?.salesCount ?? 0} sales` : null, purchasesEnabled ? `${daily?.billsCount ?? 0} bills` : null, isCapabilityEnabled(settings, "cashbook") ? `${daily?.paymentsCount ?? 0} payments` : null].filter(Boolean).join(" • ")}
                  </Text>
                </View>
                <View style={styles.dailyNav}>
                  <GlowPressable testID="btn-day-prev" accessibilityRole="button" accessibilityLabel="Previous day" onPress={() => shiftDay(-1)} haptic topHighlight={false} animateBorder={false} pressScale={0.972} restingBorderColor="transparent" style={styles.dailyNavBtn}>
                    <Ionicons name="chevron-back" size={18} color={theme.color.onSurface} />
                  </GlowPressable>
                  {!isToday ? (
                    <GlowPressable testID="btn-day-today" accessibilityRole="button" accessibilityLabel="Return to today" onPress={jumpToToday} haptic topHighlight={false} animateBorder={false} pressScale={0.972} restingBorderColor="transparent" style={[styles.dailyNavBtn, { paddingHorizontal: 10, width: undefined }]}>
                      <Text style={{ color: theme.color.brandPrimary, fontWeight: "700", fontSize: 12 }}>Today</Text>
                    </GlowPressable>
                  ) : null}
                  <GlowPressable testID="btn-day-next" accessibilityRole="button" accessibilityLabel="Next day" onPress={() => shiftDay(1)} haptic topHighlight={false} animateBorder={false} pressScale={0.972} restingBorderColor="transparent" style={styles.dailyNavBtn}>
                    <Ionicons name="chevron-forward" size={18} color={theme.color.onSurface} />
                  </GlowPressable>
                </View>
              </View>
              <View style={styles.dailyStats}>
                {salesEnabled ? <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Sales</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={[styles.dailyStatValue, { color: theme.color.success }]}>{fmt(daily?.revenue ?? 0)}</Text>
                </View> : null}
                {purchasesEnabled ? <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Purchases</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={[styles.dailyStatValue, { color: theme.color.warning }]}>{fmt(daily?.purchases ?? 0)}</Text>
                </View> : null}
                <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Profit</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72} style={styles.dailyStatValue}>{fmt(daily?.grossProfit ?? 0)}</Text>
                </View>
              </View>
              <GlowPressable testID="btn-share-daily" onPress={shareDaily} haptic prominent topHighlight={false} animateBorder={false} pressScale={0.972} restingBorderColor="transparent" style={styles.shareBtn}>
                <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                <Text style={styles.shareBtnText}>Share to WhatsApp</Text>
              </GlowPressable>
            </Card>
            </GlowPressable>

            {/* KPI cards reflect only the selected persona capabilities. */}
            {salesEnabled || purchasesEnabled ? <View style={styles.kpiRow}>
              {salesEnabled ? <KpiTile label="Sales" value={fmt(dash?.totalSales)} valueColor={theme.color.success} icon={<TrendingUp width={14} height={14} color={theme.color.success} />} testID="kpi-sales" onPress={() => router.push(salesRoute as any)} /> : null}
              {purchasesEnabled ? <KpiTile label="Purchases" value={fmt(dash?.totalPurchases)} valueColor={theme.color.warning} icon={<Receipt width={14} height={14} color={theme.color.warning} />} testID="kpi-purchases" onPress={() => router.push("/bills")} /> : null}
            </View> : null}
            <View style={styles.kpiRow}>
              <KpiTile label="Cash" value={fmt(dash?.cash)} icon={<ArrowLeftRight width={14} height={14} color="#60A5FA" />} testID="kpi-cash" onPress={() => router.push("/cashbook")} />
              {stockEnabled ? <KpiTile label="Stock" value={fmt(dash?.inventoryValue)} icon={<Package width={14} height={14} color="#34D399" />} testID="kpi-inventory" onPress={() => router.push("/inventory-form")} /> : null}
            </View>

            {workflowTiles.length > 0 ? <View testID="home-workflow-shortcuts">
              <Text style={styles.quickWorkspaceTitle}>Quick Workspaces</Text>
              <Text style={styles.quickWorkspaceHint}>Hold any tile to organize &amp; sort</Text>
              <View style={styles.quickWorkspaceGrid}>
                {workflowTiles.map((tile) => <Pressable key={tile.key} testID={`home-workflow-${tile.key}`} accessibilityRole="button" accessibilityLabel={tile.label} onPress={() => router.push(tile.route as any)} style={({ pressed }) => [styles.quickWorkspaceTile, tile.key === "ai-assistant" && styles.quickWorkspaceTileFeatured, pressed && styles.quickWorkspaceTilePressed]}>
                  <View style={[styles.quickWorkspaceIcon, { backgroundColor: tile.key === "ai-assistant" ? "rgba(255,255,255,0.24)" : "rgba(96, 96, 91, 0.52)" }]}><Ionicons name={tile.icon as any} size={22} color={tile.key === "ai-assistant" ? "#0b1110" : tile.color} /></View>
                  <Text numberOfLines={2} style={[styles.quickWorkspaceLabel, tile.key === "ai-assistant" && styles.quickWorkspaceLabelFeatured]}>{tile.label}</Text>
                </Pressable>)}
              </View>
            </View> : null}

            {salesEnabled ? <Card style={{ marginTop: theme.spacing.lg }}>
              <Text style={styles.sectionTitleInline}>Sales Trend</Text>
              {barData.length > 0 ? (
                <BarChart
                  data={barData}
                  barWidth={22}
                  spacing={18}
                  frontColor={theme.color.brandSecondary}
                  yAxisThickness={0}
                  xAxisThickness={0}
                  hideRules
                  noOfSections={4}
                  yAxisTextStyle={{ color: theme.color.muted, fontSize: 10 }}
                  xAxisLabelTextStyle={{ color: theme.color.muted, fontSize: 10 }}
                />
              ) : (
                <Text style={styles.emptyText}>No sales recorded yet. Add your first sale to see trends.</Text>
              )}
            </Card> : null}

            <View style={{ height: 120 }} />
          </>
        )}
      </Animated.ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  homeHeader: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.md },
  homeHeaderTitle: { fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  homeHeaderSubtitle: { fontSize: 14, marginTop: 4 },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, width: "100%", maxWidth: 1160, alignSelf: "center" },
  periodRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" },
  periodPill: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceSecondary,
  },
  periodPillActive: {
    borderColor: theme.color.brandPrimary,
    backgroundColor: theme.color.brandPrimary + "25",
  },
  periodPillText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface },
  periodPillTextActive: { color: theme.color.brandPrimary },
  customPeriodRow: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center" },
  customDateInput: { flex: 1, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, color: theme.color.onSurface, fontSize: 13 },
  customFilterButton: { backgroundColor: theme.color.brandPrimary, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  hero: {
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
  },
  heroLabel: { color: "rgba(255,255,255,0.75)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: "500" },
  heroValue: { color: "#fff", fontSize: 36, fontWeight: "700", marginTop: 6, letterSpacing: -1 },
  heroRow: { flexDirection: "row", marginTop: theme.spacing.lg, alignItems: "center" },
  heroMetric: { flex: 1 },
  heroMetricInset: { paddingLeft: theme.spacing.md },
  heroDivider: { width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.2)" },
  heroSub: { color: "rgba(255,255,255,0.7)", fontSize: 11, fontWeight: "500" },
  heroSubVal: { color: "#fff", fontSize: 16, fontWeight: "600", marginTop: 2 },
  kpiRow: { flexDirection: "row", gap: theme.spacing.md, marginBottom: theme.spacing.md },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
  sectionTitleInline: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.md },
  tile: {
    width: "48%",
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    minHeight: 108,
    justifyContent: "space-between",
    backgroundColor: theme.color.surfaceSecondary,
    marginVertical: theme.spacing.xs,
    elevation: Platform.OS === "web" ? 1 : 0,
    shadowColor: theme.color.muted,
    shadowOpacity: Platform.OS === "web" ? 0.06 : 0,
    shadowRadius: Platform.OS === "web" ? 3 : 0,
    shadowOffset: { width: 0, height: 1 },
  },
  tileIcon: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: "center", alignItems: "center",
  },
  tileLabel: { fontSize: 14, fontWeight: "600", marginTop: 12 },
  emptyText: { color: theme.color.muted, fontSize: 13, textAlign: "center", paddingVertical: theme.spacing.lg },
  dailyCard: { marginBottom: theme.spacing.lg, padding: theme.spacing.lg },
  dailyHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  dailyLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  homeSummaryCard: { marginBottom: theme.spacing.lg, marginVertical: theme.spacing.xs, padding: theme.spacing.lg, borderRadius: theme.radius.lg, backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border },
  dailyValue: { fontSize: 28, fontWeight: "700", color: theme.color.onSurface, marginTop: 4, letterSpacing: -0.5 },
  dailySub: { fontSize: 11, color: theme.color.muted, marginTop: 4 },
  dailyNav: { flexDirection: "row", gap: 6 },
  dailyNavBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.color.surfaceTertiary, justifyContent: "center", alignItems: "center" },
  dailyStats: { flexDirection: "row", marginTop: theme.spacing.md, paddingTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.color.divider, gap: theme.spacing.md },
  dailyStat: { flex: 1 },
  dailyStatLabel: { fontSize: 10, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "500" },
  dailyStatValue: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface, marginTop: 2 },
  shareBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#25D366", padding: 10, borderRadius: theme.radius.md, marginTop: theme.spacing.md },
  shareBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  pfRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  pfStrong: { borderTopWidth: 1, borderTopColor: theme.color.divider, marginTop: 4, paddingTop: 8 },
  pfLabel: { color: theme.color.onSurfaceTertiary, fontSize: 14 },
  pfVal: { color: theme.color.onSurface, fontSize: 14, fontWeight: "500" },
  quickWorkspaceTitle: { color: theme.color.onSurface, fontSize: 20, fontWeight: "800", marginTop: theme.spacing.lg, marginBottom: 4 },
  quickWorkspaceHint: { color: theme.color.muted, fontSize: 13, marginBottom: theme.spacing.md },
  quickWorkspaceGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 12 },
  quickWorkspaceTile: { width: "48.5%", height: 115, borderRadius: 22, padding: 16, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, justifyContent: "space-between" },
  quickWorkspaceTileFeatured: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  quickWorkspaceTilePressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  quickWorkspaceIcon: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  quickWorkspaceLabel: { color: theme.color.onSurface, fontSize: 14, fontWeight: "700", marginTop: 12 },
  quickWorkspaceLabelFeatured: { color: theme.color.onBrandPrimary },
  organizePanel: { marginBottom: 8, padding: 10, backgroundColor: theme.color.glassSurface, borderWidth: 1, borderColor: theme.color.brandPrimary },
}); }
