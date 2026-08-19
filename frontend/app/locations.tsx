import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Card } from "@/src/components/UI";
import { FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { parseMoneyInput } from "@/src/money";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { isCapabilityEnabled } from "@/src/utils/capabilities";
import { getCurrencySymbol } from "@/src/utils/currency";
import { confirmAction } from "@/src/utils/alerts";
import { LocationPicker } from "@/src/components/LocationPicker";

type Shop = { id: string; name: string };
type Product = { id: string; name: string; qty: number };

export default function LocationsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeId, setActiveId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [currency, setCurrency] = useState("$");

  const [cashFrom, setCashFrom] = useState("");
  const [cashTo, setCashTo] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [cashDate, setCashDate] = useState(localTodayIso());
  const [stockFrom, setStockFrom] = useState("");
  const [stockTo, setStockTo] = useState("");
  const [stockProductId, setStockProductId] = useState("");
  const [stockQty, setStockQty] = useState("");
  const [stockDate, setStockDate] = useState(localTodayIso());
  const [stockEnabled, setStockEnabled] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const settings = await api.getSettings();
      const on = isCapabilityEnabled(settings, "multi_location");
      setEnabled(on);
      setCurrency(getCurrencySymbol(settings.currency));
      setStockEnabled(getEnabledFeatures(settings).includes("perpetualInventory"));
      if (!on) { setShops([]); setLoading(false); setRefreshing(false); return; }
      const rows = await api.listLocations();
      const next = (Array.isArray(rows) ? rows : []).map((row: any) => ({ id: String(row.id), name: String(row.name) }));
      setShops(next);
      const current = String(settings.activeLocationId || (next.length === 1 ? next[0]?.id : "") || "");
      setActiveId(current);
      if (getEnabledFeatures(settings).includes("perpetualInventory")) {
        const list = await api.listProducts(current || undefined);
        setProducts((Array.isArray(list) ? list : []).map((p: any) => ({ id: String(p.id), name: String(p.name), qty: Number(p.qty || 0) })));
      } else {
        setProducts([]);
      }
    } catch (e: any) {
      setError(e?.message || "Could not load locations.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const persistActive = async (id: string) => {
    setActiveId(id);
    const settings = await api.getSettings();
    await api.updateSettings({ ...settings, activeLocationId: id });
  };

  const addShop = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError("Enter a shop name."); return; }
    setSaving(true); setError("");
    try {
      const created = await api.createLocation({ name: trimmed });
      setName("");
      if (!activeId && created?.id) await persistActive(created.id);
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not add this location.");
    } finally { setSaving(false); }
  };

  const archive = (shop: Shop) => {
    confirmAction("Archive location?", `${shop.name} will be hidden. Past activity stays on the books.`, async () => {
      try {
        await api.archiveLocation(shop.id);
        if (activeId === shop.id) {
          const settings = await api.getSettings();
          await api.updateSettings({ ...settings, activeLocationId: "" });
        }
        await load();
      } catch (e: any) {
        setError(e?.message || "Could not archive this location.");
      }
    });
  };

  const moveCash = async () => {
    const dateIso = normalizeDateInput(cashDate);
    const amount = parseMoneyInput(cashAmount);
    if (!isValidDateString(dateIso)) { setError("Use YYYY-MM-DD for the cash transfer date."); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setError("Enter a cash amount to move."); return; }
    setSaving(true); setError("");
    try {
      await api.transferLocationCash({ date: dateIso, fromLocationId: cashFrom, toLocationId: cashTo, amount, method: "cash" });
      setCashAmount("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not transfer cash.");
    } finally { setSaving(false); }
  };

  const moveStock = async () => {
    const dateIso = normalizeDateInput(stockDate);
    const qty = Number(String(stockQty).replace(",", "."));
    if (!isValidDateString(dateIso)) { setError("Use YYYY-MM-DD for the stock transfer date."); return; }
    if (!Number.isFinite(qty) || qty <= 0) { setError("Enter a quantity to move."); return; }
    setSaving(true); setError("");
    try {
      await api.transferLocationStock({ date: dateIso, fromLocationId: stockFrom, toLocationId: stockTo, productId: stockProductId, qty });
      setStockQty("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not transfer stock.");
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Locations" subtitle="Each shop has its own cash and stock" />
      {loading ? <ActivityIndicator style={{ marginTop: 24 }} color={theme.color.brandPrimary} /> : (
        <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} /> } contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 48 }}>
          {!enabled ? (
            <Card>
              <Text style={styles.guide}>Locations is optional. Turn it on in Customize Features so Shop A cash and stock stay separate from Shop B.</Text>
              <Pressable onPress={() => router.push("/customize-features")} style={styles.link}><Text style={styles.linkText}>Customize Features</Text></Pressable>
            </Card>
          ) : (
            <>
              <Card>
                <Text style={styles.section}>Shops</Text>
                <FormField label="New shop" value={name} onChangeText={setName} placeholder="Shop A" />
                <FormActions primaryLabel={saving ? "Saving…" : "Add shop"} onPrimary={addShop} primaryBusy={saving} primaryDisabled={saving} />
                {shops.map((shop) => (
                  <View key={shop.id} style={styles.shopRow}>
                    <Pressable onPress={() => persistActive(shop.id)} style={{ flex: 1 }}>
                      <Text style={styles.shopName}>{shop.name}{shop.id === activeId ? "  · current" : ""}</Text>
                    </Pressable>
                    <Pressable onPress={() => archive(shop)}><Ionicons name="trash-outline" size={18} color={theme.color.muted} /></Pressable>
                  </View>
                ))}
                            </Card>
              <Card>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><View style={{ flex: 1 }}><Text style={styles.section}>POS sessions</Text><Text style={styles.guide}>Open and close each cash drawer by store and register.</Text></View><Pressable onPress={() => router.push("/pos-sessions")} style={styles.link}><Text style={styles.linkText}>Open POS</Text></Pressable></View>
              </Card>
              <Card>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><View style={{ flex: 1 }}><Text style={styles.section}>Shop closeout</Text><Text style={styles.guide}>Settle each shop&apos;s cash drawers, enter physical stock counts, post location-tagged variances, then review that shop&apos;s report.</Text></View><Pressable onPress={() => router.push("/shop-close")} style={styles.link}><Text style={styles.linkText}>Close shop</Text></Pressable></View>
              </Card>
              <Card>
                <Text style={styles.section}>Move cash</Text>
                <LocationPicker label="From" value={cashFrom} onChange={setCashFrom} />
                <LocationPicker label="To" value={cashTo} onChange={setCashTo} />
                <FormField label={`Amount (${currency})`} value={cashAmount} onChangeText={setCashAmount} keyboardType="decimal-pad" />
                <FormField label="Date" value={cashDate} onChangeText={setCashDate} />
                <FormActions primaryLabel="Transfer cash" onPrimary={moveCash} primaryBusy={saving} primaryDisabled={saving} />
              </Card>

              {stockEnabled ? (
                <Card>
                  <Text style={styles.section}>Move stock</Text>
                  <LocationPicker label="From" value={stockFrom} onChange={setStockFrom} />
                  <LocationPicker label="To" value={stockTo} onChange={setStockTo} />
                  <Text style={styles.hint}>Product</Text>
                  <View style={styles.wrap}>
                    {products.map((p) => (
                      <Pressable key={p.id} onPress={() => setStockProductId(p.id)} style={[styles.chip, stockProductId === p.id && styles.chipOn]}>
                        <Text style={styles.chipText}>{p.name}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <FormField label="Quantity" value={stockQty} onChangeText={setStockQty} keyboardType="decimal-pad" />
                  <FormField label="Date" value={stockDate} onChangeText={setStockDate} />
                  <FormActions primaryLabel="Transfer stock" onPrimary={moveStock} primaryBusy={saving} primaryDisabled={saving} />
                </Card>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    guide: { color: theme.color.muted, lineHeight: 20 },
    link: { marginTop: 12 },
    linkText: { color: theme.color.brandPrimary, fontWeight: "700" },
    section: { fontWeight: "700", fontSize: 16, color: theme.color.onSurface, marginBottom: 12 },
    shopRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border },
    shopName: { color: theme.color.onSurface, fontWeight: "600" },
    hint: { color: theme.color.muted, fontSize: 13, fontWeight: "600", marginBottom: 8 },
    wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
    chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.color.border },
    chipOn: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    chipText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 13 },
    error: { color: theme.color.error, marginTop: 12 },
  });
}
