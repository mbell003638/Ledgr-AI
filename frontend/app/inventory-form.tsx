import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function InventoryForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [expected, setExpected] = useState(0);
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<any>(null);
  const [date] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      try {
        const r = await api.expectedInventory();
        setExpected(r.expected);
        setInfo(r);
      } catch (e) { console.warn(e); }
      finally { setLoading(false); }
    })();
  }, []);

  const save = async () => {
    const act = parseFloat(actual);
    if (isNaN(act) || act < 0) { setError("Enter a valid stock value"); return; }
    setSaving(true); setError("");
    try {
      await api.createInventory({ date, expectedStock: expected, actualStock: act, notes });
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const variance = actual ? parseFloat(actual) - expected : 0;
  const varColor = variance === 0 ? theme.color.muted : variance > 0 ? theme.color.success : theme.color.error;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-inv" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Inventory Audit</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          {loading ? <ActivityIndicator color={theme.color.brandPrimary} /> : (
            <>
              <Card>
                <Text style={styles.label}>Expected Stock (USD value)</Text>
                <Text style={styles.expected} testID="inv-expected">{fmt(expected)}</Text>
                {info?.lastAudit ? (
                  <Text style={styles.hint}>Last audit: {info.lastAudit.date} at {fmt(info.lastAudit.actualStock)}. Purchases since: {fmt(info.purchasesSince)}. Sales since: {fmt(info.salesSince)}.</Text>
                ) : (
                  <Text style={styles.hint}>First audit. Purchases: {fmt(info?.purchasesSince)} • Sales: {fmt(info?.salesSince)}</Text>
                )}

                <Text style={[styles.label, { marginTop: 16 }]}>Actual Stock (physical count value, USD)</Text>
                <TextInput
                  testID="input-actual-stock"
                  value={actual}
                  onChangeText={setActual}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={theme.color.muted}
                  style={styles.input}
                />

                {actual !== "" && (
                  <View style={[styles.varBox, { backgroundColor: variance === 0 ? theme.color.surfaceTertiary : variance > 0 ? "#E7F1EA" : "#FBE8E5" }]}>
                    <Text style={styles.varLabel}>Variance</Text>
                    <Text style={[styles.varValue, { color: varColor }]} testID="inv-variance">
                      {variance > 0 ? "+" : ""}{fmt(variance)}
                    </Text>
                    <Text style={styles.varHint}>
                      {variance === 0 ? "Perfectly matched" : variance > 0 ? "Overage / gain" : "Shortage detected"}
                    </Text>
                  </View>
                )}

                <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
                <TextInput testID="input-inv-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
              </Card>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable testID="btn-save-inv" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Audit</Text>}
              </Pressable>
            </>
          )}
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
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
  expected: { fontSize: 28, fontWeight: "700", color: theme.color.brandPrimary, marginTop: 4 },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  varBox: { marginTop: 16, padding: theme.spacing.md, borderRadius: theme.radius.md },
  varLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  varValue: { fontSize: 22, fontWeight: "700", marginTop: 4 },
  varHint: { fontSize: 12, color: theme.color.muted, marginTop: 4 },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
