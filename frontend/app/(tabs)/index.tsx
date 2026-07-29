import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl, ActivityIndicator, TextInput } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BarChart } from "react-native-gifted-charts";

import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, KpiTile, Card } from "@/src/components/UI";
import { sharePlainText } from "@/src/utils/share";

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

const TILES = [
  { key: "bills", label: "Purchases", icon: "receipt-outline", route: "/bills", color: "#D6E5DB" },
  { key: "sales", label: "Sales", icon: "trending-up-outline", route: "/sales", color: "#F3E4C8" },
  { key: "receipts", label: "Receipts", icon: "receipt-outline", route: "/receipts", color: "#F0E4D0" },
  { key: "payments", label: "Payments", icon: "cash-outline", route: "/payments", color: "#E8DAD0" },
  { key: "cashbook", label: "Cash Book", icon: "swap-vertical-outline", route: "/cashbook", color: "#DCE8DC" },
  { key: "invoices", label: "Invoices", icon: "document-text-outline", route: "/invoices", color: "#D8E4F0" },
  { key: "quotes", label: "Quotes", icon: "pricetags-outline", route: "/quotes", color: "#E0E8F0" },
  { key: "delivery", label: "Delivery Notes", icon: "cube-outline", route: "/delivery-notes", color: "#DCE4DC" },
  { key: "expenses", label: "Expenses", icon: "wallet-outline", route: "/expenses", color: "#E4D8D8" },
  { key: "inventory", label: "Inventory", icon: "cube-outline", route: "/inventory-form", color: "#E3E9DA" },
  { key: "assets", label: "Assets & Liabilities", icon: "pie-chart-outline", route: "/assets", color: "#D0D8E0" },
  { key: "daybook", label: "Day Book", icon: "book-outline", route: "/daybook", color: "#DDE3EC" },
  { key: "reports", label: "Reports", icon: "bar-chart-outline", route: "/reports", color: "#E0E0DA" },
  { key: "monthly", label: "Monthly Report", icon: "calendar-outline", route: "/monthly-summary", color: "#EFDCC8" },
  { key: "ask", label: "Ask AI", icon: "sparkles-outline", route: "/ask", color: "#D0E0D8" },
  { key: "voice", label: "AI Assistant", icon: "mic-outline", route: "/voice", color: "#1C4030" },
] as const;

// Persona-based customization: hide tiles that don't apply to a business type.
// Service businesses (consultant/freelancer/salon/handyman/service) don't hold stock,
// so Inventory is irrelevant. Pure service personas also lean on Invoices+Debtors over
// supplier Purchases/Creditors, so those are de-emphasised for the lightest personas.
const HIDDEN_TILES: Record<string, string[]> = {
  service: ["inventory", "delivery"],
  salon: ["inventory", "delivery"],
  handyman: ["inventory"],
  it_consultant: ["inventory", "bills", "delivery"],
  freelancer: ["inventory", "bills", "delivery"],
  // shop / vendor: show everything (default)
};

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
  const [businessType, setBusinessType] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const [d, day, settings] = await Promise.all([
        api.dashboard(),
        api.dailySummary(dailyDate),
        api.getSettings(),
      ]);
      setDash(d);
      setDaily(day);
      setBusinessType(settings.businessType || "");
    } catch (e) {
      console.warn("dash", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dailyDate]);

  const visibleTiles = useMemo(() => {
    const hidden = HIDDEN_TILES[businessType] || [];
    return TILES.filter((t) => !hidden.includes(t.key));
  }, [businessType]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Reload whenever the day changes (even without refocusing)
  useEffect(() => { load(); }, [dailyDate, load]);

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
    if (daily.drawings > 0) lines.push(`Drawings: ${fmt(daily.drawings)}`);
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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Ledgr" subtitle="Your business finances, simplified" testID="dashboard-header" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandPrimary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && !dash ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
        ) : (
          <>
            {/* Period Filter Bar */}
            <View style={{ marginBottom: theme.spacing.md }}>
              <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {[
                  { id: "all", label: "All Time" },
                  { id: "today", label: "Today" },
                  { id: "this_month", label: "This Month" },
                  { id: "custom", label: "Custom Period" },
                ].map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => applyPeriod(p.id as any)}
                    style={[{
                      paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20,
                      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                    }, periodPreset === p.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "25" }]}
                  >
                    <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, periodPreset === p.id && { color: theme.color.brandPrimary }]}>
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {periodPreset === "custom" && (
                <View style={{ flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center" }}>
                  <TextInput
                    value={fromDate}
                    onChangeText={setFromDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={theme.color.muted}
                    style={{ flex: 1, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, color: theme.color.onSurface, fontSize: 13 }}
                  />
                  <Text style={{ color: theme.color.muted, fontSize: 12 }}>to</Text>
                  <TextInput
                    value={toDate}
                    onChangeText={setToDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={theme.color.muted}
                    style={{ flex: 1, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, color: theme.color.onSurface, fontSize: 13 }}
                  />
                  <Pressable
                    onPress={() => applyPeriod("custom", fromDate, toDate)}
                    style={{ backgroundColor: theme.color.brandPrimary, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 }}
                  >
                    <Text style={{ color: theme.color.onBrandPrimary, fontWeight: "700", fontSize: 12 }}>Filter</Text>
                  </Pressable>
                </View>
              )}
            </View>

            {/* Net worth hero */}
            <LinearGradient
              colors={[theme.color.brandPrimary, theme.color.brandSecondary]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.hero}
            >
              <Text style={styles.heroLabel}>Net Profit {rangeData ? `(${fromDate} to ${toDate})` : ((dash?.periodStart && dash.periodStart !== "1970-01-01") ? `since ${dash.periodStart}` : "")}</Text>
              <Text style={styles.heroValue} testID="dashboard-net-profit">{fmt(displayNetProfit)}</Text>
              <View style={styles.heroRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroSub}>Opening</Text>
                  <Text style={styles.heroSubVal}>{fmt(dash?.openingBalance)}</Text>
                </View>
                <View style={{ width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.2)" }} />
                <View style={{ flex: 1, paddingLeft: theme.spacing.md }}>
                  <Text style={styles.heroSub}>Closing</Text>
                  <Text style={styles.heroSubVal}>{fmt(dash?.closingBalance)}</Text>
                </View>
                <View style={{ width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.2)" }} />
                <View style={{ flex: 1, paddingLeft: theme.spacing.md }}>
                  <Text style={styles.heroSub}>Net Worth</Text>
                  <Text style={styles.heroSubVal}>{fmt(dash?.netWorth)}</Text>
                </View>
              </View>
            </LinearGradient>

            {/* Profit Flow breakdown */}
            {(displaySales || displayPurchases) ? (
              <Card style={{ marginBottom: theme.spacing.lg }} testID="profit-flow">
                <Text style={styles.sectionTitleInline}>Profit Flow</Text>
                <View style={styles.pfRow}>
                  <Text style={styles.pfLabel}>Sales</Text>
                  <Text style={[styles.pfVal, { color: theme.color.success }]}>+ {fmt(displaySales)}</Text>
                </View>
                <View style={styles.pfRow}>
                  <Text style={styles.pfLabel}>Purchases (COGS)</Text>
                  <Text style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayPurchases)}</Text>
                </View>
                <View style={[styles.pfRow, styles.pfStrong]}>
                  <Text style={[styles.pfLabel, { fontWeight: "700" }]}>Gross Profit</Text>
                  <Text style={[styles.pfVal, { fontWeight: "700" }]}>{fmt(displayGross)}</Text>
                </View>
                {displayCommission > 0 ? (
                  <View style={styles.pfRow}>
                    <Text style={styles.pfLabel}>Manager Commission</Text>
                    <Text style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayCommission)}</Text>
                  </View>
                ) : null}
                {displayDrawings > 0 ? (
                  <View style={styles.pfRow}>
                    <Text style={styles.pfLabel}>Drawings</Text>
                    <Text style={[styles.pfVal, { color: theme.color.warning }]}>− {fmt(displayDrawings)}</Text>
                  </View>
                ) : null}
                <View style={[styles.pfRow, styles.pfStrong, { borderTopWidth: 2, borderTopColor: theme.color.brandPrimary, paddingTop: 8, marginTop: 4 }]}>
                  <Text style={[styles.pfLabel, { fontWeight: "700", color: theme.color.brandPrimary }]}>Net Profit</Text>
                  <Text style={[styles.pfVal, { fontWeight: "700", color: theme.color.brandPrimary, fontSize: 16 }]}>{fmt(displayNetProfit)}</Text>
                </View>
              </Card>
            ) : null}

            {/* Daily quick summary — WhatsApp shareable */}
            <Card style={styles.dailyCard} testID="daily-card">
              <View style={styles.dailyHead}>
                <View>
                  <Text style={styles.dailyLabel}>{isToday ? "Today" : "Daily"} — {dailyLabel}</Text>
                  <Text style={styles.dailyValue}>{fmt(daily?.netCash ?? 0)}</Text>
                  <Text style={styles.dailySub}>
                    {daily?.salesCount ?? 0} sales • {daily?.billsCount ?? 0} bills • {daily?.paymentsCount ?? 0} payments
                  </Text>
                </View>
                <View style={styles.dailyNav}>
                  <Pressable testID="btn-day-prev" onPress={() => shiftDay(-1)} style={styles.dailyNavBtn}>
                    <Ionicons name="chevron-back" size={18} color={theme.color.onSurface} />
                  </Pressable>
                  {!isToday ? (
                    <Pressable testID="btn-day-today" onPress={jumpToToday} style={[styles.dailyNavBtn, { paddingHorizontal: 10, width: undefined }]}>
                      <Text style={{ color: theme.color.brandPrimary, fontWeight: "700", fontSize: 12 }}>Today</Text>
                    </Pressable>
                  ) : null}
                  <Pressable testID="btn-day-next" onPress={() => shiftDay(1)} style={styles.dailyNavBtn}>
                    <Ionicons name="chevron-forward" size={18} color={theme.color.onSurface} />
                  </Pressable>
                </View>
              </View>
              <View style={styles.dailyStats}>
                <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Sales</Text>
                  <Text style={[styles.dailyStatValue, { color: theme.color.success }]}>{fmt(daily?.revenue ?? 0)}</Text>
                </View>
                <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Purchases</Text>
                  <Text style={[styles.dailyStatValue, { color: theme.color.warning }]}>{fmt(daily?.purchases ?? 0)}</Text>
                </View>
                <View style={styles.dailyStat}>
                  <Text style={styles.dailyStatLabel}>Profit</Text>
                  <Text style={styles.dailyStatValue}>{fmt(daily?.grossProfit ?? 0)}</Text>
                </View>
              </View>
              <Pressable testID="btn-share-daily" onPress={shareDaily} style={styles.shareBtn}>
                <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                <Text style={styles.shareBtnText}>Share to WhatsApp</Text>
              </Pressable>
            </Card>

            {/* KPI row — tap to open the underlying entries */}
            <View style={styles.kpiRow}>
              <KpiTile label="Sales" value={fmt(dash?.totalSales)} testID="kpi-sales" onPress={() => router.push("/sales")} />
              <KpiTile label="Purchases" value={fmt(dash?.totalPurchases)} testID="kpi-purchases" onPress={() => router.push("/bills")} />
            </View>
            <View style={styles.kpiRow}>
              <KpiTile label="Cash" value={fmt(dash?.cash)} testID="kpi-cash" onPress={() => router.push("/cashbook")} />
              <KpiTile label="Inventory" value={fmt(dash?.inventoryValue)} testID="kpi-inventory" onPress={() => router.push("/inventory-form")} />
            </View>

            {/* Apps grid */}
            <Text style={styles.sectionTitle}>Apps</Text>
            <View style={styles.grid}>
              {visibleTiles.map((t) => {
                const isBrand = t.key === "voice";
                return (
                  <Pressable
                    key={t.key}
                    testID={`tile-${t.key}`}
                    onPress={() => router.push(t.route as any)}
                    style={({ pressed }) => [
                      styles.tile,
                      { backgroundColor: isBrand ? theme.color.brandPrimary : theme.color.surfaceSecondary },
                      pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                    ]}
                  >
                    <View style={[styles.tileIcon, { backgroundColor: isBrand ? "rgba(255,255,255,0.15)" : t.color }]}>
                      <Ionicons name={t.icon as any} size={22} color={isBrand ? "#fff" : theme.color.brandPrimary} />
                    </View>
                    <Text style={[styles.tileLabel, { color: isBrand ? "#fff" : theme.color.onSurface }]}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Sales trend chart */}
            <Card style={{ marginTop: theme.spacing.lg }}>
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
            </Card>

            <View style={{ height: 120 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl },
  hero: {
    padding: theme.spacing.xl,
    borderRadius: theme.radius.lg,
    marginBottom: theme.spacing.lg,
  },
  heroLabel: { color: "rgba(255,255,255,0.75)", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: "500" },
  heroValue: { color: "#fff", fontSize: 36, fontWeight: "700", marginTop: 6, letterSpacing: -1 },
  heroRow: { flexDirection: "row", marginTop: theme.spacing.lg, alignItems: "center" },
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
    elevation: 1,
    shadowColor: theme.color.muted,
    shadowOpacity: 0.06,
    shadowRadius: 3,
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
}); }
