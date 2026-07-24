import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Switch, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import * as db from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import dayjs from "dayjs";

export default function EmployeeReportScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  
  const [periods, setPeriods] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>("current");
  const [currentData, setCurrentData] = useState<any>(null);
  const [showNet, setShowNet] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [allPeriods, dash] = await Promise.all([
        db.listPeriods(),
        db.dashboard()
      ]);
      setPeriods(allPeriods);
      setCurrentData(dash);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const report = useMemo(() => {
    if (!currentData) return null;
    if (selectedId === "current") {
      const opening = currentData.openingInventory;
      const expected = opening + currentData.totalPurchases - currentData.totalSales;
      const actual = currentData.inventoryValue;
      const grossProfit = actual - expected;
      
      const expenses = currentData.drawings;
      const netProfit = grossProfit - expenses;
      const commAmt = currentData.commission; 
      const restNet = netProfit - commAmt;
      
      return {
        opening,
        purchases: currentData.totalPurchases,
        expectedGoods: opening + currentData.totalPurchases,
        sales: currentData.totalSales,
        expectedStock: expected,
        actualStock: actual,
        grossProfit,
        expenses,
        netProfit,
        commissionPct: currentData.managerCommissionPct,
        commissionAmt: commAmt,
        restNet
      };
    } else {
      const p = periods.find(x => x.id === selectedId);
      if (!p) return null;
      
      const opening = p.openingInventory;
      const expected = opening + p.totalPurchases - p.totalSales;
      const actual = p.actualStock || p.expectedStock;
      const grossProfit = actual - expected;
      
      return {
        opening,
        purchases: p.totalPurchases,
        expectedGoods: opening + p.totalPurchases,
        sales: p.totalSales,
        expectedStock: expected,
        actualStock: actual,
        grossProfit,
        expenses: p.drawings || 0,
        netProfit: grossProfit - (p.drawings || 0),
        commissionPct: p.managerCommissionPct || 0,
        commissionAmt: p.commission || 0,
        restNet: grossProfit - (p.drawings || 0) - (p.commission || 0)
      };
    }
  }, [selectedId, currentData, periods]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Employee Report" subtitle="Inventory & Profit Flow" />
      
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll}>
          
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.periodScroll} contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
            <Pressable
              onPress={() => setSelectedId("current")}
              style={[styles.chip, selectedId === "current" && styles.chipActive]}
            >
              <Text style={[styles.chipText, selectedId === "current" && styles.chipTextActive]}>Current Period</Text>
            </Pressable>
            {periods.map(p => (
              <Pressable
                key={p.id}
                onPress={() => setSelectedId(p.id)}
                style={[styles.chip, selectedId === p.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, selectedId === p.id && styles.chipTextActive]}>
                  {dayjs(p.startDate).format('MMM D')} - {dayjs(p.endDate).format('MMM D, YY')}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Show Net Profit & Commission</Text>
            <Switch value={showNet} onValueChange={setShowNet} trackColor={{ true: theme.color.brandPrimary }} />
          </View>

          {report && (
            <Card>
              <Text style={styles.rTitle}>Inventory Flow</Text>
              
              <RowKV label="Opening Stock As Per Inventory" value={fmt(report.opening)} theme={theme} styles={styles} />
              <RowKV label="Plus: Total Purchase in Period" value={fmt(report.purchases)} color={theme.color.success} theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Total Amount of Physical Goods" value={fmt(report.expectedGoods)} strong theme={theme} styles={styles} />
              
              <View style={{ height: 16 }} />
              <RowKV label="Minus: Total Sales in Period" value={`(${fmt(report.sales)})`} color={theme.color.error} theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Total Stock Should Rest In Shop" value={fmt(report.expectedStock)} strong theme={theme} styles={styles} />
              
              <View style={{ height: 16 }} />
              <RowKV label="Real Amount Of Physical Goods (Inventory)" value={fmt(report.actualStock)} theme={theme} styles={styles} />
              <View style={styles.divider} />
              <RowKV label="Gross Profit" value={fmt(report.grossProfit)} strong color={report.grossProfit >= 0 ? theme.color.success : theme.color.error} theme={theme} styles={styles} />
              
              {showNet && (
                <>
                  <View style={{ height: 16 }} />
                  <View style={[styles.divider, { borderStyle: 'dashed', borderWidth: 1, borderColor: theme.color.border, backgroundColor: 'transparent', height: 0 }]} />
                  <View style={{ height: 16 }} />
                  
                  <RowKV label="Minus: Total Expenses of Business" value={`(${fmt(report.expenses)})`} color={theme.color.error} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Net Profit" value={fmt(report.netProfit)} strong theme={theme} styles={styles} />
                  
                  <View style={{ height: 16 }} />
                  <RowKV label={`Minus: ${report.commissionPct}% Commission`} value={`(${fmt(report.commissionAmt)})`} color={theme.color.error} theme={theme} styles={styles} />
                  <View style={styles.divider} />
                  <RowKV label="Rest Net Profit" value={fmt(report.restNet)} strong big color={report.restNet >= 0 ? theme.color.success : theme.color.error} theme={theme} styles={styles} />
                </>
              )}
            </Card>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function RowKV({ label, value, strong, big, color, theme, styles }: { label: string; value: string; strong?: boolean; big?: boolean; color?: string; theme: any; styles: any }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, strong && { fontWeight: "700", color: theme.color.onSurface }]}>{label}</Text>
      <Text style={[styles.kvValue, strong && { fontWeight: "700" }, big && { fontSize: 18 }, color ? { color } : {}]}>{value}</Text>
    </View>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surfaceSecondary },
  scroll: { paddingBottom: 40 },
  periodScroll: { maxHeight: 50, minHeight: 50, marginBottom: theme.spacing.md },
  chip: { 
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border,
    justifyContent: 'center', alignItems: 'center'
  },
  chipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  chipText: { color: theme.color.muted, fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md,
    padding: theme.spacing.md, backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border
  },
  toggleLabel: { fontSize: 14, fontWeight: "500", color: theme.color.onSurface },
  rTitle: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.lg },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, alignItems: 'center' },
  kvLabel: { fontSize: 13, color: theme.color.onSurfaceTertiary, flex: 1, paddingRight: 8 },
  kvValue: { fontSize: 14, color: theme.color.onSurface, fontWeight: "500" },
  divider: { height: 1, backgroundColor: theme.color.divider, marginVertical: theme.spacing.sm },
}); }
