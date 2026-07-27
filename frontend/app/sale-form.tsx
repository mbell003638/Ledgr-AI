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

  // Cash vs Credit(party) sale. A credit sale is owed by a customer, so it
  // becomes an invoice + a debtor entry instead of straight cash.
  const [saleType, setSaleType] = useState<"cash" | "party">("cash");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [existing, setExisting] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    (async () => {
  const isV2 = await api.v2BookVersion(api.activeBookId()).catch(() => null);
      if (isV2 === 2) {
        const list = await api.listSales();
        const it = list.find((x: any) => x.id === editId);
        if (it) { setAmount(String(it.amount)); setNotes(it.notes || ""); setDate(it.date); }
      }
      // Load existing customers (debtors) for quick pick.
      try {
        const d = await api.listDebtors();
        setExisting((d || []).map((x: any) => ({ id: x.id, name: x.name })));
      } catch { /* optional */ }
    })();
  }, []);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    if (saleType === "party" && !customerName.trim()) {
      setError("Enter the customer / party name for a credit sale");
      return;
    }
    setSaving(true); setError("");
    try {
      if (editId) {
        // Editing only supports the original cash-sale record.
        await api.updateSale(editId, { date, amount: amt, currency, notes });
      } else if (saleType === "cash") {
        await api.createSale({ date, amount: amt, currency, notes });
      } else {
        // Credit sale to a party → create an invoice. createInvoice auto-creates
        // the debtor and links the invoice to their ledger.
        await api.createInvoice({
          clientName: customerName.trim(),
          clientPhone: customerPhone.trim(),
          date,
          lines: [{ description: notes.trim() || "Sale", qty: 1, rate: amt }],
          total: amt,
          taxRate: 0,
          notes: notes.trim() || undefined,
        });
      }
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
        <Text style={styles.headerTitle}>{editId ? "Edit Sale" : "Log Sale"}</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          {/* Cash vs Party toggle — hidden while editing an existing cash sale */}
          {!editId && (
            <Card style={{ marginBottom: theme.spacing.md }}>
              <Text style={styles.label}>Sale type</Text>
              <View style={styles.segRow}>
                <Pressable
                  testID="seg-cash"
                  onPress={() => setSaleType("cash")}
                  style={[styles.segBtn, saleType === "cash" && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, saleType === "cash" && styles.segTextActive]}>💵 Cash sale</Text>
                </Pressable>
                <Pressable
                  testID="seg-party"
                  onPress={() => setSaleType("party")}
                  style={[styles.segBtn, saleType === "party" && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, saleType === "party" && styles.segTextActive]}>👤 To a customer (credit)</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                {saleType === "cash"
                  ? "Money received now — added straight to your cash sales."
                  : "Customer owes you — this creates an invoice and adds them to Debtors."}
              </Text>
            </Card>
          )}

          <Card>
            <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
            <TextInput value={date} onChangeText={setDate} placeholder="2024-01-01" placeholderTextColor={theme.color.muted} style={styles.input} />
            <Text style={[styles.label, { marginTop: 12 }]}>Amount</Text>
            <TextInput testID="input-sale-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input]} />
            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-sale-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
          </Card>

          {/* Customer picker — only for credit/party sales */}
          {!editId && saleType === "party" && (
            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Customer / Party name</Text>
              <TextInput
                testID="input-customer-name"
                value={customerName}
                onChangeText={setCustomerName}
                placeholder="e.g. Sharma Traders"
                placeholderTextColor={theme.color.muted}
                autoCapitalize="words"
                style={styles.input}
              />
              {existing.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {existing
                    .filter((e) => !customerName.trim() || e.name.toLowerCase().includes(customerName.trim().toLowerCase()))
                    .slice(0, 6)
                    .map((e) => (
                      <Pressable key={e.id} testID={`pick-cust-${e.id}`} onPress={() => setCustomerName(e.name)} style={styles.chip}>
                        <Text style={styles.chipText}>{e.name}</Text>
                      </Pressable>
                    ))}
                </View>
              )}
              <Text style={[styles.label, { marginTop: 12 }]}>Phone (optional)</Text>
              <TextInput
                testID="input-customer-phone"
                value={customerPhone}
                onChangeText={setCustomerPhone}
                keyboardType="phone-pad"
                placeholder="+1 555 000 0000"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
              />
            </Card>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="btn-save-sale" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.saveText}>
                {editId ? "Update Sale" : saleType === "cash" ? "Save Cash Sale" : "Create Invoice & Save"}
              </Text>
            )}
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
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 8 },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  segRow: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 3, marginTop: 8, gap: 4 },
  segBtn: { flex: 1, paddingHorizontal: 10, paddingVertical: 12, borderRadius: theme.radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 12, textAlign: "center" },
  segTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  chipText: { fontSize: 13, color: theme.color.onSurface, fontWeight: "500" },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
