import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, TextInput, Alert, Modal, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { Empty } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";

type Mode = "cash_sale" | "against_invoice" | "advance";
type Receipt = {
  id: string; receiptNumber: string; mode: Mode; date: string; amount: number;
  clientName?: string; debtorId?: string | null; method?: string; notes?: string;
  allocations?: { invoiceId: string; amountApplied: number }[];
};
type Invoice = { id: string; invoiceNumber: string; clientName: string; total: number; status: string; date: string };
type Debtor = { id: string; name: string; balance?: number };

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const MODE_LABEL: Record<Mode, string> = {
  cash_sale: "Cash Sale",
  against_invoice: "Against Invoice",
  advance: "Advance",
};

export default function ReceiptsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [taxRate, setTaxRate] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Receipt | null>(null);

  // form state
  const [formOpen, setFormOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("cash_sale");
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

  const load = useCallback(async () => {
    try {
      const [rl, il, dl, s] = await Promise.all([api.listReceipts(), api.listInvoices(), api.listDebtors(), api.getSettings()]);
      setReceipts(rl as Receipt[]);
      setInvoices((il as Invoice[]).filter((i) => i.status !== "paid"));
      setDebtors(dl as Debtor[]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setTaxRate(Number(s.taxRate) || 0);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totalReceived = useMemo(() => receipts.reduce((s, r) => s + (Number(r.amount) || 0), 0), [receipts]);

  const resetForm = () => {
    setMode("cash_sale"); setAmount(""); setDate(todayStr()); setClientName("");
    setDebtorId(null); setInvoiceId(null); setMethod("cash"); setNotes(""); setErr("");
  };
  const openAdd = () => { resetForm(); setFormOpen(true); };

  // Scan / upload a receipt image → OCR → prefill amount, date, customer.
  const runOcr = async (base64: string, mimeType: string) => {
    setOcrBusy(true); setErr("");
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

  // When an invoice is picked, prefill client + amount (its open balance).
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
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setErr("Enter a valid amount."); return; }
    if (mode === "against_invoice" && !invoiceId) { setErr("Pick an invoice to settle."); return; }
    if (mode === "advance" && !debtorId) { setErr("Pick a customer for the advance."); return; }
    setSaving(true);
    try {
      const payload: any = { mode, date, amount: amt, method, notes, clientName: clientName.trim(), debtorId };
      if (mode === "against_invoice" && invoiceId) payload.allocations = [{ invoiceId, amountApplied: amt }];
      if (mode === "cash_sale") payload.taxRate = taxRate;
      await api.createReceipt(payload);
      setFormOpen(false);
      resetForm();
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to save receipt.");
    } finally { setSaving(false); }
  };

  const remove = (r: Receipt) => {
    Alert.alert("Delete Receipt", `Delete ${r.receiptNumber}? This reverses its cash, sales and debtor entries.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          const ok = await requireAuth("Confirm delete receipt");
          if (!ok) return;
          try { await api.deleteReceipt(r.id); await load(); } catch (e) { console.warn(e); }
        },
      },
    ]);
  };

  const openEdit = (r: Receipt) => {
    setMode(r.mode); setAmount(String(r.amount)); setDate(r.date); setClientName(r.clientName || "");
    setDebtorId(r.debtorId || null); setMethod(r.method || "cash"); setNotes(r.notes || "");
    setSelected(null); setFormOpen(true);
  };
  const documentFor = (r: Receipt) => ({ title: `Receipt ${r.receiptNumber}`, subtitle: MODE_LABEL[r.mode], rows: [
    ["Customer", r.clientName || "Walk-in"], ["Date", shortDate(r.date)], ["Amount", `${currSym}${Number(r.amount).toFixed(2)}`],
    ["Method", r.method || "—"], ["Notes", r.notes || "—"],
  ] as Array<[string, unknown]> });

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable><Text style={styles.headerTitle}>Receipt</Text><View style={{ width: 26 }} /></View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <TransactionDetail
          title={selected.receiptNumber}
          subtitle={`${MODE_LABEL[selected.mode]} • ${currSym}${Number(selected.amount).toFixed(2)}`}
          onEdit={() => openEdit(selected)}
          onReversalDelete={() => remove(selected)}
          onShare={() => shareTransaction(documentFor(selected))}
          onPrint={() => printTransaction(documentFor(selected))}
          onMore={() => Alert.alert("Receipt details", selected.notes || `${selected.method || "Unknown"} payment`)}
        ><Text style={styles.rowSub}>{selected.clientName || "Walk-in"} • {shortDate(selected.date)}</Text></TransactionDetail>
      </ScrollView>
    </SafeAreaView>
  );

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Receipts</Text>
        <Pressable onPress={openAdd}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <View style={styles.summaryBar}>
        <Text style={styles.summaryLabel}>Total Received</Text>
        <Text style={styles.summaryValue}>{currSym}{totalReceived.toFixed(2)}</Text>
      </View>
      <FlatList
        data={receipts}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.color.brandPrimary} />}
        ListEmptyComponent={<Empty icon={<Ionicons name="receipt-outline" size={40} color={theme.color.muted} />} title="No receipts yet" hint="Tap + to record money received." />}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} onLongPress={() => remove(item)} style={styles.row}>
            <View style={[styles.badge, { backgroundColor: item.mode === "cash_sale" ? "#DCE8DC" : item.mode === "advance" ? "#F0E4D0" : "#D8E4F0" }]}>
              <Ionicons name={item.mode === "cash_sale" ? "cart-outline" : item.mode === "advance" ? "arrow-down-circle-outline" : "document-text-outline"} size={18} color={theme.color.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{item.receiptNumber} · {MODE_LABEL[item.mode]}</Text>
              <Text style={styles.rowSub}>{item.clientName || "Walk-in"} · {shortDate(item.date)}{item.method ? ` · ${item.method}` : ""}</Text>
            </View>
            <Text style={styles.rowAmount}>{currSym}{Number(item.amount).toFixed(2)}</Text>
          </Pressable>
        )}
      />

      <Modal visible={formOpen} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalBox}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>New Receipt</Text>
                <Pressable onPress={() => setFormOpen(false)}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled">
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

                <Text style={styles.label}>Type</Text>
                <View style={styles.modeRow}>
                  {(["cash_sale", "against_invoice", "advance"] as Mode[]).map((m) => (
                    <Pressable key={m} onPress={() => { setMode(m); setInvoiceId(null); }} style={[styles.modeBtn, mode === m && styles.modeBtnActive]}>
                      <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{MODE_LABEL[m]}</Text>
                    </Pressable>
                  ))}
                </View>

                {mode === "against_invoice" && (
                  <>
                    <Text style={[styles.label, { marginTop: 12 }]}>Settle Invoice</Text>
                    {invoices.length === 0 ? (
                      <Text style={styles.hint}>No unpaid invoices.</Text>
                    ) : invoices.map((inv) => (
                      <Pressable key={inv.id} onPress={() => pickInvoice(inv)} style={[styles.pickRow, invoiceId === inv.id && styles.pickRowActive]}>
                        <Text style={styles.pickTitle}>{inv.invoiceNumber} · {inv.clientName}</Text>
                        <Text style={styles.pickAmt}>{currSym}{Number(inv.total).toFixed(2)}</Text>
                      </Pressable>
                    ))}
                  </>
                )}

                {mode === "advance" && (
                  <>
                    <Text style={[styles.label, { marginTop: 12 }]}>Customer</Text>
                    {debtors.length === 0 ? (
                      <Text style={styles.hint}>No customers yet. Add one from Debtors.</Text>
                    ) : debtors.map((d) => (
                      <Pressable key={d.id} onPress={() => { setDebtorId(d.id); setClientName(d.name); }} style={[styles.pickRow, debtorId === d.id && styles.pickRowActive]}>
                        <Text style={styles.pickTitle}>{d.name}</Text>
                      </Pressable>
                    ))}
                  </>
                )}

                {mode === "cash_sale" && (
                  <>
                    <Text style={[styles.label, { marginTop: 12 }]}>Customer (optional)</Text>
                    <TextInput value={clientName} onChangeText={setClientName} placeholder="Walk-in" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </>
                )}

                <Text style={[styles.label, { marginTop: 12 }]}>Amount Received</Text>
                <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={[styles.label, { marginTop: 12 }]}>Date</Text>
                <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />

                <Text style={[styles.label, { marginTop: 12 }]}>Method</Text>
                <View style={styles.modeRow}>
                  {["cash", "card", "bank", "upi"].map((m) => (
                    <Pressable key={m} onPress={() => setMethod(m)} style={[styles.modeBtn, method === m && styles.modeBtnActive]}>
                      <Text style={[styles.modeText, method === m && styles.modeTextActive]}>{m.toUpperCase()}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
                <TextInput value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />

                {err ? <Text style={styles.error}>{err}</Text> : null}
                <Pressable onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Receipt</Text>}
                </Pressable>
                <View style={{ height: 20 }} />
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    summaryBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
    summaryLabel: { fontSize: 12, color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5 },
    summaryValue: { fontSize: 18, fontWeight: "700", color: theme.color.brandPrimary },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    badge: { width: 40, height: 40, borderRadius: 20, justifyContent: "center", alignItems: "center" },
    rowTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
    rowSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    rowAmount: { fontSize: 15, fontWeight: "700", color: theme.color.success },
    modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
    modalBox: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.spacing.lg, maxHeight: "88%" },
    modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.spacing.md },
    modalTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    scanRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
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
  });
}
