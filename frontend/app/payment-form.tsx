import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

type PayType = "supplier_payment" | "drawing" | "commission_payment";

export default function PaymentForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id;
  const [type, setType] = useState<PayType>("supplier_payment");
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [partnerOptions, setPartnerOptions] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const currency = "USD";
  const [method, setMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      const s = await api.listSuppliers();
      setSuppliers(s);
      if (s.length && !supplierId && !editId) setSupplierId(s[0].id);
      const st = await api.getSettings();
      setPartnerOptions(Array.isArray(st.partnerNames) ? st.partnerNames : []);
      if (editId) {
        const list = await api.listPayments();
        const it = list.find((x: any) => x.id === editId);
        if (it) {
          setType(it.type); setSupplierId(it.supplierId || "");
          setPartnerName(it.partnerName || "");
          setAmount(String(it.amount)); 
          setMethod(it.method || "cash"); setNotes(it.notes || ""); setDate(it.date);
        }
      }
    })();
  }, []);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    if (type === "supplier_payment" && !supplierId) { setError("Select a supplier"); return; }
    if (type === "drawing" && !partnerName.trim()) { setError("Enter partner name"); return; }
    setSaving(true); setError("");
    try {
      const payload = {
        date, amount: amt, currency, type,
        supplierId: type === "supplier_payment" ? supplierId : "",
        partnerName: type === "drawing" ? partnerName.trim() : "",
        method, notes,
      };
      if (editId) await api.updatePayment(editId, payload);
      else await api.createPayment(payload);
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editId) return;
    setDeleting(true);
    try { await api.deletePayment(editId); router.back(); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-payment" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>{editId ? "Edit Payment" : "New Payment"}</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.label}>Payment Type</Text>
            <View style={styles.segRowFull}>
              {([["supplier_payment", "Supplier"], ["drawing", "Drawing"], ["commission_payment", "Commission"]] as const).map(([v, lbl]) => (
                <Pressable key={v} testID={`ptype-${v}`} onPress={() => setType(v)} style={[styles.segBtnFull, type === v && styles.segBtnActive]}>
                  <Text style={[styles.segText, type === v && styles.segTextActive]}>{lbl}</Text>
                </Pressable>
              ))}
            </View>

            {type === "supplier_payment" ? (
              <>
                <Text style={[styles.label, { marginTop: 12 }]}>Supplier</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
                  {suppliers.map((s) => (
                    <Pressable key={s.id} testID={`p-supplier-${s.id}`} onPress={() => setSupplierId(s.id)} style={[styles.chip, supplierId === s.id && styles.chipActive]}>
                      <Text style={[styles.chipText, supplierId === s.id && styles.chipTextActive]}>{s.name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            ) : (
              <>
                <Text style={[styles.label, { marginTop: 12 }]}>Partner Name</Text>
                {partnerOptions.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
                    {partnerOptions.map((p) => (
                      <Pressable key={p} testID={`partner-chip-${p}`} onPress={() => setPartnerName(p)} style={[styles.chip, partnerName === p && styles.chipActive]}>
                        <Text style={[styles.chipText, partnerName === p && styles.chipTextActive]}>{p}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
                <TextInput testID="input-partner-name" value={partnerName} onChangeText={setPartnerName} placeholder="e.g. Amit" placeholderTextColor={theme.color.muted} style={styles.input} />
              </>
            )}

            <Text style={[styles.label, { marginTop: 12 }]}>Date (YYYY-MM-DD)</Text>
            <TextInput value={date} onChangeText={setDate} placeholder="2024-01-01" placeholderTextColor={theme.color.muted} style={styles.input} />
            <Text style={[styles.label, { marginTop: 12 }]}>Amount</Text>
            <TextInput testID="input-payment-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input]} />

            <Text style={[styles.label, { marginTop: 12 }]}>Method</Text>
            <TextInput testID="input-method" value={method} onChangeText={setMethod} placeholder="cash / bank / mobile" placeholderTextColor={theme.color.muted} style={styles.input} />

            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-payment-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
          </Card>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="btn-save-payment" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update Payment" : "Save Payment"}</Text>}
          </Pressable>
          {editId ? (
            <Pressable testID="btn-delete-payment" onPress={remove} disabled={deleting} style={({ pressed }) => [{ padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm }, (pressed || deleting) && { opacity: 0.85 }]}>
              {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 14 }}>Delete Payment</Text>}
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
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border, flexShrink: 0 },
  chipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  chipText: { color: theme.color.onSurface, fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: "#fff" },
  segRow: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 2 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: theme.radius.sm },
  segRowFull: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 2, marginTop: 6 },
  segBtnFull: { flex: 1, paddingVertical: 12, borderRadius: theme.radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 13 },
  segTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
