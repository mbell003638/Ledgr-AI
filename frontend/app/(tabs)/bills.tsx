import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Empty } from "@/src/components/UI";

export default function BillsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [bills, setBills] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
            <View style={styles.card} testID={`bill-${item.id}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{suppliers[item.supplierId] || "Unknown supplier"}</Text>
                <Text style={styles.cardSub}>{shortDate(item.date)} • {item.paymentType === "cash" ? "Cash" : "Credit"}{item.invoiceNo ? ` • #${item.invoiceNo}` : ""}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.amount}>{fmt(item.amount, item.currency)}</Text>
                <Pressable
                  testID={`bill-delete-${item.id}`}
                  onPress={async () => { await api.deleteBill(item.id); load(); }}
                >
                  <Text style={styles.delete}>Delete</Text>
                </Pressable>
              </View>
            </View>
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
