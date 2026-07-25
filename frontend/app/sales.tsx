import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Empty } from "@/src/components/UI";

export default function SalesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [sales, setSales] = useState<any[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, settings] = await Promise.all([api.listSales(), api.getSettings()]);
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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}>
        <ScreenHeader title="Sales" subtitle={`${sales.length} sale${sales.length === 1 ? "" : "s"} • ${fmt(total, currSym)} total`} />
        <Pressable
          testID="btn-add-sale"
          onPress={() => router.push("/sale-form")}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={22} color="#fff" />
        </Pressable>
      </View>

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
          renderItem={({ item }) => (
            <Pressable
              testID={`sale-${item.id}`}
              onPress={() => router.push({ pathname: "/sale-form", params: { id: item.id } })}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{shortDate(item.date)}</Text>
                {item.notes ? <Text style={styles.cardSub}>{item.notes}</Text> : null}
              </View>
              <Text style={styles.amount}>{fmt(item.amount, currSym)}</Text>
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
  amount: { fontSize: 16, fontWeight: "700", color: theme.color.success },
}); }
