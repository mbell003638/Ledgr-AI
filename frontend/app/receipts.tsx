import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, TextInput, Alert, Modal, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { confirmAction } from "@/src/utils/alerts";
import { Empty, Card } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { GlowPressable } from "@/src/components/GlowPressable";
import { ActionSheetModal } from "@/src/components/ActionSheetModal";

type Mode = "cash_sale" | "against_invoice" | "advance";
type Receipt = {
  id: string; receiptNumber: string; mode: Mode; date: string; amount: number;
  clientName?: string; debtorId?: string | null; method?: string; notes?: string;
  allocations?: { invoiceId: string; amountApplied: number }[];
};
type Invoice = { id: string; invoiceNumber: string; clientName: string; total: number; status: string; date: string };
type Debtor = { id: string; name: string; balance?: number };

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const MODE_LABEL: Record<Mode, string> = {
  cash_sale: "Cash Sale",
  against_invoice: "Payment Against Invoice",
  advance: "Advance Payment",
};

export default function ReceiptsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [taxRate, setTaxRate] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Receipt | null>(null);
  const [moreModalVisible, setMoreModalVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rl, il, dl, s] = await Promise.all([api.listReceipts(), api.listInvoices(), api.listDebtors(), api.getSettings()]);
      setReceipts(rl as Receipt[]);
      setInvoices((il as Invoice[]).filter((i) => i.status !== "paid"));
      setDebtors(dl as Debtor[]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setTaxRate(Number(s.taxRate) || 0);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totalReceived = useMemo(() => receipts.reduce((s, r) => s + (Number(r.amount) || 0), 0), [receipts]);


  const remove = (r: Receipt) => {
    confirmAction(
      "Delete Receipt",
      `Delete ${r.receiptNumber}? This reverses its cash, sales and debtor entries.`,
      async () => {
        const ok = await requireAuth("Confirm delete receipt");
        if (!ok) return;
        try {
          await api.deleteReceipt(r.id);
          if (selected?.id === r.id) setSelected(null);
          await load();
        } catch (e: any) { Alert.alert("Error", e?.message || "Delete failed"); }
      }
    );
  };

  const openEdit = (r: Receipt) => {
    setSelected(null);
    router.push({ pathname: "/receipt-form", params: { id: r.id } } as any);
  };
  const documentFor = (r: Receipt) => ({ title: `Receipt ${r.receiptNumber}`, subtitle: MODE_LABEL[r.mode], rows: [
    ["Customer", r.clientName || "Walk-in"], ["Date", shortDate(r.date)], ["Amount", `${currSym}${Number(r.amount).toFixed(2)}`],
    ["Method", r.method || "—"], ["Notes", r.notes || "—"],
  ] as Array<[string, unknown]> });

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable><Text style={styles.headerTitle}>Receipt</Text><View style={{ width: 26 }} /></View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <TransactionDetail
          title={selected.receiptNumber}
          subtitle={`${MODE_LABEL[selected.mode]} • ${currSym}${Number(selected.amount).toFixed(2)}`}
          onEdit={() => openEdit(selected)}
          onReversalDelete={() => remove(selected)}
          onShare={() => shareTransaction(documentFor(selected))}
          onPrint={() => printTransaction(documentFor(selected))}
          onMore={() => setMoreModalVisible(true)}
        ><Text style={styles.rowSub}>{selected.clientName || "Walk-in"} • {shortDate(selected.date)}</Text></TransactionDetail>
      </ScrollView>
      <ActionSheetModal
        visible={moreModalVisible}
        onClose={() => setMoreModalVisible(false)}
        title={`Receipt ${selected.receiptNumber}`}
        subtitle={`${selected.clientName || "Walk-in"} • ${currSym}${Number(selected.amount).toFixed(2)}`}
        actions={[
          {
            id: "share",
            label: "Share Document Summary",
            icon: "share-social-outline",
            onPress: () => shareTransaction(documentFor(selected)),
          },
          {
            id: "print",
            label: "Print Receipt",
            icon: "print-outline",
            onPress: () => printTransaction(documentFor(selected)),
          },
          {
            id: "edit",
            label: "Edit Receipt",
            icon: "create-outline",
            onPress: () => openEdit(selected),
          },
          {
            id: "delete",
            label: "Delete / Reverse Receipt",
            icon: "trash-outline",
            destructive: true,
            onPress: () => remove(selected),
          },
        ]}
      />
    </SafeAreaView>
  );

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Receipts</Text>
        <Pressable onPress={() => router.push("/receipt-form")}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <View style={styles.summaryCard}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={styles.summaryIconBox}>
            <Ionicons name="arrow-down-circle-outline" size={18} color={theme.color.success} />
          </View>
          <Text style={styles.summaryLabel}>Total Received</Text>
        </View>
        <Text style={styles.summaryValue}>{currSym}{totalReceived.toFixed(2)}</Text>
      </View>
      <FlatList
        data={receipts}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brandPrimary} />}
        ListEmptyComponent={<Empty icon={<Ionicons name="receipt-outline" size={40} color={theme.color.muted} />} title="No receipts yet" hint="Tap + to record money received." />}
        renderItem={({ item }) => (
          <GlowPressable onPress={() => setSelected(item)} onLongPress={() => remove(item)} haptic topHighlight={false} restingBorderColor={theme.color.border} style={styles.row}>
            <View style={[styles.badge, { backgroundColor: item.mode === "cash_sale" ? "#DCE8DC" : item.mode === "advance" ? "#F0E4D0" : "#D8E4F0" }]}>
              <Ionicons name={item.mode === "cash_sale" ? "cart-outline" : item.mode === "advance" ? "arrow-down-circle-outline" : "document-text-outline"} size={18} color={theme.color.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.receiptNumber} · {MODE_LABEL[item.mode]}</Text>
              <Text style={styles.rowSub}>{item.clientName || "Walk-in"} · {shortDate(item.date)}{item.method ? ` · ${item.method}` : ""}</Text>
            </View>
            <Text style={styles.rowAmount}>{currSym}{Number(item.amount).toFixed(2)}</Text>
          </GlowPressable>
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
    summaryCard: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.md, marginBottom: 4, paddingHorizontal: theme.spacing.lg, paddingVertical: 12, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border },
    summaryIconBox: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.color.success + "18", alignItems: "center", justifyContent: "center" },
    summaryLabel: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    summaryValue: { fontSize: 18, fontWeight: "700", color: theme.color.success },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    badge: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center" },
    rowTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
    rowSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    rowAmount: { fontSize: 15, fontWeight: "700", color: theme.color.success },
    modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
    modalBox: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.spacing.lg, maxHeight: "88%", width: "100%", maxWidth: 480, alignSelf: "center" },
    modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.spacing.md },
    modalTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    scanRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
    scanBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, paddingVertical: 10, borderRadius: theme.radius.md },
    scanText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    modeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    modeBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    modeBtnActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    modeText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface },
    modeTextActive: { color: "#fff" },
    pickRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, marginTop: 6 },
    pickRowActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandTertiary },
    pickTitle: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    pickAmt: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
    saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  });
}
