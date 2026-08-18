import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { useScreenData } from "@/src/hooks/useScreenData";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { confirmAction } from "@/src/utils/alerts";
import { isCapabilityEnabled } from "@/src/utils/capabilities";
import { ActionSheetModal } from "@/src/components/ActionSheetModal";

import { GlowPressable } from "@/src/components/GlowPressable";

type BillsData = { bills: any[]; suppliers: Record<string, string> };

// Memoized row: only re-renders when its bill, supplier name, or the theme's
// styles change. Keeps scrolling smooth on low-end Android by avoiding a full
// list re-render when unrelated screen state (e.g. selection) updates.
const BillRow = React.memo(function BillRow({
  item, supName, styles, onPress,
}: {
  item: any; supName: string; styles: any; onPress: (item: any) => void;
}) {
  const isCash = item.paymentType === "cash";
  const typeLabel = isCash
    ? "Cash Purchase"
    : `Credit Purchase${supName ? ` (${supName})` : ""}`;
  const displaySub = item.notes && item.notes.trim()
    ? `${typeLabel} — ${item.notes.trim()}`
    : `${shortDate(item.date)} • ${typeLabel}${item.invoiceNo ? ` • #${item.invoiceNo}` : ""}`;
  return (
    <GlowPressable
      testID={`bill-${item.id}`}
      onPress={() => onPress(item)}
      haptic
      topHighlight={false}
      restingBorderColor={styles.card.borderColor}
      style={styles.card}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{supName || "Vendor Purchase"}</Text>
        <Text style={styles.cardSub}>{displaySub}</Text>
      </View>
      <Text style={styles.amount}>{fmt(item.amount, item.currency)}</Text>
    </GlowPressable>
  );
});

export default function BillsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [selected, setSelected] = useState<any | null>(null);
  const [moreModalVisible, setMoreModalVisible] = useState(false);
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => { api.getSettings().then(setSettings).catch(() => setSettings({})); }, []);

  const loader = useCallback(async (): Promise<BillsData> => {
    const [b, s] = await Promise.all([api.listBills(), api.listSuppliers()]);
    const map: Record<string, string> = {};
    s.forEach((x: any) => (map[x.id] = x.name));
    return { bills: b, suppliers: map };
  }, []);

  const { data, loading, refreshing, reload, refresh } = useScreenData<BillsData>(
    `bills:${api.activeBookId()}`,
    loader,
  );
  const bills = data?.bills ?? [];
  const suppliers = useMemo(() => data?.suppliers ?? {}, [data?.suppliers]);
  const load = reload;

  const procurementDisabled = Boolean(settings && !isCapabilityEnabled(settings, "procurement"));

  const onRowPress = useCallback((item: any) => setSelected(item), []);
  const renderItem = useCallback(
    ({ item }: { item: any }) => (
      <BillRow item={item} supName={suppliers[item.supplierId] || ""} styles={styles} onPress={onRowPress} />
    ),
    [suppliers, styles, onRowPress],
  );

  const documentFor = (bill: any) => ({ title: "Vendor Bill", subtitle: shortDate(bill.date), rows: [
    ["Supplier", suppliers[bill.supplierId] || "Unknown supplier"], ["Amount", fmt(bill.amount, bill.currency)],
    ["Payment", bill.paymentType], ["Invoice #", bill.invoiceNo || "—"], ["Notes", bill.notes || "—"],
  ] as [string, unknown][] });
  const reverseBill = (bill: any) => confirmAction(
    "Reverse / Delete Bill",
    "This creates the appropriate V2 reversal and removes the bill from active records.",
    async () => { await api.deleteBill(bill.id); setSelected(null); await load(); },
    "Reverse / Delete"
  );

  if (procurementDisabled) return <SafeAreaView style={styles.container}><View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing.lg }}><Text style={{ color: theme.color.onSurface, fontSize: 19, fontWeight: "800" }}>Purchases are off</Text><Text style={{ color: theme.color.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 }}>Enable Purchases and suppliers from workspace capabilities to view vendor bills.</Text><GlowPressable onPress={() => router.replace("/customize-features")} style={{ marginTop: 18, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 14, backgroundColor: theme.color.brandPrimary }}><Text style={{ color: "#fff", fontWeight: "800" }}>Open capabilities</Text></GlowPressable></View></SafeAreaView>;

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}><Pressable onPress={() => setSelected(null)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /><Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>Purchases</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.list}>
        <TransactionDetail
          title={suppliers[selected.supplierId] || "Vendor Bill"}
          subtitle={`${fmt(selected.amount, selected.currency)} • ${shortDate(selected.date)}`}
          onEdit={() => {
            const id = selected.id;
            setSelected(null);
            router.push({ pathname: "/bill-form", params: { id } });
          }}
          onReversalDelete={() => reverseBill(selected)}
          onShare={() => shareTransaction(documentFor(selected))}
          onPrint={() => printTransaction(documentFor(selected))}
          onMore={() => setMoreModalVisible(true)}
        ><Text style={styles.cardSub}>{selected.paymentType === "cash" ? "Cash" : "Credit"}{selected.invoiceNo ? ` • #${selected.invoiceNo}` : ""}</Text></TransactionDetail>
      </ScrollView>
      <ActionSheetModal
        visible={moreModalVisible}
        onClose={() => setMoreModalVisible(false)}
        title={suppliers[selected.supplierId] || "Vendor Bill"}
        subtitle={`${fmt(selected.amount, selected.currency)} • ${shortDate(selected.date)}`}
        actions={[
          {
            id: "share",
            label: "Share Bill Summary",
            icon: "share-social-outline",
            onPress: () => shareTransaction(documentFor(selected)),
          },
          {
            id: "print",
            label: "Print Bill",
            icon: "print-outline",
            onPress: () => printTransaction(documentFor(selected)),
          },
          {
            id: "edit",
            label: "Edit Purchase",
            icon: "create-outline",
            onPress: () => router.push({ pathname: "/bill-form", params: { id: selected.id } }),
          },
          {
            id: "delete",
            label: "Delete / Reverse Purchase",
            icon: "trash-outline",
            destructive: true,
            onPress: () => reverseBill(selected),
          },
        ]}
      />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader 
        title="Vendor Bills" 
        subtitle={`${bills.length} purchase${bills.length === 1 ? "" : "s"} logged`}
        rightAction={
          <Pressable
            testID="btn-add-bill"
            onPress={() => router.push("/bill-form")}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="add" size={22} color="#fff" />
          </Pressable>
        }
      />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={bills}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="receipt-outline" size={40} color={theme.color.muted} />}
              title="No bills recorded yet"
              hint="Tap the + button to log a vendor purchase."
            />
          }
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          renderItem={renderItem}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md },
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
