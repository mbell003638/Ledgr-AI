import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { confirmAction } from "@/src/utils/alerts";
import { Empty } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";

type PayType = "supplier_payment" | "drawing" | "commission_payment";
type Payment = {
  id: string; date: string; amount: number; type: PayType; method?: string; notes?: string;
  supplierId?: string; partnerName?: string;
};

const TYPE_LABEL: Record<PayType, string> = {
  supplier_payment: "Supplier Payment",
  drawing: "Drawing",
  commission_payment: "Commission",
};

export default function PaymentsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [payments, setPayments] = useState<Payment[]>([]);
  const [supplierMap, setSupplierMap] = useState<Record<string, string>>({});
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Payment | null>(null);

  const load = useCallback(async () => {
    try {
      const [pl, sl, s] = await Promise.all([api.listPayments(), api.listSuppliers(), api.getSettings()]);
      setPayments(pl as Payment[]);
      
      const smap: Record<string, string> = {};
      (sl as any[]).forEach(sup => { smap[sup.id] = sup.name; });
      setSupplierMap(smap);

      setCurrSym(getCurrencySymbol(s.currency || "USD"));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totalPaid = useMemo(() => payments.reduce((s, p) => s + (Number(p.amount) || 0), 0), [payments]);

  const remove = (p: Payment) => {
    confirmAction(
      "Delete Payment",
      `Delete this ${TYPE_LABEL[p.type]} of ${currSym}${Number(p.amount).toFixed(2)}?`,
      async () => {
        const ok = await requireAuth("Confirm delete payment");
        if (!ok) return;
        try {
          await api.deletePayment(p.id);
          if (selected?.id === p.id) setSelected(null);
          await load();
        } catch (e: any) { Alert.alert("Error", e?.message || "Delete failed"); }
      }
    );
  };

  const getRecipientName = (p: Payment) => {
    if (p.type === "supplier_payment" && p.supplierId) return supplierMap[p.supplierId] || "Unknown Supplier";
    if (p.type === "drawing") return p.partnerName || "Unknown Partner";
    if (p.type === "commission_payment") return "Commission";
    return "Unknown";
  };

  const documentFor = (p: Payment) => ({ 
    title: `Payment`, subtitle: TYPE_LABEL[p.type], rows: [
    ["Recipient", getRecipientName(p)], ["Date", shortDate(p.date)], ["Amount", `${currSym}${Number(p.amount).toFixed(2)}`],
    ["Method", p.method || "—"], ["Notes", p.notes || "—"],
  ] as Array<[string, unknown]> });

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable><Text style={styles.headerTitle}>Payment</Text><View style={{ width: 26 }} /></View>
      <TransactionDetail
        title={getRecipientName(selected)}
        subtitle={`${TYPE_LABEL[selected.type]} • ${currSym}${Number(selected.amount).toFixed(2)}`}
        onEdit={() => router.push({ pathname: "/payment-form", params: { id: selected.id } } as any)}
        onReversalDelete={() => remove(selected)}
        onShare={() => shareTransaction(documentFor(selected))}
        onPrint={() => printTransaction(documentFor(selected))}
        onMore={() => Alert.alert("Payment details", selected.notes || `${selected.method || "Unknown"} method`)}
      ><Text style={styles.rowSub}>{shortDate(selected.date)}</Text></TransactionDetail>
    </SafeAreaView>
  );

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Payments</Text>
        <Pressable onPress={() => router.push("/payment-form")}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Paid</Text>
        <Text style={styles.summaryValue}>{currSym}{totalPaid.toFixed(2)}</Text>
      </View>
      <FlatList
        data={payments}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brandPrimary} />}
        ListEmptyComponent={<Empty icon={<Ionicons name="cash-outline" size={40} color={theme.color.muted} />} title="No payments yet" hint="Tap + to record money paid." />}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} onLongPress={() => remove(item)} style={styles.row}>
            <View style={[styles.badge, { backgroundColor: item.type === "supplier_payment" ? "#F0D8D8" : "#E8E8E8" }]}>
              <Ionicons name={item.type === "supplier_payment" ? "arrow-up-circle-outline" : "wallet-outline"} size={18} color={theme.color.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{getRecipientName(item)} · {TYPE_LABEL[item.type]}</Text>
              <Text style={styles.rowSub}>{shortDate(item.date)}{item.method ? ` · ${item.method}` : ""}</Text>
            </View>
            <Text style={styles.rowAmount}>{currSym}{Number(item.amount).toFixed(2)}</Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    summaryBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
    summaryLabel: { fontSize: 12, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5 },
    summaryValue: { fontSize: 18, fontWeight: "700", color: theme.color.error }, // Payments are red/error color usually
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    badge: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center" },
    rowTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
    rowSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    rowAmount: { fontSize: 15, fontWeight: "700", color: theme.color.error }, // Errors for negative cashflow
  });
}
