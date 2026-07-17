import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Empty } from "@/src/components/UI";

export default function SuppliersScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.listSuppliers();
      setItems(s);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerRow}>
        <ScreenHeader title="Partners" subtitle={`${items.length} supplier${items.length === 1 ? "" : "s"}`} />
        <Pressable
          testID="btn-add-supplier"
          onPress={() => router.push("/supplier-form")}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={22} color="#fff" />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="people-outline" size={40} color={theme.color.muted} />}
              title="No suppliers yet"
              hint="Add your first supplier or partner to track balances."
            />
          }
          renderItem={({ item }) => {
            const initials = item.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
            const owing = (item.balance ?? 0) > 0;
            return (
              <Pressable
                testID={`supplier-${item.id}`}
                onPress={() => router.push(`/supplier/${item.id}`)}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials || "?"}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  <Text style={styles.sub}>{item.phone || "No phone"}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[styles.balance, { color: owing ? theme.color.error : theme.color.success }]}>
                    {fmt(item.balance ?? 0)}
                  </Text>
                  <Text style={styles.sub}>{owing ? "Owed" : "Settled"}</Text>
                </View>
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
    gap: theme.spacing.md,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: theme.color.brandTertiary, justifyContent: "center", alignItems: "center" },
  avatarText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 15 },
  name: { fontSize: 15, fontWeight: "600", color: theme.color.onSurface },
  sub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  balance: { fontSize: 15, fontWeight: "700" },
}); }
