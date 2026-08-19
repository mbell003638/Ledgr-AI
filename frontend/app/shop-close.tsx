import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Card, ScreenHeader } from "@/src/components/UI";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { localTodayIso } from "@/src/utils/dateValidation";
import { isCapabilityEnabled } from "@/src/utils/capabilities";

type Shop = { id: string; name: string };
type Product = { id: string; name: string; qty: number };

export default function ShopCloseScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ locationId?: string }>();
  const [settings, setSettings] = useState<any>({});
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [locationId, setLocationId] = useState("");
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [date, setDate] = useState(localTodayIso());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextSettings, nextShops, nextSessions] = await Promise.all([api.getSettings(), api.listLocations(), api.listPosSessions()]);
      setSettings(nextSettings || {});
      const activeShops = (Array.isArray(nextShops) ? nextShops : []).filter((shop: any) => shop.active !== false).map((shop: any) => ({ id: String(shop.id), name: String(shop.name) }));
      setShops(activeShops); setSessions(Array.isArray(nextSessions) ? nextSessions : []);
      const chosen = String(params.locationId || locationId || nextSettings?.activeLocationId || (activeShops.length === 1 ? activeShops[0]?.id : "") || "");
      setLocationId(chosen);
      if (chosen) {
        const stock = await api.listProducts(chosen);
        setProducts((Array.isArray(stock) ? stock : []).map((product: any) => ({ id: String(product.id), name: String(product.name), qty: Number(product.qty || 0) })));
      } else setProducts([]);
    } finally { setLoading(false); }
  }, [locationId, params.locationId]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const chosenShop = shops.find((shop) => shop.id === locationId);
  const openSessions = sessions.filter((session) => session.locationId === locationId && session.status !== "closed");
  const allCounted = products.every((product) => String(counted[product.id] ?? "").trim() !== "");
  const selectShop = async (id: string) => { setLocationId(id); const current = await api.getSettings(); await api.updateSettings({ ...current, activeLocationId: id }); };
  const postStockCount = async () => {
    if (!locationId || !chosenShop) return Alert.alert("Choose a shop", "Select the shop you are closing first.");
    if (!products.length) return Alert.alert("No active products", "There are no products to count for this shop.");
    if (!allCounted) return Alert.alert("Complete the physical count", "Enter the counted quantity for every product before posting a shop closeout.");
    setSaving(true);
    try {
      let adjusted = 0;
      for (const product of products) {
        const actual = Number(String(counted[product.id]).replace(",", "."));
        if (!Number.isFinite(actual) || actual < 0) throw new Error(`Enter a valid counted quantity for ${product.name}.`);
        const delta = Math.round((actual - product.qty) * 1000) / 1000;
        if (Math.abs(delta) > 0.0005) { await api.adjustProductQty({ productId: product.id, qtyDelta: delta, date, locationId, notes: `Physical count — ${chosenShop.name} shop close` }); adjusted += 1; }
      }
      const current = await api.getSettings();
      await api.updateSettings({ ...current, shopCloseouts: { ...(current.shopCloseouts || {}), [locationId]: { locationId, date, countedProducts: products.length, adjustedProducts: adjusted, recordedAt: new Date().toISOString() } } });
      Alert.alert("Physical stock posted", `${products.length} product count${products.length === 1 ? "" : "s"} recorded for ${chosenShop.name}. ${adjusted ? `${adjusted} variance adjustment${adjusted === 1 ? "" : "s"} posted to this shop ledger.` : "No stock variance was found."}`);
      setCounted({}); await load();
    } catch (error: any) { Alert.alert("Stock count was not posted", error?.message || "Try again."); }
    finally { setSaving(false); }
  };
  const openPos = async () => { if (!locationId) return; await selectShop(locationId); router.push("/pos-sessions" as any); };
  const openShopReport = async () => { if (!locationId) return; await selectShop(locationId); router.push("/(tabs)/reports" as any); };

  if (loading) return <SafeAreaView style={styles.container} edges={["top"]}><ActivityIndicator style={{ marginTop: 44 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  if (!isCapabilityEnabled(settings, "multi_location")) return <SafeAreaView style={styles.container} edges={["top"]}><ScreenHeader title="Shop close" subtitle="Close cash and stock by location" /><View style={styles.center}><Ionicons name="storefront-outline" size={44} color={theme.color.brandPrimary} /><Text style={styles.centerTitle}>Multi-location is not enabled</Text><Text style={styles.centerText}>Enable Locations / Shops in Workspace capabilities before managing individual shop closeouts.</Text><Pressable onPress={() => router.push("/customize-features" as any)} style={styles.primary}><Text style={styles.primaryText}>Open workspace capabilities</Text></Pressable></View></SafeAreaView>;

  return <SafeAreaView style={styles.container} edges={["top"]}><ScreenHeader title="Shop close" subtitle="Cash settlement, physical stock, and this-shop reporting" /><ScrollView contentContainerStyle={styles.content}>
    <Card><Text style={styles.section}>Choose shop</Text><View style={styles.shopWrap}>{shops.map((shop) => <Pressable key={shop.id} onPress={() => selectShop(shop.id)} style={[styles.shop, locationId === shop.id && styles.shopActive]}><Text style={[styles.shopText, locationId === shop.id && styles.shopTextActive]}>{shop.name}</Text></Pressable>)}</View>{!shops.length ? <Text style={styles.hint}>Add a shop in Locations before starting a closeout.</Text> : null}</Card>
    {chosenShop ? <>
      <Card><View style={styles.cardHead}><View style={styles.icon}><Ionicons name="cash-outline" size={20} color={theme.color.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.title}>1. Settle cash drawers</Text><Text style={styles.hint}>{openSessions.length ? `${openSessions.length} open POS session${openSessions.length === 1 ? "" : "s"} must be counted and settled before this shop is closed.` : "No open POS sessions for this shop. Cash drawer closeout is complete."}</Text></View></View><Pressable onPress={openPos} style={styles.secondary}><Text style={styles.secondaryText}>{openSessions.length ? "Review POS sessions" : "View settled sessions"}</Text><Ionicons name="chevron-forward" size={18} color={theme.color.brandPrimary} /></Pressable></Card>
      <Card><View style={styles.cardHead}><View style={styles.icon}><Ionicons name="cube-outline" size={20} color={theme.color.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.title}>2. Count physical stock</Text><Text style={styles.hint}>Expected stock is location-scoped. Enter the quantity physically present at {chosenShop.name}; only variances create location-tagged adjustments.</Text></View></View><TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.date} accessibilityLabel="Shop close date" />{products.length ? products.map((product) => <View key={product.id} style={styles.product}><View style={{ flex: 1 }}><Text style={styles.productName}>{product.name}</Text><Text style={styles.productExpected}>Expected at {chosenShop.name}: {product.qty}</Text></View><TextInput value={counted[product.id] ?? ""} onChangeText={(value) => setCounted((current) => ({ ...current, [product.id]: value }))} keyboardType="decimal-pad" placeholder="Counted" placeholderTextColor={theme.color.muted} style={styles.countInput} accessibilityLabel={`Counted quantity for ${product.name}`} /></View>) : <Text style={styles.hint}>No live products are available for this shop. Add products or enable Live Product Stock before using a physical count.</Text>}<Pressable disabled={saving || !products.length || openSessions.length > 0} onPress={postStockCount} style={[styles.primary, (saving || !products.length || openSessions.length > 0) && styles.disabled]}><Text style={styles.primaryText}>{saving ? "Posting count…" : openSessions.length ? "Settle cash before stock close" : "Post physical stock count"}</Text></Pressable></Card>
      <Card><View style={styles.cardHead}><View style={styles.icon}><Ionicons name="document-text-outline" size={20} color={theme.color.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.title}>3. Review this shop ledger</Text><Text style={styles.hint}>Reports can be viewed by the selected shop or consolidated across All Shops. An individual shop closeout never silently closes the whole company period.</Text></View></View><Pressable onPress={openShopReport} style={styles.secondary}><Text style={styles.secondaryText}>Open {chosenShop.name} reports</Text><Ionicons name="chevron-forward" size={18} color={theme.color.brandPrimary} /></Pressable></Card>
    </> : null}
  </ScrollView></SafeAreaView>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface }, content: { padding: 16, paddingBottom: 52, gap: 12 }, center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }, centerTitle: { color: theme.color.onSurface, fontSize: 18, fontWeight: "800", marginTop: 12 }, centerText: { color: theme.color.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 6 }, section: { color: theme.color.onSurface, fontSize: 15, fontWeight: "800", marginBottom: 11 }, shopWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, shop: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 }, shopActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary }, shopText: { color: theme.color.onSurface, fontSize: 12, fontWeight: "700" }, shopTextActive: { color: "#fff" }, cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 }, icon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandPrimary + "15" }, title: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" }, hint: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 3 }, secondary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.color.border }, secondaryText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "800" }, date: { minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: theme.color.border, paddingHorizontal: 11, color: theme.color.onSurface, marginTop: 13 }, product: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.color.border }, productName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" }, productExpected: { color: theme.color.muted, fontSize: 10, marginTop: 3 }, countInput: { width: 90, minHeight: 40, borderRadius: 10, borderWidth: 1, borderColor: theme.color.border, color: theme.color.onSurface, paddingHorizontal: 9, fontSize: 13, textAlign: "right" }, primary: { minHeight: 46, marginTop: 13, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: theme.color.brandPrimary, paddingHorizontal: 14 }, primaryText: { color: "#fff", fontSize: 13, fontWeight: "800" }, disabled: { opacity: 0.45 },
}); }
