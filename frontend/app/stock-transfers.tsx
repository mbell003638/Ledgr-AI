import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, Alert, ActivityIndicator } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { isCapabilityEnabled } from "@/src/utils/capabilities";

export default function StockTransfersScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [settings, setSettings] = useState<any>({});
  const [locations, setLocations] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, l, t] = await Promise.all([api.getSettings(), api.listLocations(), api.listStockTransfers()]);
      const activeLocations = (Array.isArray(l) ? l : []).filter((item: any) => item.archived !== true && item.active !== false);
      setSettings(s);
      setLocations(activeLocations);
      setTransfers(Array.isArray(t) ? t : []);
      const nextFrom = fromId && activeLocations.some((item) => item.id === fromId) ? fromId : String(activeLocations[0]?.id || "");
      const nextTo = toId && activeLocations.some((item) => item.id === toId) ? toId : String(activeLocations[1]?.id || "");
      setFromId(nextFrom);
      setToId(nextTo);
      if (getEnabledFeatures(s).includes("perpetualInventory")) {
        const rows = await api.listProducts(nextFrom || undefined);
        setProducts(Array.isArray(rows) ? rows : []);
      } else {
        setProducts([]);
      }
    } catch (error: any) {
      Alert.alert("Could not load transfers", error?.message || "Try again.");
    } finally {
      setLoading(false);
    }
  }, [fromId, toId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const create = async () => {
    const qty = Number(String(quantity).replace(",", "."));
    if (!fromId || !toId || fromId === toId) {
      Alert.alert("Choose two locations", "The source and destination must be different.");
      return;
    }
    if (!productId || !Number.isFinite(qty) || qty <= 0) {
      Alert.alert("Check transfer details", "Choose a product and enter a positive quantity.");
      return;
    }
    setSaving(true);
    try {
      await api.transferLocationStock({
        fromLocationId: fromId,
        toLocationId: toId,
        productId,
        qty,
        date: new Date().toISOString().slice(0, 10),
      });
      setQuantity("");
      await load();
    } catch (error: any) {
      Alert.alert("Could not transfer stock", error?.message || "Check available stock and try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  if (!isCapabilityEnabled(settings, "multi_location")) {
    return <SafeAreaView style={styles.container}><View style={styles.center}>
      <Ionicons name="swap-horizontal-outline" size={40} color={theme.color.brandPrimary} />
      <Text style={styles.title}>Stock transfers are off</Text>
      <Text style={styles.sub}>Enable Multi-location retail from Settings to move stock between locations.</Text>
      <Pressable onPress={() => router.replace("/customize-features")} style={styles.primary}><Text style={styles.primaryText}>Open capabilities</Text></Pressable>
    </View></SafeAreaView>;
  }

  if (!getEnabledFeatures(settings).includes("perpetualInventory")) {
    return <SafeAreaView style={styles.container}><View style={styles.center}>
      <Ionicons name="cube-outline" size={40} color={theme.color.brandPrimary} />
      <Text style={styles.title}>Live Product Stock is off</Text>
      <Text style={styles.sub}>Turn on Live Product Stock before moving units between shops. This keeps each transfer connected to inventory and COGS.</Text>
      <Pressable onPress={() => router.replace("/customize-features")} style={styles.primary}><Text style={styles.primaryText}>Open capabilities</Text></Pressable>
    </View></SafeAreaView>;
  }

  return <SafeAreaView style={styles.container} edges={["top"]}>
    <View style={styles.header}>
      <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={23} color={theme.color.onSurface} /></Pressable>
      <View style={{ flex: 1 }}><Text style={styles.headerTitle}>Stock transfers</Text><Text style={styles.headerSub}>Posted transfers update each shop’s stock ledger.</Text></View>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.formCard}>
        <Text style={styles.sectionTitle}>Move stock</Text>
        <Text style={styles.label}>Product</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 12 }}>
          {products.map((product: any) => <Pressable key={product.id} onPress={() => setProductId(String(product.id))} style={[styles.chip, productId === product.id && styles.selected]}>
            <Text style={[styles.chipText, productId === product.id && { color: theme.color.brandPrimary }]}>{product.name} · {Number(product.qty || 0)}</Text>
          </Pressable>)}
        </ScrollView>
        <Text style={styles.label}>From</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 10 }}>
          {locations.map((location: any) => <Pressable key={location.id} onPress={() => setFromId(location.id)} style={[styles.chip, fromId === location.id && styles.selected]}><Text style={[styles.chipText, fromId === location.id && { color: theme.color.brandPrimary }]}>{location.name}</Text></Pressable>)}
        </ScrollView>
        <Text style={styles.label}>To</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 12 }}>
          {locations.map((location: any) => <Pressable key={location.id} onPress={() => setToId(location.id)} style={[styles.chip, toId === location.id && styles.selected]}><Text style={[styles.chipText, toId === location.id && { color: theme.color.brandPrimary }]}>{location.name}</Text></Pressable>)}
        </ScrollView>
        <View style={styles.quantityRow}><Text style={styles.label}>Quantity</Text><Pressable onPress={() => setQuantity((current) => String(Math.max(1, Number(current || 0) - 1)))} style={styles.stepper}><Text style={styles.stepperText}>−</Text></Pressable><Text style={styles.quantity}>{quantity || "0"}</Text><Pressable onPress={() => setQuantity((current) => String(Number(current || 0) + 1))} style={styles.stepper}><Text style={styles.stepperText}>+</Text></Pressable></View>
        <Pressable onPress={create} disabled={saving || !productId || !fromId || !toId} style={[styles.primary, (saving || !productId || !fromId || !toId) && { opacity: 0.5 }]}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Post transfer</Text>}</Pressable>
      </View>
      <Text style={styles.sectionTitle}>Posted transfers</Text>
      {transfers.length === 0 ? <View style={styles.empty}><Ionicons name="cube-outline" size={28} color={theme.color.muted} /><Text style={styles.emptyTitle}>No transfers yet</Text><Text style={styles.sub}>A posted transfer creates paired stock moves between the selected locations.</Text></View> : transfers.map((transfer: any) => {
        const from = locations.find((item) => item.id === transfer.fromLocationId)?.name || transfer.fromLocationId || "Unknown";
        const to = locations.find((item) => item.id === transfer.toLocationId)?.name || transfer.toLocationId || "Unknown";
        const product = products.find((item) => item.id === transfer.productId);
        return <View key={transfer.id} style={styles.transferCard}><View style={styles.transferIcon}><Ionicons name="swap-horizontal-outline" size={21} color={theme.color.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.transferTitle}>{product?.name || transfer.productId} · {Number(transfer.qty ?? transfer.quantity ?? 0)}</Text><Text style={styles.transferSub}>{from} → {to} · {transfer.status || "posted"}</Text></View><Text style={styles.date}>{transfer.date || ""}</Text></View>;
      })}
    </ScrollView>
  </SafeAreaView>;
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
    title: { color: theme.color.onSurface, fontSize: 20, fontWeight: "800", marginTop: 14, textAlign: "center" },
    sub: { color: theme.color.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7 },
    header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: theme.color.border },
    back: { padding: 4 },
    headerTitle: { color: theme.color.onSurface, fontSize: 18, fontWeight: "800" },
    headerSub: { color: theme.color.muted, fontSize: 11, marginTop: 2 },
    content: { padding: 16, paddingBottom: 40 },
    formCard: { padding: 15, borderRadius: 18, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, marginBottom: 22 },
    sectionTitle: { color: theme.color.onSurface, fontSize: 15, fontWeight: "800", marginBottom: 10 },
    label: { color: theme.color.muted, fontSize: 11, fontWeight: "800", marginBottom: 6 },
    chip: { paddingVertical: 9, paddingHorizontal: 11, borderRadius: 14, borderWidth: 1, borderColor: theme.color.border },
    selected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12" },
    chipText: { color: theme.color.muted, fontSize: 12, fontWeight: "700" },
    quantityRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
    quantity: { minWidth: 44, textAlign: "center", color: theme.color.onSurface, fontSize: 18, fontWeight: "800" },
    stepper: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.color.border },
    stepperText: { color: theme.color.onSurface, fontSize: 20, lineHeight: 22 },
    primary: { backgroundColor: theme.color.brandPrimary, padding: 13, borderRadius: 13, alignItems: "center" },
    primaryText: { color: "#fff", fontWeight: "800" },
    empty: { alignItems: "center", padding: 28, borderWidth: 1, borderColor: theme.color.border, borderRadius: 18, borderStyle: "dashed" },
    emptyTitle: { color: theme.color.onSurface, fontWeight: "800", marginTop: 8 },
    transferCard: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 16, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, marginBottom: 9 },
    transferIcon: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.brandPrimary + "14" },
    transferTitle: { color: theme.color.onSurface, fontWeight: "800", fontSize: 13 },
    transferSub: { color: theme.color.muted, fontSize: 11, marginTop: 3 },
    date: { color: theme.color.muted, fontSize: 10 },
  });
}
