import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function SaleForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id;
  const [amount, setAmount] = useState("");
  const currency = "USD";
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      const s = await api.getSettings();
      if (editId) {
        const list = await api.listSales();
        const it = list.find((x: any) => x.id === editId);
        if (it) { setAmount(String(it.amount)); setNotes(it.notes || ""); setDate(it.date); }
      }
    })();
  }, []);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    setSaving(true); setError("");
    try {
      const payload = { date, amount: amt, currency, notes };
      if (editId) await api.updateSale(editId, payload);
      else await api.createSale(payload);
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editId) return;
    setDeleting(true);
    try { await api.deleteSale(editId); router.back(); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-sale" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>{editId ? "Edit Sale" : "Log Daily Sale"}</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.label}>Amount ({date})</Text>
            <TextInput testID="input-sale-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input]} />
            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-sale-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
          </Card>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="btn-save-sale" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update Sale" : "Save Sale"}</Text>}
          </Pressable>
          {editId ? (
            <Pressable testID="btn-delete-sale" onPress={remove} disabled={deleting} style={({ pressed }) => [{ padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm }, (pressed || deleting) && { opacity: 0.85 }]}>
              {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 14 }}>Delete Sale</Text>}
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  segRow: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 2, marginTop: 6 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: theme.radius.sm },
  segBtnActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 13 },
  segTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
