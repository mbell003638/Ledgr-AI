import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function SaleForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"USD" | "CDF">("USD");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(2500);
  const [date] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => { (async () => { const s = await api.getSettings(); setRate(s.fcRate || 2500); })(); }, []);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    setSaving(true); setError("");
    try {
      await api.createSale({ date, amount: amt, currency, rate, notes });
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-sale" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Log Daily Sale</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.label}>Amount ({date})</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput testID="input-sale-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} />
              <View style={styles.segRow}>
                {(["USD", "CDF"] as const).map((c) => (
                  <Pressable key={c} testID={`sale-currency-${c}`} onPress={() => setCurrency(c)} style={[styles.segBtn, currency === c && styles.segBtnActive]}>
                    <Text style={[styles.segText, currency === c && styles.segTextActive]}>{c}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-sale-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
          </Card>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="btn-save-sale" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Sale</Text>}
          </Pressable>
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
