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
  const today = new Date().toISOString().slice(0, 10);
  const [assets, setAssets] = useState<{ id?: string; date: string; name: string; category: string; amount: string }[]>([]);
  const [liabilities, setLiabilities] = useState<{ id?: string; date: string; name: string; category: string; amount: string }[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, v2Assets, v2Liab] = await Promise.all([
        api.getSettings(),
        api.listAssetTransactions(),
        api.listLiabilityTransactions(),
      ]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      if (Array.isArray(v2Assets) && v2Assets.length > 0) {
        setAssets(v2Assets.map((a: any) => ({ id: a.id, date: a.date, name: a.name, category: a.category, amount: String(a.amount || "") })));
      } else {
        setAssets((Array.isArray(s.extraAssets) ? s.extraAssets : []).map((a: any) => ({ date: a.date || today, name: a.name || "", category: a.category || "Equipment", amount: String(a.amount || "") })));
      }
      if (Array.isArray(v2Liab) && v2Liab.length > 0) {
        setLiabilities(v2Liab.map((l: any) => ({ id: l.id, date: l.date, name: l.name, category: l.category, amount: String(l.amount || "") })));
      } else {
        setLiabilities((Array.isArray(s.extraLiabilities) ? s.extraLiabilities : []).map((l: any) => ({ date: l.date || today, name: l.name || "", category: l.category || "Loan", amount: String(l.amount || "") })));
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async () => {
    setSaving(true);
    try {
      for (const a of assets) {
        if (a.name.trim() && a.amount.trim() && !a.id) {
          await api.createAssetTransaction({ date: a.date || today, name: a.name.trim(), category: a.category.trim(), amount: parseFloat(a.amount) || 0 });
        }
      }
      for (const l of liabilities) {
        if (l.name.trim() && l.amount.trim() && !l.id) {
          await api.createLiabilityTransaction({ date: l.date || today, name: l.name.trim(), category: l.category.trim(), amount: parseFloat(l.amount) || 0 });
        }
      }
      await api.updateSettings({
        extraAssets: assets.map((a) => ({ date: a.date || today, name: a.name.trim(), category: a.category.trim(), amount: parseFloat(a.amount) || 0 })).filter((a) => a.name),
        extraLiabilities: liabilities.map((l) => ({ date: l.date || today, name: l.name.trim(), category: l.category.trim(), amount: parseFloat(l.amount) || 0 })).filter((l) => l.name),
      });
      load();
    } catch (e: any) { console.warn(e); }
    finally { setSaving(false); }
  };

  const updateAsset = (i: number, field: "date" | "name" | "category" | "amount", val: string) =>
    setAssets((p) => p.map((a, idx) => (idx === i ? { ...a, [field]: val } : a)));
  const addAsset = () => setAssets((p) => [...p, { date: today, name: "", category: "Equipment", amount: "" }]);
  const removeAsset = async (i: number) => {
    const item = assets[i];
    if (item?.id) {
      try { await api.deleteAssetTransaction(item.id); } catch (e) { console.warn(e); }
    }
    setAssets((p) => p.filter((_, idx) => idx !== i));
  };

  const updateLiability = (i: number, field: "date" | "name" | "category" | "amount", val: string) =>
    setLiabilities((p) => p.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));
  const addLiability = () => setLiabilities((p) => [...p, { date: today, name: "", category: "Loan", amount: "" }]);
  const removeLiability = async (i: number) => {
    const item = liabilities[i];
    if (item?.id) {
      try { await api.deleteLiabilityTransaction(item.id); } catch (e) { console.warn(e); }
    }
    setLiabilities((p) => p.filter((_, idx) => idx !== i));
  };

  const totalA = assets.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  const totalL = liabilities.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Assets & Liabilities Register" subtitle="Multi-entry register on the balance sheet" />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
      >
        <Card>
          <Text style={styles.cardTitle}>Custom Assets Register</Text>
          <Text style={styles.hint}>Record individual equipment, vehicles, property, or investments with acquisition dates.</Text>
          {assets.map((a, i) => (
            <View key={i} style={{ marginBottom: theme.spacing.md, paddingBottom: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border }}>
              <View style={styles.entryRow}>
                <TextInput
                  value={a.date}
                  onChangeText={(v) => updateAsset(i, "date", v)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 1 }]}
                />
                <TextInput
                  value={a.name}
                  onChangeText={(v) => updateAsset(i, "name", v)}
                  placeholder="Asset Description"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 2 }]}
                />
              </View>
              <View style={styles.entryRow}>
                <TextInput
                  value={a.category}
                  onChangeText={(v) => updateAsset(i, "category", v)}
                  placeholder="Category (e.g. Vehicle)"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 1.5 }]}
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
            </View>
          ))}
          <Pressable onPress={addAsset} style={styles.addBtn}>
            <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
            <Text style={styles.addText}>Add Asset Entry</Text>
          </Pressable>
          {assets.length > 0 && (
            <Text style={styles.total}>Total Assets: {fmt(totalA, currSym)}</Text>
          )}
        </Card>

        <Card style={{ marginTop: theme.spacing.md }}>
          <Text style={styles.cardTitle}>Custom Liabilities Register</Text>
          <Text style={styles.hint}>Record loans, credit cards, taxes, or payables with dates and categories.</Text>
          {liabilities.map((l, i) => (
            <View key={i} style={{ marginBottom: theme.spacing.md, paddingBottom: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border }}>
              <View style={styles.entryRow}>
                <TextInput
                  value={l.date}
                  onChangeText={(v) => updateLiability(i, "date", v)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 1 }]}
                />
                <TextInput
                  value={l.name}
                  onChangeText={(v) => updateLiability(i, "name", v)}
                  placeholder="Liability Description"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 2 }]}
                />
              </View>
              <View style={styles.entryRow}>
                <TextInput
                  value={l.category}
                  onChangeText={(v) => updateLiability(i, "category", v)}
                  placeholder="Category (e.g. Loan)"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { flex: 1.5 }]}
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
            </View>
          ))}
          <Pressable onPress={addLiability} style={styles.addBtn}>
            <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
            <Text style={styles.addText}>Add Liability Entry</Text>
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