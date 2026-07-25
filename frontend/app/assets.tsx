import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt } from "@/src/theme";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";

export default function AssetsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [assets, setAssets] = useState<{ name: string; amount: string }[]>([]);
  const [liabilities, setLiabilities] = useState<{ name: string; amount: string }[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setAssets(
        (Array.isArray(s.extraAssets) ? s.extraAssets : []).map((a: any) => ({
          name: a.name || "",
          amount: String(a.amount || ""),
        }))
      );
      setLiabilities(
        (Array.isArray(s.extraLiabilities) ? s.extraLiabilities : []).map((l: any) => ({
          name: l.name || "",
          amount: String(l.amount || ""),
        }))
      );
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings({
        extraAssets: assets
          .map((a) => ({ name: a.name.trim(), amount: a.amount.trim() ? parseFloat(a.amount) : 0 }))
          .filter((a) => a.name),
        extraLiabilities: liabilities
          .map((l) => ({ name: l.name.trim(), amount: l.amount.trim() ? parseFloat(l.amount) : 0 }))
          .filter((l) => l.name),
      });
    } catch (e: any) { console.warn(e); }
    finally { setSaving(false); }
  };

  const updateAsset = (i: number, field: "name" | "amount", val: string) =>
    setAssets((p) => p.map((a, idx) => (idx === i ? { ...a, [field]: val } : a)));
  const addAsset = () => setAssets((p) => [...p, { name: "", amount: "" }]);
  const removeAsset = (i: number) => setAssets((p) => p.filter((_, idx) => idx !== i));

  const updateLiability = (i: number, field: "name" | "amount", val: string) =>
    setLiabilities((p) => p.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));
  const addLiability = () => setLiabilities((p) => [...p, { name: "", amount: "" }]);
  const removeLiability = (i: number) => setLiabilities((p) => p.filter((_, idx) => idx !== i));

  const totalA = assets.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const totalL = liabilities.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Assets & Liabilities" subtitle="Custom items on the balance sheet" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      >
        <Card>
          <Text style={styles.cardTitle}>Custom Assets</Text>
          <Text style={styles.hint}>Extra assets included on the balance sheet (e.g. Van, Equipment, Property).</Text>
          {assets.map((a, i) => (
            <View key={i} style={styles.entryRow}>
              <TextInput
                value={a.name}
                onChangeText={(v) => updateAsset(i, "name", v)}
                placeholder="Asset name"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { flex: 2 }]}
              />
              <TextInput
                value={a.amount}
                onChangeText={(v) => updateAsset(i, "amount", v)}
                keyboardType="decimal-pad"
                placeholder="Value"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { flex: 1 }]}
              />
              <Pressable onPress={() => removeAsset(i)} style={styles.removeBtn}>
                <Ionicons name="trash-outline" size={18} color={theme.color.error} />
              </Pressable>
            </View>
          ))}
          <Pressable onPress={addAsset} style={styles.addBtn}>
            <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
            <Text style={styles.addText}>Add Asset</Text>
          </Pressable>
          {assets.length > 0 && (
            <Text style={styles.total}>Total Assets: {fmt(totalA, currSym)}</Text>
          )}
        </Card>

        <Card style={{ marginTop: theme.spacing.md }}>
          <Text style={styles.cardTitle}>Custom Liabilities</Text>
          <Text style={styles.hint}>Extra liabilities on the balance sheet (e.g. Loan, Rent due, Tax owed).</Text>
          {liabilities.map((l, i) => (
            <View key={i} style={styles.entryRow}>
              <TextInput
                value={l.name}
                onChangeText={(v) => updateLiability(i, "name", v)}
                placeholder="Liability name"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { flex: 2 }]}
              />
              <TextInput
                value={l.amount}
                onChangeText={(v) => updateLiability(i, "amount", v)}
                keyboardType="decimal-pad"
                placeholder="Amount"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { flex: 1 }]}
              />
              <Pressable onPress={() => removeLiability(i)} style={styles.removeBtn}>
                <Ionicons name="trash-outline" size={18} color={theme.color.error} />
              </Pressable>
            </View>
          ))}
          <Pressable onPress={addLiability} style={styles.addBtn}>
            <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
            <Text style={styles.addText}>Add Liability</Text>
          </Pressable>
          {liabilities.length > 0 && (
            <Text style={styles.total}>Total Liabilities: {fmt(totalL, currSym)}</Text>
          )}
        </Card>

        <Pressable onPress={save} disabled={saving} style={[styles.saveBtn, saving && { opacity: 0.5 }]}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
        </Pressable>

        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, paddingTop: theme.spacing.sm },
  cardTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.xs },
  hint: { fontSize: 12, color: theme.color.muted, marginBottom: theme.spacing.md },
  entryRow: { flexDirection: "row", gap: 8, marginBottom: theme.spacing.sm, alignItems: "center" },
  input: { borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface, backgroundColor: theme.color.surface },
  removeBtn: { padding: theme.spacing.sm },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: theme.spacing.sm },
  addText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
  total: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.md, textAlign: "right" },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
}); }