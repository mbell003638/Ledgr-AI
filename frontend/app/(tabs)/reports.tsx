import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { theme, fmt } from "@/src/theme";
import { api } from "@/src/api";
import { ScreenHeader, Card } from "@/src/components/UI";

const SEGMENTS = ["P&L", "Balance", "Trial"] as const;
type Seg = typeof SEGMENTS[number];

export default function ReportsScreen() {
  const [seg, setSeg] = useState<Seg>("P&L");
  const [pnl, setPnl] = useState<any>(null);
  const [bs, setBs] = useState<any>(null);
  const [tb, setTb] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, b, t] = await Promise.all([api.pnl(), api.balanceSheet(), api.trialBalance()]);
      setPnl(p); setBs(b); setTb(t);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Reports" subtitle="Financial statements" />
      <View style={styles.segRow}>
        {SEGMENTS.map((s) => (
          <Pressable
            key={s}
            testID={`report-seg-${s}`}
            onPress={() => setSeg(s)}
            style={[styles.seg, seg === s && styles.segActive]}
          >
            <Text style={[styles.segText, seg === s && styles.segTextActive]}>{s}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {seg === "P&L" && pnl && (
            <Card testID="report-pnl">
              <Text style={styles.rTitle}>Profit & Loss</Text>
              <RowKV label="Revenue" value={fmt(pnl.revenue)} />
              <RowKV label="Cost of Goods Sold" value={`- ${fmt(pnl.cogs)}`} />
              <RowKV label="Gross Profit" value={fmt(pnl.grossProfit)} strong />
              <RowKV label="Drawings" value={`- ${fmt(pnl.drawings)}`} />
              <View style={styles.divider} />
              <RowKV label="Net Profit" value={fmt(pnl.netProfit)} strong big />
            </Card>
          )}
          {seg === "Balance" && bs && (
            <>
              <Card testID="report-bs-assets">
                <Text style={styles.rTitle}>Assets</Text>
                <RowKV label="Cash" value={fmt(bs.assets.cash)} />
                <RowKV label="Inventory" value={fmt(bs.assets.inventory)} />
                <View style={styles.divider} />
                <RowKV label="Total Assets" value={fmt(bs.assets.total)} strong />
              </Card>
              <Card style={{ marginTop: theme.spacing.md }} testID="report-bs-liab">
                <Text style={styles.rTitle}>Liabilities & Equity</Text>
                <RowKV label="Suppliers Payable" value={fmt(bs.liabilities.suppliersPayable)} />
                <RowKV label="Owner's Equity" value={fmt(bs.equity)} />
              </Card>
            </>
          )}
          {seg === "Trial" && tb && (
            <Card testID="report-tb">
              <Text style={styles.rTitle}>Trial Balance</Text>
              <Text style={styles.groupHeader}>Debits</Text>
              {tb.debits.map((d: any) => <RowKV key={d.account} label={d.account} value={fmt(d.amount)} />)}
              <Text style={styles.groupHeader}>Credits</Text>
              {tb.credits.map((c: any) => <RowKV key={c.account} label={c.account} value={fmt(c.amount)} />)}
            </Card>
          )}
          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function RowKV({ label, value, strong, big }: { label: string; value: string; strong?: boolean; big?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, strong && { fontWeight: "700", color: theme.color.onSurface }]}>{label}</Text>
      <Text style={[styles.kvValue, strong && { fontWeight: "700" }, big && { fontSize: 18 }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  segRow: {
    flexDirection: "row", marginHorizontal: theme.spacing.lg, backgroundColor: theme.color.surfaceTertiary,
    borderRadius: theme.radius.md, padding: 4, marginBottom: theme.spacing.md,
  },
  seg: { flex: 1, paddingVertical: 10, borderRadius: theme.radius.sm, alignItems: "center" },
  segActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 13 },
  segTextActive: { color: theme.color.onSurface, fontWeight: "600" },
  scroll: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
  rTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.md },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  kvLabel: { fontSize: 14, color: theme.color.onSurfaceTertiary },
  kvValue: { fontSize: 14, color: theme.color.onSurface, fontWeight: "500" },
  divider: { height: 1, backgroundColor: theme.color.divider, marginVertical: theme.spacing.sm },
  groupHeader: { fontSize: 12, fontWeight: "700", color: theme.color.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm, textTransform: "uppercase", letterSpacing: 0.5 },
});
