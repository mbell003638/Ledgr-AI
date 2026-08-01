import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { getCurrencySymbol } from "@/src/db/local";

type Entry = { id: string; date: string; type: string; amount: number; label: string; sub: string; color: string };

const TYPE_COLOR: Record<string, string> = {
  sale: "#34C759", bill: "#FF3B30", payment: "#FF9500",
  drawing: "#AF52DE", expense: "#FF2D55", invoice: "#007AFF",
};
const TYPE_LABEL: Record<string, string> = {
  sale: "Sale", bill: "Purchase", payment: "Payment",
  drawing: "Drawing", expense: "Expense", invoice: "Invoice",
};

export default function DayBook() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      const [bills, sales, payments, expenses, invoices] = await Promise.all([
        api.listBills(), api.listSales(), api.listPayments(),
        api.listExpenses(), api.listInvoices(),
      ]);
      const all: Entry[] = [
        ...(bills as any[]).map((b) => ({ id: b.id, date: b.date, type: "bill", amount: b.amount, label: `Purchase`, sub: b.notes || "", color: TYPE_COLOR.bill })),
        ...(sales as any[]).map((s) => ({ id: s.id, date: s.date, type: "sale", amount: s.amount, label: "Sale", sub: s.notes || "", color: TYPE_COLOR.sale })),
        ...(payments as any[]).map((p) => ({ id: p.id, date: p.date, type: p.type === "drawing" ? "drawing" : "payment", amount: p.amount, label: p.type === "drawing" ? `Drawing${p.partnerName ? ` — ${p.partnerName}` : ""}` : "Payment", sub: p.notes || "", color: p.type === "drawing" ? TYPE_COLOR.drawing : TYPE_COLOR.payment })),
        ...(expenses as any[]).map((e) => ({ id: e.id, date: e.date, type: "expense", amount: e.amount, label: `Expense — ${e.category}`, sub: e.notes || "", color: TYPE_COLOR.expense })),
        ...(invoices as any[]).map((i) => ({ id: i.id, date: i.date, type: "invoice", amount: i.total, label: `Invoice ${i.invoiceNumber} — ${i.clientName}`, sub: i.status, color: TYPE_COLOR.invoice })),
      ];
      all.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
      setEntries(all);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Group by date
  const grouped = useMemo(() => {
    const map: Record<string, Entry[]> = {};
    for (const e of entries) {
      const d = e.date?.slice(0, 10) || "Unknown";
      if (!map[d]) map[d] = [];
      map[d].push(e);
    }
    return Object.entries(map).sort((a, b) => (a[0] > b[0] ? -1 : 1));
  }, [entries]);

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Day Book</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {grouped.length === 0 ? (
          <Text style={styles.empty}>No transactions yet.</Text>
        ) : grouped.map(([date, dayEntries]) => {
          const dayIn = dayEntries.filter((e) => e.type === "sale").reduce((s, e) => s + e.amount, 0);
          const dayOut = dayEntries.filter((e) => ["bill", "expense", "drawing"].includes(e.type)).reduce((s, e) => s + e.amount, 0);
          return (
            <View key={date} style={{ marginBottom: theme.spacing.lg }}>
              <View style={styles.dateHeader}>
                <Text style={styles.dateText}>{shortDate(date)}</Text>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Text style={{ fontSize: 12, color: theme.color.success, fontWeight: "600" }}>+{fmt(dayIn, currSym)}</Text>
                  <Text style={{ fontSize: 12, color: theme.color.error, fontWeight: "600" }}>-{fmt(dayOut, currSym)}</Text>
                </View>
              </View>
              {dayEntries.map((e) => (
                <View key={e.id} style={styles.row}>
                  <View style={[styles.dot, { backgroundColor: e.color }]} />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={styles.label}>{e.label}{(e as any).originalDate && (e as any).originalDate !== (e as any).date ? ` (was ${shortDate((e as any).originalDate)})` : ""}</Text>
                      {(e as any).isEdited && (
                        <View style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.3)" }}>
                          <Text style={{ fontSize: 10, fontWeight: "700", color: "#f59e0b" }}>
                            Edited {(e as any).editedAt ? `• ${shortDate((e as any).editedAt)}` : ""}
                          </Text>
                        </View>
                      )}
                    </View>
                    {e.sub ? <Text style={styles.sub}>{e.sub}</Text> : null}
                  </View>
                  <Text style={[styles.amount, { color: e.type === "sale" ? theme.color.success : e.type === "invoice" ? theme.color.muted : theme.color.error }]}>
                    {e.type === "sale" ? "+" : e.type === "invoice" ? "" : "-"}{fmt(e.amount, currSym)}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}
        <View style={{ height: 60 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    dateHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
    dateText: { fontSize: 13, fontWeight: "700", color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5 },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: 6, gap: 10 },
    dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    sub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
    amount: { fontSize: 14, fontWeight: "700" },
    empty: { color: theme.color.muted, textAlign: "center", padding: 40 },
  });
}
