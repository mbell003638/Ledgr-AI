import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, Alert, ActivityIndicator } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { isCapabilityEnabled } from "@/src/utils/capabilities";

export default function LocationsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [settings, setSettings] = useState<any>({});
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"store" | "warehouse">("store");

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.getSettings(), api.listLocations()]);
      setSettings(s);
      setLocations(list);
    } catch (error: any) {
      Alert.alert("Could not load locations", error?.message || "Try again.");
    } finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const add = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const created = await api.createLocation({ name, code, kind });
      setLocations((current) => [...current, created].sort((a, b) => String(a.name).localeCompare(String(b.name))));
      setName(""); setCode("");
    } catch (error: any) { Alert.alert("Could not add location", error?.message || "Try again."); }
    finally { setSaving(false); }
  };

  if (!loading && !isCapabilityEnabled(settings, "multi_location")) {
    return <SafeAreaView style={styles.container}><View style={styles.center}><Ionicons name="storefront-outline" size={38} color={theme.color.brandPrimary} /><Text style={styles.title}>Multi-location retail is off</Text><Text style={styles.sub}>Enable this capability from Settings when you operate more than one store, warehouse, or POS point.</Text><Pressable onPress={() => router.replace("/customize-features")} style={styles.primary}><Text style={styles.primaryText}>Open capabilities</Text></Pressable></View></SafeAreaView>;
  }

  return <SafeAreaView style={styles.container} edges={["top"]}>
    <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={23} color={theme.color.onSurface} /></Pressable><View style={{ flex: 1 }}><Text style={styles.headerTitle}>Locations & POS</Text><Text style={styles.headerSub}>Keep each shop accountable while reporting together.</Text></View></View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.formCard}><Text style={styles.sectionTitle}>Add a location</Text><TextInput value={name} onChangeText={setName} placeholder="Store name" placeholderTextColor={theme.color.muted} style={styles.input} /><TextInput value={code} onChangeText={setCode} placeholder="Short code (optional)" placeholderTextColor={theme.color.muted} autoCapitalize="characters" style={styles.input} /><View style={styles.kindRow}>{(["store", "warehouse"] as const).map((value) => <Pressable key={value} onPress={() => setKind(value)} style={[styles.kindButton, kind === value && styles.kindSelected]}><Ionicons name={value === "store" ? "storefront-outline" : "cube-outline"} size={16} color={kind === value ? theme.color.brandPrimary : theme.color.muted} /><Text style={[styles.kindText, kind === value && { color: theme.color.brandPrimary }]}>{value === "store" ? "Store / POS" : "Warehouse"}</Text></Pressable>)}</View><Pressable onPress={add} disabled={saving || !name.trim()} style={[styles.primary, (saving || !name.trim()) && { opacity: 0.5 }]}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Add location</Text>}</Pressable></View>
      <Text style={styles.sectionTitle}>Your locations <Text style={styles.count}>{locations.length}</Text></Text>
      {locations.length === 0 ? <View style={styles.empty}><Ionicons name="map-outline" size={30} color={theme.color.muted} /><Text style={styles.emptyTitle}>No locations yet</Text><Text style={styles.sub}>Add your first store or warehouse to start assigning sales, POS sessions, and stock movement.</Text></View> : locations.map((location) => <View key={location.id} style={styles.locationCard}><View style={styles.locationIcon}><Ionicons name={location.kind === "warehouse" ? "cube-outline" : "storefront-outline"} size={22} color={theme.color.brandPrimary} /></View><View style={{ flex: 1 }}><Text style={styles.locationName}>{location.name}</Text><Text style={styles.locationSub}>{location.code || "No code"} · {location.kind === "warehouse" ? "Warehouse" : "Store / POS"}</Text></View><View style={[styles.status, { backgroundColor: location.active === false ? theme.color.border : theme.color.success + "22" }]}><Text style={{ color: location.active === false ? theme.color.muted : theme.color.success, fontSize: 10, fontWeight: "800" }}>{location.active === false ? "INACTIVE" : "ACTIVE"}</Text></View></View>)}
      <View style={styles.info}><Ionicons name="information-circle-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.infoText}>Sales and stock records can carry a location ID without creating separate accounting books. Consolidated reports remain available.</Text></View>
    </ScrollView>
  </SafeAreaView>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface }, center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 }, title: { color: theme.color.onSurface, fontSize: 20, fontWeight: "800", marginTop: 14, textAlign: "center" }, sub: { color: theme.color.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 7 }, header: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16, borderBottomWidth: 1, borderBottomColor: theme.color.border }, back: { padding: 4 }, headerTitle: { color: theme.color.onSurface, fontSize: 18, fontWeight: "800" }, headerSub: { color: theme.color.muted, fontSize: 11, marginTop: 2 }, content: { padding: 16, paddingBottom: 40 }, formCard: { padding: 15, borderRadius: 18, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, marginBottom: 22 }, sectionTitle: { color: theme.color.onSurface, fontSize: 15, fontWeight: "800", marginBottom: 10 }, count: { color: theme.color.brandPrimary }, input: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 13, padding: 12, color: theme.color.onSurface, backgroundColor: theme.color.surface, marginBottom: 9 }, kindRow: { flexDirection: "row", gap: 8, marginBottom: 12 }, kindButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 9, paddingHorizontal: 11, borderRadius: 14, borderWidth: 1, borderColor: theme.color.border }, kindSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12" }, kindText: { color: theme.color.muted, fontSize: 12, fontWeight: "700" }, primary: { backgroundColor: theme.color.brandPrimary, padding: 13, borderRadius: 13, alignItems: "center" }, primaryText: { color: "#fff", fontWeight: "800" }, empty: { alignItems: "center", padding: 30, borderWidth: 1, borderColor: theme.color.border, borderRadius: 18, borderStyle: "dashed" }, emptyTitle: { color: theme.color.onSurface, fontWeight: "800", marginTop: 8 }, locationCard: { flexDirection: "row", alignItems: "center", gap: 11, padding: 14, borderRadius: 16, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, marginBottom: 9 }, locationIcon: { width: 42, height: 42, borderRadius: 21, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.brandPrimary + "14" }, locationName: { color: theme.color.onSurface, fontWeight: "800", fontSize: 14 }, locationSub: { color: theme.color.muted, fontSize: 11, marginTop: 3 }, status: { paddingHorizontal: 7, paddingVertical: 5, borderRadius: 9 }, info: { flexDirection: "row", gap: 8, marginTop: 18, padding: 12, borderRadius: 14, backgroundColor: theme.color.brandPrimary + "0D" }, infoText: { flex: 1, color: theme.color.muted, fontSize: 11, lineHeight: 16 },
}); }
