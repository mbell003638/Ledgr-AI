import React, { useCallback, useEffect, useMemo, useState } from "react";
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
import { requestVoiceAssistant } from "@/src/utils/voiceAssistantRequest";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Animated, { useAnimatedRef, useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { ReorderableWorkspaceGrid, type WorkspaceTileItem } from "@/src/components/ReorderableWorkspaceGrid";
import { GlowPressable } from "@/src/components/GlowPressable";
import ArrowDownLeft from "lucide-react-native/icons/arrow-down-left";
import ArrowLeftRight from "lucide-react-native/icons/arrow-left-right";
import Banknote from "lucide-react-native/icons/banknote";
import BarChart2 from "lucide-react-native/icons/chart-no-axes-column";
import BookOpen from "lucide-react-native/icons/book-open";
import Calendar from "lucide-react-native/icons/calendar";
import Cube from "lucide-react-native/icons/box";
import FileText from "lucide-react-native/icons/file-text";
import Mic from "lucide-react-native/icons/mic";
import Package from "lucide-react-native/icons/package";
import PieChart from "lucide-react-native/icons/chart-pie";
import Receipt from "lucide-react-native/icons/receipt";
import Sparkles from "lucide-react-native/icons/sparkles";
import Tag from "lucide-react-native/icons/tag";
import TrendingUp from "lucide-react-native/icons/trending-up";
import Wallet from "lucide-react-native/icons/wallet";

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
  icon: WorkspaceTileItem["icon"];
  color: string;
  capability: string;
  route: string;
  usesBrandIcon?: boolean;
  solidBrand?: boolean;
};

const WORKFLOW_TILES: WorkflowTile[] = [
  { key: "purchases", label: "Purchases", subtitle: "", icon: Receipt, color: "#34D399", capability: "procurement", route: "/bills" },
  { key: "sales", label: "Sales", subtitle: "", icon: TrendingUp, color: "#FBBF24", capability: "commerce", route: "/sales" },
  { key: "receipts", label: "Receipts", subtitle: "", icon: ArrowDownLeft, color: "#60A5FA", capability: "customers", route: "/receipts" },
  { key: "payments", label: "Payments", subtitle: "", icon: Banknote, color: "#F87171", capability: "procurement", route: "/payments" },
  { key: "cashbook", label: "Cash Book", subtitle: "", icon: ArrowLeftRight, color: "#C084FC", capability: "cashbook", route: "/cashbook" },
  { key: "invoices", label: "Invoices", subtitle: "", icon: FileText, color: "#38BDF8", capability: "invoicing", route: "/invoices" },
  { key: "quotes", label: "Quotes", subtitle: "", icon: Tag, color: "#FBBF24", capability: "invoicing", route: "/quotes" },
  { key: "delivery", label: "Delivery Notes", subtitle: "", icon: Cube, color: "#A7F3D0", capability: "shipping_returns", route: "/delivery-notes" },
  { key: "expenses", label: "Expenses", subtitle: "", icon: Wallet, color: "#F87171", capability: "core_ledger", route: "/expenses" },
  { key: "stock", label: "Stock", subtitle: "", icon: Package, color: "#34D399", capability: "inventory", route: "/products" },
  { key: "locations", label: "Locations", subtitle: "", icon: Package, color: "#2DD4BF", capability: "multi_location", route: "/locations" },
  { key: "assets", label: "Assets & Liabilities", subtitle: "", icon: PieChart, color: "#818CF8", capability: "core_ledger", route: "/assets" },
  { key: "daybook", label: "Day Book", subtitle: "", icon: BookOpen, color: "#EC4899", capability: "core_ledger", route: "/daybook" },
  { key: "reports", label: "Reports", subtitle: "", icon: BarChart2, color: "#FBBF24", capability: "reporting", route: "/reports" },
  { key: "monthly-report", label: "Monthly Report", subtitle: "", icon: Calendar, color: "#F97316", capability: "reporting", route: "/monthly-summary" },
  { key: "ask-ai", label: "Ask AI", subtitle: "", icon: Sparkles, color: "#A7F3D0", capability: "ai_assistant", route: "/ask", usesBrandIcon: true },
  { key: "ai-assistant", label: "AI Assistant", subtitle: "", icon: Mic, color: "#A7F3D0", capability: "voice_assistant", route: "/voice", usesBrandIcon: true, solidBrand: true },
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
      style={{ borderRadius: theme.radius.lg, marginBottom: 16 }}
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
  const [customTileOrder, setCustomTileOrder] = useState<string[]>([]);
  const [isEditingGrid, setIsEditingGrid] = useState(false);
  const scrollRef = useAnimatedRef<any>();
  const scrollY = useSharedValue(0);
  const scrollHandler = useAnimatedScrollHandler({ onScroll: (event) => { scrollY.value = event.contentOffset.y; } });
  const [quickStartDismissed, setQuickStartDismissed] = useState(false);
  const [locationId, setLocationId] = useState("");

  useEffect(() => {
    AsyncStorage.getItem("ledgr_tile_order").then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setCustomTileOrder(parsed.map(String));
      } catch { /* ignore malformed local layout state */ }
    }).catch(() => {});
  }, []);

  // Remember the (data version, dailyDate) at which the dashboard last loaded,
  // so a plain focus-return with nothing changed can skip the full re-read.
  const loadedRef = React.useRef<{ version: number; date: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setQuickStartDismissed(Boolean(s.quickStartDismissed));
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

  const dismissQuickStart = async () => {
    setQuickStartDismissed(true);
    try {
      await api.updateSettings({ quickStartDismissed: true });
    } catch {
      setQuickStartDismissed(false);
    }
  };

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
  const visibleTiles = useMemo<WorkspaceTileItem[]>(() => {
    const filtered = workflowTiles.map((tile) => ({
      key: tile.key,
      label: tile.label,
      icon: tile.icon,
      route: tile.route,
      iconColor: tile.color,
      iconBackground: tile.key === "ai-assistant" ? `${theme.color.onBrandPrimary}24` : `${tile.color}24`,
      usesBrandIcon: tile.usesBrandIcon,
      solidBrand: tile.solidBrand,
    }));
    if (!customTileOrder.length) return filtered;
    const map = new Map(filtered.map((tile) => [tile.key, tile]));
    const ordered: WorkspaceTileItem[] = [];
    for (const key of customTileOrder) {
      const tile = map.get(key);
      if (tile) { ordered.push(tile); map.delete(key); }
    }
    return [...ordered, ...Array.from(map.values())];
  }, [customTileOrder, theme.color.onBrandPrimary, workflowTiles]);
  const recordTileUsage = useCallback(async (key: string) => {
    try {
      const raw = (await AsyncStorage.getItem("ledgr_tile_usage")) || "{}";
      const usage = JSON.parse(raw);
      usage[key] = (usage[key] || 0) + 1;
      usage[`${key}_last_used`] = Date.now();
      await AsyncStorage.setItem("ledgr_tile_usage", JSON.stringify(usage));
    } catch { /* local usage is optional */ }
  }, []);
  const handleTilePress = useCallback((tile: WorkspaceTileItem) => {
    if (isEditingGrid) return;
    void recordTileUsage(tile.key);
    if (tile.key === "ai-assistant") requestVoiceAssistant();
    else router.push(tile.route as any);
  }, [isEditingGrid, recordTileUsage, router]);
  const moveTile = useCallback((fromIndex: number, toIndex: number) => {
    const currentKeys = visibleTiles.map((tile) => tile.key);
    if (fromIndex < 0 || fromIndex >= currentKeys.length || toIndex < 0 || toIndex >= currentKeys.length || fromIndex === toIndex) return;
    const [moved] = currentKeys.splice(fromIndex, 1);
    currentKeys.splice(toIndex, 0, moved);
    setCustomTileOrder(currentKeys);
    AsyncStorage.setItem("ledgr_tile_order", JSON.stringify(currentKeys)).catch(() => {});
  }, [visibleTiles]);
  const sortTilesByPreset = useCallback(async (preset: "alphabetical" | "frequent" | "recent" | "default") => {
    if (preset === "default") {
      setCustomTileOrder([]);
      await AsyncStorage.removeItem("ledgr_tile_order").catch(() => {});
      return;
    }
    let usage: Record<string, number> = {};
    try {
      const raw = await AsyncStorage.getItem("ledgr_tile_usage");
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object") usage = parsed;
    } catch { /* usage is optional */ }
    const sorted = [...workflowTiles];
    if (preset === "alphabetical") sorted.sort((a, b) => a.label.localeCompare(b.label));
    if (preset === "frequent") sorted.sort((a, b) => Number(usage[b.key] || 0) - Number(usage[a.key] || 0));
    if (preset === "recent") sorted.sort((a, b) => Number(usage[`${b.key}_last_used`] || 0) - Number(usage[`${a.key}_last_used`] || 0));
    const nextOrder = sorted.map((tile) => tile.key);
    setCustomTileOrder(nextOrder);
    await AsyncStorage.setItem("ledgr_tile_order", JSON.stringify(nextOrder)).catch(() => {});
  }, [workflowTiles]);
  const hasLedgerActivity = Boolean(dash && [dash.totalSales, dash.totalPurchases, dash.supplierPayments, dash.drawings, dash.grossProfit].some((value) => Math.abs(Number(value || 0)) > 0.005));
  const quickStartRoute = isCapabilityEnabled(settings, "commerce") ? "/sale-form" : isCapabilityEnabled(settings, "invoicing") ? "/invoices" : "/expenses";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Ledgr" subtitle="Your business finances, simplified" testID="dashboard-header" style={styles.homeHeader} titleStyle={styles.homeHeaderTitle} subtitleStyle={styles.homeHeaderSubtitle} />
      <Animated.ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandPrimary} />}
        showsVerticalScrollIndicator={false}
        ref={scrollRef}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
      >
        {loading && !dash ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
        ) : (
          <>
            {shops.length > 0 ? <View testID="dashboard-location-context" style={styles.locationContext}>
              <View style={styles.locationContextHeader}><Ionicons name="location-outline" size={15} color={theme.color.brandPrimary} /><Text style={styles.locationContextLabel}>Reporting location</Text><Text style={styles.locationContextValue}>{locationId ? shops.find((shop) => shop.id === locationId)?.name || "Selected shop" : "All locations"}</Text></View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                <Pressable accessibilityRole="radio" accessibilityLabel="All locations" accessibilityState={{ selected: !locationId }} onPress={() => { setLocationId(""); void api.updateSettings({ activeLocationId: "" }); }} style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 15, borderWidth: 1, borderColor: !locationId ? theme.color.brandPrimary : theme.color.border, backgroundColor: !locationId ? theme.color.brandPrimary : "transparent" }}><Text style={{ color: !locationId ? "#fff" : theme.color.onSurface, fontSize: 11, fontWeight: "800" }}>All locations</Text></Pressable>
                {shops.map((shop) => <Pressable key={shop.id} accessibilityRole="radio" accessibilityLabel={shop.name} accessibilityState={{ selected: locationId === shop.id }} onPress={() => { setLocationId(shop.id); void api.updateSettings({ activeLocationId: shop.id }); }} style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 15, borderWidth: 1, borderColor: locationId === shop.id ? theme.color.brandPrimary : theme.color.border, backgroundColor: locationId === shop.id ? theme.color.brandPrimary : "transparent" }}><Text style={{ color: locationId === shop.id ? "#fff" : theme.color.onSurface, fontSize: 11, fontWeight: "800" }}>{shop.name}</Text></Pressable>)}
              </ScrollView>
            </View> : null}
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
            <Card style={[styles.homeSummaryCard, styles.dailyCard, { marginTop: 0, marginBottom: theme.spacing.lg, marginVertical: 0 }]} testID="daily-card" surfaceColor={theme.color.surfaceSecondary} hoverSurfaceColor={theme.color.surfaceSecondary} restingBorderColor={theme.color.border}>
              <View style={styles.dailyHead}>
                <GlowPressable
                  testID="daily-card-press"
                  accessibilityRole="button"
                  accessibilityLabel="Open Day Book daily summary"
                  topHighlight={false}
                  haptic={false}
                  clipSafe
                  pressScale={0.972}
                  restingBorderColor="transparent"
                  hoverBorderColor={theme.color.brandPrimary}
                  onPress={() => router.push("/daybook")}
                  style={styles.dailyBodyPressable}
                >
                  <Text numberOfLines={1} style={styles.dailyLabel}>{isToday ? "Today" : "Daily"} — {dailyLabel}</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78} style={styles.dailyValue}>{fmt(daily?.netCash ?? 0)}</Text>
                  <Text style={styles.dailySub}>
                    {[salesEnabled ? `${daily?.salesCount ?? 0} sales` : null, purchasesEnabled ? `${daily?.billsCount ?? 0} bills` : null, isCapabilityEnabled(settings, "cashbook") ? `${daily?.paymentsCount ?? 0} payments` : null].filter(Boolean).join(" • ")}
                  </Text>
                </GlowPressable>
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

            {!hasLedgerActivity && !quickStartDismissed ? <Card testID="dashboard-quick-start" shadowEnabled={false} style={styles.quickStartCard}>
              <View style={styles.quickStartIcon}><Ionicons name="rocket-outline" size={20} color={theme.color.brandPrimary} /></View>
              <View style={styles.quickStartCopy}><Text style={styles.quickStartTitle}>Start with your first entry</Text><Text style={styles.quickStartText}>Your dashboard will fill in as you record a sale, invoice, purchase, or expense.</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Create your first entry" onPress={() => router.push(quickStartRoute as any)} style={styles.quickStartButton}><Text style={styles.quickStartButtonText}>Start</Text></Pressable>
              <Pressable testID="dismiss-dashboard-quick-start" accessibilityRole="button" accessibilityLabel="Dismiss first-entry reminder" hitSlop={8} onPress={dismissQuickStart} style={styles.quickStartDismiss}><Ionicons name="close" size={16} color={theme.color.muted} /></Pressable>
            </Card> : null}
            {/* KPI cards reflect only the selected persona capabilities. */}
            {salesEnabled || purchasesEnabled ? <View style={styles.kpiRow}>
              {salesEnabled ? <KpiTile label="Sales" value={fmt(dash?.totalSales)} valueColor={theme.color.success} icon={<TrendingUp width={14} height={14} color={theme.color.success} />} testID="kpi-sales" onPress={() => router.push(salesRoute as any)} /> : null}
              {purchasesEnabled ? <KpiTile label="Purchases" value={fmt(dash?.totalPurchases)} valueColor={theme.color.warning} icon={<Receipt width={14} height={14} color={theme.color.warning} />} testID="kpi-purchases" onPress={() => router.push("/bills")} /> : null}
            </View> : null}
            <View style={styles.kpiRow}>
              <KpiTile label="Cash" value={fmt(dash?.cash)} icon={<ArrowLeftRight width={14} height={14} color="#60A5FA" />} testID="kpi-cash" onPress={() => router.push("/cashbook")} />
              {stockEnabled ? <KpiTile label="Stock" value={fmt(dash?.inventoryValue)} icon={<Package width={14} height={14} color="#34D399" />} testID="kpi-inventory" onPress={() => router.push("/inventory-form")} /> : null}
            </View>

            {visibleTiles.length > 0 ? <View testID="home-workflow-shortcuts">
              <View style={styles.quickWorkspaceHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.quickWorkspaceTitle}>Quick Workspaces</Text>
                  <Text style={styles.quickWorkspaceHint}>Hold any tile to organize &amp; sort</Text>
                </View>
                {isEditingGrid ? <Pressable accessibilityRole="button" accessibilityLabel="Finish organizing workspaces" onPress={() => setIsEditingGrid(false)} style={styles.workspaceDone}><Text style={styles.workspaceDoneText}>Done</Text></Pressable> : null}
              </View>
              {isEditingGrid ? <Card style={styles.organizePanel} shadowEnabled={false}>
                <Text style={styles.organizeTitle}>Tile organization</Text>
                <Text style={styles.organizeHint}>Drag a tile to move it, or choose a sort preset. Tap Done when finished.</Text>
                <View style={styles.organizeActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Sort workspaces by recent use" onPress={() => { void sortTilesByPreset("recent"); }} style={styles.organizeAction}><Ionicons name="time-outline" size={14} color={theme.color.brandPrimary} /><Text style={styles.organizeActionText}>Recent</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Sort workspaces by frequent use" onPress={() => { void sortTilesByPreset("frequent"); }} style={styles.organizeAction}><Ionicons name="flame-outline" size={14} color={theme.color.brandPrimary} /><Text style={styles.organizeActionText}>Most used</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Sort workspaces alphabetically" onPress={() => { void sortTilesByPreset("alphabetical"); }} style={styles.organizeAction}><Ionicons name="text-outline" size={14} color={theme.color.brandPrimary} /><Text style={styles.organizeActionText}>A–Z</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Reset workspaces to default order" onPress={() => { void sortTilesByPreset("default"); }} style={[styles.organizeAction, styles.organizeActionReset]}><Ionicons name="refresh-outline" size={14} color={theme.color.muted} /><Text style={[styles.organizeActionText, styles.organizeActionResetText]}>Reset</Text></Pressable>
                </View>
              </Card> : null}
              <ReorderableWorkspaceGrid
                items={visibleTiles}
                editing={isEditingGrid}
                scrollRef={scrollRef}
                scrollY={scrollY}
                onEditingChange={setIsEditingGrid}
                onOrderChange={moveTile}
                onTilePress={handleTilePress}
              />
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
  locationContext: { marginBottom: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, borderWidth: 1, borderColor: theme.color.brandPrimary + "45", backgroundColor: theme.color.brandPrimary + "0B" },
  locationContextHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 7 },
  locationContextLabel: { color: theme.color.muted, fontSize: 10, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.7 },
  locationContextValue: { flex: 1, color: theme.color.brandPrimary, fontSize: 11, fontWeight: "800", textAlign: "right" },
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
    ...(Platform.OS === "web" ? { boxShadow: "none" } : { elevation: 3, shadowColor: "#000000", shadowOpacity: 0.14, shadowRadius: 7, shadowOffset: { width: 0, height: 3 } }),
  },
  tileIcon: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: "center", alignItems: "center",
  },
  tileLabel: { fontSize: 14, fontWeight: "600", marginTop: 12 },
  emptyText: { color: theme.color.muted, fontSize: 13, textAlign: "center", paddingVertical: theme.spacing.lg },
  dailyCard: { marginBottom: theme.spacing.lg, padding: theme.spacing.lg },
  dailyBodyPressable: { borderRadius: theme.radius.md, paddingBottom: theme.spacing.sm },
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
  quickStartCard: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md, padding: 14, paddingRight: 46, borderColor: theme.color.brandPrimary + "45", backgroundColor: theme.color.brandPrimary + "0B" },
  quickStartIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandPrimary + "18" },
  quickStartCopy: { flex: 1 },
  quickStartTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
  quickStartText: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 2 },
  quickStartButton: { minWidth: 58, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: theme.color.brandPrimary, paddingHorizontal: 14 },
  quickStartButtonText: { color: theme.color.onBrandPrimary, fontSize: 12, fontWeight: "800" },
  quickStartDismiss: { position: "absolute", top: 8, right: 8, width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  quickWorkspaceHeader: { flexDirection: "row", alignItems: "center", marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
  quickWorkspaceTitle: { color: theme.color.onSurface, fontSize: 20, fontWeight: "800", marginBottom: 4 },
  quickWorkspaceHint: { color: theme.color.muted, fontSize: 13 },
  workspaceDone: { backgroundColor: theme.color.brandPrimary, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16 },
  workspaceDoneText: { color: theme.color.onBrandPrimary, fontSize: 12, fontWeight: "800" },
  organizePanel: { marginBottom: theme.spacing.md, padding: theme.spacing.md, backgroundColor: theme.color.glassSurface, borderWidth: 1, borderColor: theme.color.brandPrimary },
  organizeTitle: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800", marginBottom: 3 },
  organizeHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16 },
  organizeActions: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: theme.spacing.sm },
  organizeAction: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: theme.color.brandPrimary + "66", backgroundColor: theme.color.surface },
  organizeActionText: { color: theme.color.brandPrimary, fontSize: 11, fontWeight: "800" },
  organizeActionReset: { borderColor: theme.color.border },
  organizeActionResetText: { color: theme.color.muted },
}); }
