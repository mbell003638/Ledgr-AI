import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { theme } from "@/src/theme";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

export default function BillForm() {
  const router = useRouter();
  const params = useLocalSearchParams<{ supplierId?: string }>();
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [supplierId, setSupplierId] = useState<string>(params.supplierId || "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"USD" | "CDF">("USD");
  const [paymentType, setPaymentType] = useState<"credit" | "cash">("credit");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [date] = useState(new Date().toISOString().slice(0, 10));
  const [photo, setPhoto] = useState<string>("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(2500);

  useEffect(() => {
    (async () => {
      const s = await api.listSuppliers();
      setSuppliers(s);
      if (!supplierId && s.length) setSupplierId(s[0].id);
      const st = await api.getSettings();
      setRate(st.fcRate || 2500);
    })();
  }, []);

  const scanReceipt = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission denied"); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    const asset = res.assets[0];
    setPhoto(asset.base64!);
    setOcrLoading(true);
    try {
      const r = await api.ocrReceipt(asset.base64!, asset.mimeType || "image/jpeg");
      if (r.amount) setAmount(String(r.amount));
      if (r.currency && (r.currency === "USD" || r.currency === "CDF")) setCurrency(r.currency);
      if (r.invoiceNo) setInvoiceNo(r.invoiceNo);
      if (r.supplierName) {
        const match = suppliers.find((s) => s.name.toLowerCase().includes(r.supplierName.toLowerCase()));
        if (match) setSupplierId(match.id);
        else setNotes((n) => (n ? n + "\n" : "") + `Detected supplier: ${r.supplierName}`);
      }
    } catch (e: any) {
      setError(e.message || "OCR failed");
    } finally {
      setOcrLoading(false);
    }
  };

  const save = async () => {
    setError("");
    if (!supplierId) { setError("Select a supplier"); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    setSaving(true);
    try {
      await api.createBill({
        supplierId, date, amount: amt, currency, rate,
        paymentType, invoiceNo, notes, photo,
      });
      router.back();
    } catch (e: any) { setError(e.message || "Failed"); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-bill" onPress={() => router.back()}>
          <Ionicons name="close" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>New Vendor Bill</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Pressable
            testID="btn-scan-receipt"
            onPress={scanReceipt}
            style={({ pressed }) => [styles.scanBtn, pressed && { opacity: 0.85 }]}
          >
            {ocrLoading ? <ActivityIndicator color="#fff" /> : <>
              <Ionicons name="scan-outline" size={20} color="#fff" />
              <Text style={styles.scanText}>Scan Receipt (AI OCR)</Text>
            </>}
          </Pressable>

          {photo ? (
            <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={styles.preview} />
          ) : null}

          <Card style={{ marginTop: theme.spacing.md }}>
            <Text style={styles.label}>Supplier</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
              {suppliers.length === 0 ? (
                <Text style={styles.hint}>No suppliers. Add one first.</Text>
              ) : suppliers.map((s) => (
                <Pressable
                  key={s.id}
                  testID={`supplier-chip-${s.id}`}
                  onPress={() => setSupplierId(s.id)}
                  style={[styles.chip, supplierId === s.id && styles.chipActive]}
                >
                  <Text style={[styles.chipText, supplierId === s.id && styles.chipTextActive]}>{s.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={[styles.label, { marginTop: 8 }]}>Amount</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                testID="input-amount"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={theme.color.muted}
                style={[styles.input, { flex: 1 }]}
              />
              <View style={styles.segRow}>
                {(["USD", "CDF"] as const).map((c) => (
                  <Pressable
                    key={c}
                    testID={`currency-${c}`}
                    onPress={() => setCurrency(c)}
                    style={[styles.segBtn, currency === c && styles.segBtnActive]}
                  >
                    <Text style={[styles.segText, currency === c && styles.segTextActive]}>{c}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Payment Type</Text>
            <View style={styles.segRowFull}>
              {(["credit", "cash"] as const).map((c) => (
                <Pressable
                  key={c}
                  testID={`pay-${c}`}
                  onPress={() => setPaymentType(c)}
                  style={[styles.segBtnFull, paymentType === c && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, paymentType === c && styles.segTextActive]}>{c === "credit" ? "On Credit" : "Cash"}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Invoice #</Text>
            <TextInput testID="input-invoice" value={invoiceNo} onChangeText={setInvoiceNo} placeholder="Optional" placeholderTextColor={theme.color.muted} style={styles.input} />

            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />

            <Text style={[styles.hint, { marginTop: 8 }]}>Date: {date}</Text>
          </Card>

          {error ? <Text style={styles.error} testID="bill-error">{error}</Text> : null}

          <Pressable
            testID="btn-save-bill"
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Bill</Text>}
          </Pressable>
          <View style={{ height: 60 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  scroll: { padding: theme.spacing.lg },
  scanBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md },
  scanText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  preview: { width: "100%", height: 160, borderRadius: theme.radius.md, marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  hint: { fontSize: 12, color: theme.color.muted },
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
  error: { color: theme.color.error, textAlign: "center", marginTop: theme.spacing.md, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
