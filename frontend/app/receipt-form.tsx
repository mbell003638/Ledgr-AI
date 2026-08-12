import React, { useMemo, useState, useCallback } from "react";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, TextInput, ScrollView, KeyboardAvoidingView, Platform, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { Card } from "@/src/components/UI";
import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";

type Mode = "against_invoice" | "advance";
type Invoice = { id: string; invoiceNumber: string; clientName: string; total: number; status: string; date: string };
type Debtor = { id: string; name: string; balance?: number };

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const MODE_LABEL: Record<Mode, string> = {
  against_invoice: "Against Invoice",
  advance: "Advance / Deposit",
};

export default function ReceiptFormScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id;

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [currSym, setCurrSym] = useState("$");

  const [mode, setMode] = useState<Mode>("against_invoice");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayStr());
  const [clientName, setClientName] = useState("");
  const [debtorId, setDebtorId] = useState<string | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [method, setMethod] = useState("cash");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [il, dl, s] = await Promise.all([api.listInvoices(), api.listDebtors(), api.getSettings()]);
      setInvoices((il as Invoice[]).filter((i) => i.status !== "paid"));
      setDebtors(dl as Debtor[]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));

      if (editId) {
        const rl = await api.listReceipts();
        const r = (rl as any[]).find((x) => x.id === editId);
        if (r) {
          setMode(r.mode === "cash_sale" ? "advance" : r.mode); setAmount(String(r.amount)); setDate(r.date); setClientName(r.clientName || "");
          setDebtorId(r.debtorId || null); setMethod(r.method || "cash"); setNotes(r.notes || "");
          if (r.allocations && r.allocations.length > 0) {
            setInvoiceId(r.allocations[0].invoiceId);
          }
        }
      }
    } catch (e) { console.warn(e); }
  }, [editId]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const runOcr = async (base64: string, mimeType: string) => {
    setOcrBusy(true); setErr(""); setPhoto(base64);
    try {
      const r = await api.ocrReceipt(base64, mimeType);
      if (r.amount) setAmount(String(r.amount));
      if (r.date) setDate(r.date);
      if (r.supplierName && !clientName) setClientName(r.supplierName);
    } catch (e: any) {
      setErr(e?.message || "Could not read the image.");
    } finally { setOcrBusy(false); }
  };

  const scan = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setErr("Camera permission denied."); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await runOcr(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };

  const uploadImg = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr("Gallery permission denied."); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await runOcr(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };

  const pickInvoice = async (inv: Invoice) => {
    setInvoiceId(inv.id);
    setClientName(inv.clientName);
    const match = debtors.find((d) => d.name.trim().toLowerCase() === inv.clientName.trim().toLowerCase());
    setDebtorId(match ? match.id : null);
    try {
      const paid = await api.invoicePaidAmount(inv.id);
      const open = +(inv.total - paid).toFixed(2);
      setAmount(open > 0 ? String(open) : "");
    } catch { setAmount(String(inv.total)); }
  };

  const save = async () => {
    setErr("");
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setErr(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setErr("Enter a valid amount."); return; }
    if (!clientName.trim()) { setErr("Customer account name is required."); return; }
    if (mode === "against_invoice" && !invoiceId) { setErr("Pick an invoice to settle."); return; }
    setSaving(true);
    try {
      let finalDebtorId = debtorId;
      if (clientName.trim()) {
        const party = await api.findOrCreateParty(clientName.trim(), "customer");
        if (party) finalDebtorId = party.id;
      }
      const payload: any = { mode, date: dateIso, amount: amt, method, notes, clientName: clientName.trim(), debtorId: finalDebtorId };
      if (mode === "against_invoice" && invoiceId) payload.allocations = [{ invoiceId, amountApplied: amt }];
      
      if (editId) {
         await api.deleteReceipt(editId);
      }
      await api.createReceipt(payload);
      router.back();
    } catch (e: any) {
      setErr(e?.message || "Failed to save receipt.");
    } finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="close" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{editId ? "Edit Receipt" : "New Receipt"}</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: theme.spacing.lg }}>
          <View style={styles.scanRow}>
            <Pressable onPress={scan} disabled={ocrBusy} style={[styles.scanBtn, { flex: 1 }]}>
              <Ionicons name="camera-outline" size={16} color="#fff" />
              <Text style={styles.scanText}>Scan</Text>
            </Pressable>
            <Pressable onPress={uploadImg} disabled={ocrBusy} style={[styles.scanBtn, { flex: 1, backgroundColor: theme.color.brandSecondary }]}>
              <Ionicons name="image-outline" size={16} color="#fff" />
              <Text style={styles.scanText}>Upload</Text>
            </Pressable>
          </View>
          {ocrBusy ? <Text style={styles.hint}>Reading image…</Text> : null}

          {photo ? (
            <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={styles.preview} />
          ) : null}

          <Card style={{ marginBottom: theme.spacing.md, marginTop: theme.spacing.md }}>
            <Text style={styles.label}>Receipt Type</Text>
            <View style={styles.modeRow}>
              {(["against_invoice", "advance"] as Mode[]).map((m) => (
                <Pressable key={m} onPress={() => { setMode(m); setInvoiceId(null); }} style={[styles.modeBtn, mode === m && styles.modeBtnActive]}>
                  <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{MODE_LABEL[m]}</Text>
                </Pressable>
              ))}
            </View>

            <View style={{ marginTop: 12 }}>
              <PartyAutocompleteInput
                label="Customer account name *"
                value={clientName}
                onChangeText={(val) => {
                  setClientName(val);
                  setDebtorId(null);
                }}
                placeholder="e.g. Sharma Traders"
                roleFilter="all"
                onSelectParty={(p) => {
                  setClientName(p.name);
                  setDebtorId(p.id);
                }}
              />
            </View>

            {mode === "against_invoice" && (
              <>
                <Text style={[styles.label, { marginTop: 16 }]}>Settle Invoice (Optional)</Text>
                {invoices.length === 0 ? (
                  <Text style={styles.hint}>No unpaid invoices found.</Text>
                ) : invoices
                  .filter((inv) => !clientName.trim() || inv.clientName.toLowerCase().includes(clientName.trim().toLowerCase()))
                  .map((inv) => (
                    <Pressable key={inv.id} onPress={() => pickInvoice(inv)} style={[styles.pickRow, invoiceId === inv.id && styles.pickRowActive]}>
                      <Text style={styles.pickTitle}>{inv.invoiceNumber} · {inv.clientName}</Text>
                      <Text style={styles.pickAmt}>{currSym}{Number(inv.total).toFixed(2)}</Text>
                    </Pressable>
                  ))}
              </>
            )}
          </Card>

          <Card>
            <Text style={styles.label}>Amount Received</Text>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />

            <Text style={[styles.label, { marginTop: 12 }]}>Date</Text>
            <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />

            <Text style={[styles.label, { marginTop: 12 }]}>Payment Method</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
              <Pressable
                onPress={() => { setMethod("cash"); }}
                style={[{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface }, method === "cash" && { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary }]}
              >
                <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface, textAlign: "center" }, method === "cash" && { color: "#fff" }]}>Cash</Text>
              </Pressable>
              <Pressable
                onPress={() => { setMethod(method === "cash" ? "" : method); }}
                style={[{ flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface }, method !== "cash" && { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary }]}
              >
                <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface, textAlign: "center" }, method !== "cash" && { color: "#fff" }]}>Bank / Custom</Text>
              </Pressable>
            </View>
            {method !== "cash" && (
              <TextInput testID="input-method" value={method} onChangeText={setMethod} placeholder="e.g. Bank Transfer, UPI, Check" placeholderTextColor={theme.color.muted} style={[styles.input, { marginTop: 8 }]} />
            )}

            <Text style={[styles.label, { marginTop: 12 }]}>Details / Information (Receipt For / Reason)</Text>
            <TextInput value={notes} onChangeText={setNotes} placeholder="e.g. Receipt for Invoice INV-002, July deposit" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
          </Card>

          {err ? <Text style={styles.error}>{err}</Text> : null}
          <Pressable onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Receipt</Text>}
          </Pressable>
          <View style={{ height: 60 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    scanRow: { flexDirection: "row", gap: 8 },
    scanBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, paddingVertical: 10, borderRadius: theme.radius.md },
    scanText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    modeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    modeBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    modeBtnActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    modeText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface },
    modeTextActive: { color: "#fff" },
    pickRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, marginTop: 6 },
    pickRowActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandTertiary },
    pickTitle: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    pickAmt: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
    saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    preview: { width: "100%", height: 160, borderRadius: theme.radius.md, marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
  });
}
