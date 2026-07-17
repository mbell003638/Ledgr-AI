import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { theme, fmt, shortDate } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function SupplierDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.getSupplier(id);
      setData(r);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }
  if (!data) {
    return <SafeAreaView style={styles.container}><Text style={{ padding: 20 }}>Not found</Text></SafeAreaView>;
  }

  const initials = data.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
  const owing = (data.balance ?? 0) > 0;

  // Merge bills + payments into a timeline
  const timeline = [
    ...data.bills.map((b: any) => ({ ...b, kind: "bill" })),
    ...data.payments.map((p: any) => ({ ...p, kind: "payment" })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back" onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Partner Statement</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <Card>
          <View style={styles.top}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} testID="supplier-detail-name">{data.name}</Text>
              <Text style={styles.sub}>{data.phone || "No phone"}</Text>
            </View>
          </View>
          <View style={styles.balBox}>
            <Text style={styles.balLabel}>Outstanding Balance</Text>
            <Text style={[styles.balValue, { color: owing ? theme.color.error : theme.color.success }]} testID="supplier-balance">{fmt(data.balance)}</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 12 }}>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Bills</Text>
                <Text style={styles.smVal}>{fmt(data.billsTotal)}</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Payments</Text>
                <Text style={styles.smVal}>{fmt(data.paymentsTotal)}</Text>
              </View>
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md }}>
            <Pressable
              testID="btn-add-bill-from-supplier"
              onPress={() => router.push({ pathname: "/bill-form", params: { supplierId: id } })}
              style={styles.actionBtn}
            >
              <Ionicons name="receipt-outline" size={16} color="#fff" />
              <Text style={styles.actionText}>Add Bill</Text>
            </Pressable>
            <Pressable
              testID="btn-add-payment-from-supplier"
              onPress={() => router.push("/payment-form")}
              style={[styles.actionBtn, { backgroundColor: theme.color.brandSecondary }]}
            >
              <Ionicons name="cash-outline" size={16} color="#fff" />
              <Text style={styles.actionText}>Pay</Text>
            </Pressable>
          </View>
        </Card>

        <Text style={styles.section}>Account Statement</Text>
        {timeline.length === 0 ? (
          <Text style={styles.empty}>No transactions yet.</Text>
        ) : timeline.map((t) => (
          <View key={t.id} style={styles.timelineRow}>
            <View style={[styles.timelineDot, { backgroundColor: t.kind === "bill" ? theme.color.warning : theme.color.success }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.tlTitle}>{t.kind === "bill" ? "Bill" : "Payment"} • {shortDate(t.date)}</Text>
              <Text style={styles.tlSub}>{t.notes || t.reference || t.invoiceNo || "—"}</Text>
            </View>
            <Text style={[styles.tlAmount, { color: t.kind === "bill" ? theme.color.error : theme.color.success }]}>
              {t.kind === "bill" ? "+" : "-"}{fmt(t.amount, t.currency)}
            </Text>
          </View>
        ))}
        <View style={{ height: 60 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  top: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: theme.color.brandTertiary, justifyContent: "center", alignItems: "center" },
  avatarText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 20 },
  name: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface },
  sub: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
  balBox: { marginTop: theme.spacing.lg, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, alignItems: "center" },
  balLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  balValue: { fontSize: 28, fontWeight: "700", marginTop: 4 },
  smLabel: { fontSize: 11, color: theme.color.muted },
  smVal: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface, marginTop: 2 },
  actionBtn: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: 12, borderRadius: theme.radius.md },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
  empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
  timelineRow: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
  timelineDot: { width: 10, height: 10, borderRadius: 5 },
  tlTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
  tlSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  tlAmount: { fontSize: 14, fontWeight: "700" },
});
