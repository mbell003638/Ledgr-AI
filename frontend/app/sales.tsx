import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Alert, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { confirmAction } from "@/src/utils/alerts";
import { ActionSheetModal } from "@/src/components/ActionSheetModal";

export default function SalesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [sales, setSales] = useState<any[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [moreModalVisible, setMoreModalVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, settings] = await Promise.all([api.listSalesAndInvoices(), api.getSettings()]);
      setSales([...s].sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)));
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const total = sales.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);

  const documentFor = (sale: any) => ({
    title: "Sale",
    subtitle: shortDate(sale.date),
    rows: [["Amount", fmt(sale.amount, currSym)], ["Notes", sale.notes || "—"]] as Array<[string, unknown]>,
  });

  const reverseSale = (sale: any) => confirmAction(
    "Reverse / Delete Sale",
    "This creates the appropriate V2 reversal and removes the sale from active records.",
    async () => {
      try {
        await api.deleteSale(sale.id);
        setSelected(null);
        await load();
      } catch (e: any) {
        Alert.alert("Delete Failed", e?.message || "Could not delete sale.");
      }
    },
    "Reverse / Delete"
  );

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}><Pressable onPress={() => setSelected(null)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /><Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>Sales</Text></Pressable></View>
      <ScrollView contentContainerStyle={styles.list}>
        <TransactionDetail
          title={fmt(selected.amount, currSym)}
          subtitle={`Sale • ${shortDate(selected.date)}`}
          onEdit={() => {
            const id = selected.id;
            setSelected(null);
            router.push({ pathname: "/sale-form", params: { id } });
          }}
          onReversalDelete={() => reverseSale(selected)}
          onShare={() => shareTransaction({ ...documentFor(selected), amount: selected.amount }, theme.color)}
          onPrint={() => printTransaction({ ...documentFor(selected), amount: selected.amount }, theme.color)}
          onMore={() => setMoreModalVisible(true)}
        ><Text style={styles.cardSub}>{selected.notes || "No notes"}</Text></TransactionDetail>
      </ScrollView>
      <ActionSheetModal
        visible={moreModalVisible}
        onClose={() => setMoreModalVisible(false)}
        title={`Sale ${fmt(selected.amount, currSym)}`}
        subtitle={`Date: ${shortDate(selected.date)}${selected.customerName ? ` • ${selected.customerName}` : ""}`}
        actions={[
          {
            id: "share",
            label: "Share Document Summary",
            icon: "share-social-outline",
            onPress: () => shareTransaction({ ...documentFor(selected), amount: selected.amount }, theme.color),
          },
          {
            id: "print",
            label: "Print Document",
            icon: "print-outline",
            onPress: () => printTransaction({ ...documentFor(selected), amount: selected.amount }, theme.color),
          },
          {
            id: "edit",
            label: "Edit Sale",
            icon: "create-outline",
            onPress: () => router.push({ pathname: "/sale-form", params: { id: selected.id } }),
          },
          {
            id: "delete",
            label: "Delete / Reverse Sale",
            icon: "trash-outline",
            destructive: true,
            onPress: () => reverseSale(selected),
          },
        ]}
      />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader 
        title="Sales" 
        subtitle={`${sales.length} sale${sales.length === 1 ? "" : "s"} • ${fmt(total, currSym)} total`}
        rightAction={
          <Pressable
            testID="btn-add-sale"
            onPress={() => router.push("/sale-form")}
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
          data={sales}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="trending-up-outline" size={40} color={theme.color.muted} />}
              title="No sales recorded yet"
              hint="Tap the + button to log a daily sale."
            />
          }
          renderItem={({ item }) => {
            const isCredit = item.type === "invoice" || item.clientName || item.partyId || (item.notes && item.notes.toLowerCase().includes("credit sale"));
            const partyLabel = item.clientName || item.partyId || "";
            const defaultSub = isCredit
              ? `Credit Sale${partyLabel ? ` (${partyLabel})` : ""}`
              : "Cash Sale";
            const displaySub = item.notes && item.notes.trim() ? item.notes.trim() : defaultSub;

            return (
              <Pressable
                testID={`sale-${item.id}`}
                onPress={() => setSelected(item)}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{shortDate(item.date)}</Text>
                  <Text style={styles.cardSub}>{displaySub}</Text>
                </View>
                <Text style={styles.amount}>{fmt(item.amount, currSym)}</Text>
              </Pressable>
            );
          }}
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
  amount: { fontSize: 16, fontWeight: "700", color: theme.color.success },
}); }
