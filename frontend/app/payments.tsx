import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { useScreenData } from "@/src/hooks/useScreenData";
import { getCurrencySymbol } from "@/src/db/local";
import { confirmAction } from "@/src/utils/alerts";
import { Empty } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { ActionSheetModal } from "@/src/components/ActionSheetModal";
import { GlowPressable } from "@/src/components/GlowPressable";

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

  const [selected, setSelected] = useState<Payment | null>(null);
  const [moreModalVisible, setMoreModalVisible] = useState(false);

  const loader = useCallback(async () => {
    const [pl, sl, s] = await Promise.all([api.listPayments(), api.listSuppliers(), api.getSettings()]);
    const smap: Record<string, string> = {};
    (sl as any[]).forEach(sup => { smap[sup.id] = sup.name; });
    return {
      payments: pl as Payment[],
      supplierMap: smap,
      currSym: getCurrencySymbol(s.currency || "USD"),
      isPartnerMode: s.accountingStyle === 'retail_partnership',
    };
  }, []);

  const { data, loading, refreshing, reload, refresh } = useScreenData(
    `payments:${api.activeBookId()}`,
    loader,
  );
  const payments = data?.payments ?? [];
  const supplierMap = data?.supplierMap ?? {};
  const currSym = data?.currSym ?? "$";
  const isPartnerMode = data?.isPartnerMode ?? false;
  const load = reload;

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
    if (p.type === "drawing") return isPartnerMode ? (p.partnerName || "Unknown Partner") : "Owner's Equity";
    if (p.type === "commission_payment") return "Commission";
    return "Unknown";
  };

  const documentFor = (p: Payment) => ({ 
    title: `Payment`, subtitle: TYPE_LABEL[p.type], rows: [
    ["Recipient", getRecipientName(p)], ["Date", shortDate(p.date)], ["Amount", `${currSym}${Number(p.amount).toFixed(2)}`],
    ["Method", p.method || "—"], ["Notes", p.notes || "—"],
  ] as [string, unknown][] });

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable><Text style={styles.headerTitle}>Payment</Text><View style={{ width: 26 }} /></View>
      <TransactionDetail
        title={getRecipientName(selected)}
        subtitle={`${TYPE_LABEL[selected.type]} • ${currSym}${Number(selected.amount).toFixed(2)}`}
        onEdit={() => {
          setSelected(null);
          router.push({ pathname: "/payment-form", params: { id: selected.id } } as any);
        }}
        onReversalDelete={() => remove(selected)}
        onShare={() => shareTransaction(documentFor(selected))}
        onPrint={() => printTransaction(documentFor(selected))}
        onMore={() => setMoreModalVisible(true)}
      ><Text style={styles.rowSub}>{shortDate(selected.date)}</Text></TransactionDetail>
      <ActionSheetModal
        visible={moreModalVisible}
        onClose={() => setMoreModalVisible(false)}
        title={`Payment to ${getRecipientName(selected)}`}
        subtitle={`${TYPE_LABEL[selected.type]} • ${currSym}${Number(selected.amount).toFixed(2)}`}
        actions={[
          {
            id: "share",
            label: "Share Payment Voucher",
            icon: "share-social-outline",
            onPress: () => shareTransaction(documentFor(selected)),
          },
          {
            id: "print",
            label: "Print Voucher",
            icon: "print-outline",
            onPress: () => printTransaction(documentFor(selected)),
          },
          {
            id: "edit",
            label: "Edit Payment",
            icon: "create-outline",
            onPress: () => router.push({ pathname: "/payment-form", params: { id: selected.id } } as any),
          },
          {
            id: "delete",
            label: "Delete / Reverse Payment",
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
        <Text style={styles.headerTitle}>Payments</Text>
        <Pressable onPress={() => router.push("/payment-form")}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <View style={styles.summaryCard}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={styles.summaryIconBox}>
            <Ionicons name="arrow-up-circle-outline" size={18} color={theme.color.brandPrimary} />
          </View>
          <Text style={styles.summaryLabel}>Total Paid</Text>
        </View>
        <Text style={styles.summaryValue}>{currSym}{totalPaid.toFixed(2)}</Text>
      </View>
      <FlatList
        data={payments}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.color.brandPrimary} />}
        ListEmptyComponent={<Empty icon={<Ionicons name="cash-outline" size={40} color={theme.color.muted} />} title="No payments yet" hint="Tap + to record money paid." />}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item }) => (
          <GlowPressable onPress={() => setSelected(item)} onLongPress={() => remove(item)} haptic topHighlight={false} restingBorderColor={theme.color.border} style={styles.row}>
            <View style={[styles.badge, { backgroundColor: item.type === "supplier_payment" ? "#F0D8D8" : "#E8E8E8" }]}>
              <Ionicons name={item.type === "supplier_payment" ? "arrow-up-circle-outline" : "wallet-outline"} size={18} color={theme.color.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{getRecipientName(item)} · {TYPE_LABEL[item.type]}</Text>
              <Text style={styles.rowSub}>{shortDate(item.date)}{item.method ? ` · ${item.method}` : ""}</Text>
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
    summaryIconBox: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.color.brandPrimary + "18", alignItems: "center", justifyContent: "center" },
    summaryLabel: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    summaryValue: { fontSize: 18, fontWeight: "700", color: theme.color.error },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    badge: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center" },
    rowTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
    rowSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    rowAmount: { fontSize: 15, fontWeight: "700", color: theme.color.error }, // Errors for negative cashflow
  });
}
