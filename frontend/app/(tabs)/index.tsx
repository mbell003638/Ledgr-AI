import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { BarChart } from "react-native-gifted-charts";

import { theme, fmt } from "@/src/theme";
import { api } from "@/src/api";
import { ScreenHeader, KpiTile, Card } from "@/src/components/UI";

type Dash = {
  assets: number; liabilities: number; netWorth: number;
  cash: number; inventoryValue: number;
  totalPurchases: number; totalSales: number; grossProfit: number;
  drawings: number; supplierPayments: number; suppliers: number;
  salesTrend: { date: string; value: number }[];
};

const TILES = [
  { key: "bills", label: "Vendor Bills", icon: "receipt-outline", route: "/bills", color: "#D6E5DB" },
  { key: "sales", label: "Sales", icon: "trending-up-outline", route: "/sale-form", color: "#F3E4C8" },
  { key: "payments", label: "Payments", icon: "cash-outline", route: "/payment-form", color: "#E8DAD0" },
  { key: "suppliers", label: "Partners", icon: "people-outline", route: "/suppliers", color: "#DCE4E0" },
  { key: "inventory", label: "Inventory", icon: "cube-outline", route: "/inventory-form", color: "#E3E9DA" },
  { key: "reports", label: "Reports", icon: "bar-chart-outline", route: "/reports", color: "#E0E0DA" },
  { key: "voice", label: "AI Assistant", icon: "mic-outline", route: "/voice", color: "#1C4030" },
  { key: "settings", label: "Settings", icon: "settings-outline", route: "/settings", color: "#EAECE7" },
] as const;

export default function Dashboard() {
  const router = useRouter();
  const [dash, setDash] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.dashboard();
      setDash(d);
    } catch (e) {
      console.warn("dash", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(); };

  const barData = (dash?.salesTrend || []).map((s) => ({
    value: s.value,
    label: s.date.slice(5),
    frontColor: theme.color.brandSecondary,
  }));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Vocash" subtitle="Shop accounting suite" testID="dashboard-header" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandPrimary} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && !dash ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
        ) : (
          <>
            {/* Net worth hero */}
            <LinearGradient
              colors={[theme.color.brandPrimary, theme.color.brandSecondary]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.hero}
            >
              <Text style={styles.heroLabel}>Net Worth</Text>
              <Text style={styles.heroValue} testID="dashboard-net-worth">{fmt(dash?.netWorth)}</Text>
              <View style={styles.heroRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroSub}>Assets</Text>
                  <Text style={styles.heroSubVal}>{fmt(dash?.assets)}</Text>
                </View>
                <View style={{ width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.2)" }} />
                <View style={{ flex: 1, paddingLeft: theme.spacing.md }}>
                  <Text style={styles.heroSub}>Liabilities</Text>
                  <Text style={styles.heroSubVal}>{fmt(dash?.liabilities)}</Text>
                </View>
              </View>
            </LinearGradient>

            {/* KPI row */}
            <View style={styles.kpiRow}>
              <KpiTile label="Sales" value={fmt(dash?.totalSales)} testID="kpi-sales" />
              <KpiTile label="Purchases" value={fmt(dash?.totalPurchases)} testID="kpi-purchases" />
            </View>
            <View style={styles.kpiRow}>
              <KpiTile label="Cash" value={fmt(dash?.cash)} testID="kpi-cash" />
              <KpiTile label="Inventory" value={fmt(dash?.inventoryValue)} testID="kpi-inventory" />
            </View>

            {/* Apps grid */}
            <Text style={styles.sectionTitle}>Apps</Text>
            <View style={styles.grid}>
              {TILES.map((t) => {
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

const styles = StyleSheet.create({
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
  },
  tileIcon: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: "center", alignItems: "center",
  },
  tileLabel: { fontSize: 14, fontWeight: "600", marginTop: 12 },
  emptyText: { color: theme.color.muted, fontSize: 13, textAlign: "center", paddingVertical: theme.spacing.lg },
});
