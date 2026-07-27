import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { confirmAction } from "@/src/utils/alerts";

export default function BillsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [bills, setBills] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([api.listBills(), api.listSuppliers()]);
      setBills(b);
      const map: Record<string, string> = {};
      s.forEach((x: any) => (map[x.id] = x.name));
      setSuppliers(map);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const documentFor = (bill: any) => ({ title: "Vendor Bill", subtitle: shortDate(bill.date), rows: [
    ["Supplier", suppliers[bill.supplierId] || "Unknown supplier"], ["Amount", fmt(bill.amount, bill.currency)],
    ["Payment", bill.paymentType], ["Invoice #", bill.invoiceNo || "—"], ["Notes", bill.notes || "—"],
  ] as Array<[string, unknown]> });
  const reverseBill = (bill: any) => confirmAction(
    "Reverse / Delete Bill",
    "This creates the appropriate V2 reversal and removes the bill from active records.",
    async () => { await api.deleteBill(bill.id); setSelected(null); await load(); },
    "Reverse / Delete"
  );

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable></View>
      <ScrollView contentContainerStyle={styles.list}>
        <TransactionDetail
          title={suppliers[selected.supplierId] || "Vendor Bill"}
          subtitle={`${fmt(selected.amount, selected.currency)} • ${shortDate(selected.date)}`}
          onEdit={() => router.push({ pathname: "/bill-form", params: { id: selected.id } })}
          onReversalDelete={() => reverseBill(selected)}
          onShare={() => shareTransaction(documentFor(selected))}
          onPrint={() => printTransaction(documentFor(selected))}
          onMore={() => Alert.alert("Bill details", selected.notes || selected.invoiceNo || "No additional details")}
        ><Text style={styles.cardSub}>{selected.paymentType === "cash" ? "Cash" : "Credit"}{selected.invoiceNo ? ` • #${selected.invoiceNo}` : ""}</Text></TransactionDetail>
      </ScrollView>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}>
        <ScreenHeader title="Vendor Bills" subtitle={`${bills.length} purchase${bills.length === 1 ? "" : "s"} logged`} />
        <Pressable
          testID="btn-add-bill"
          onPress={() => router.push("/bill-form")}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={22} color="#fff" />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={bills}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="receipt-outline" size={40} color={theme.color.muted} />}
              title="No bills recorded yet"
              hint="Tap the + button to log a vendor purchase."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`bill-${item.id}`}
              onPress={() => setSelected(item)}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{suppliers[item.supplierId] || "Unknown supplier"}</Text>
                <Text style={styles.cardSub}>{shortDate(item.date)} • {item.paymentType === "cash" ? "Cash" : "Credit"}{item.invoiceNo ? ` • #${item.invoiceNo}` : ""}</Text>
              </View>
              <Text style={styles.amount}>{fmt(item.amount, item.currency)}</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: theme.spacing.lg },
  addBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: theme.color.brandPrimary,
    justifyContent: "center", alignItems: "center",
    marginTop: theme.spacing.md,
  },
  list: { paddingHorizontal: theme.spacing.lg, paddingBottom: 140, gap: theme.spacing.md },
  card: {
    flexDirection: "row",
    backgroundColor: theme.color.surfaceSecondary,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    alignItems: "center",
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: theme.color.onSurface },
  cardSub: { fontSize: 12, color: theme.color.muted, marginTop: 4 },
  amount: { fontSize: 16, fontWeight: "700", color: theme.color.brandPrimary },
  delete: { fontSize: 11, color: theme.color.error, marginTop: 4 },
}); }
