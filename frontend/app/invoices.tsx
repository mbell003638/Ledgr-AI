import React, { useCallback, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import { getCurrencySymbol } from "@/src/db/local";

type InvoiceLine = { description: string; qty: number; rate: number };
type Invoice = {
  id: string; invoiceNumber: string; status: "unpaid" | "paid";
  clientName: string; clientPhone?: string;
  date: string; dueDate?: string;
  lines: InvoiceLine[];
  notes?: string; taxLabel?: string; taxRate?: number;
  total: number; paidAt?: string;
};

function calcTotal(lines: InvoiceLine[], taxRate = 0) {
  const sub = lines.reduce((s, l) => s + l.qty * l.rate, 0);
  return +(sub + sub * taxRate / 100).toFixed(2);
}

function escapeHtml(v: any): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildHtml(inv: Invoice, biz: any, sym: string) {
  const sub = inv.lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const tax = inv.taxRate ? +(sub * inv.taxRate / 100).toFixed(2) : 0;
  const rows = inv.lines.map((l) =>
    `<tr><td>${escapeHtml(l.description)}</td><td style="text-align:center">${l.qty}</td><td style="text-align:right">${sym}${l.rate.toFixed(2)}</td><td style="text-align:right">${sym}${(l.qty * l.rate).toFixed(2)}</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body{font-family:sans-serif;padding:32px;color:#1a1a1a;font-size:14px}
    h1{font-size:28px;color:#1C4030;margin:0}
    .biz{color:#555;font-size:13px;margin-top:4px}
    .row{display:flex;justify-content:space-between;margin-top:24px}
    .label{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:.5px}
    .val{font-size:15px;font-weight:600;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:24px}
    th{background:#1C4030;color:#fff;padding:8px;text-align:left;font-size:12px}
    td{padding:8px;border-bottom:1px solid #eee;font-size:13px}
    .total-row td{font-weight:700;font-size:15px;border-top:2px solid #1C4030}
    .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;background:${inv.status === "paid" ? "#d4edda" : "#fff3cd"};color:${inv.status === "paid" ? "#155724" : "#856404"}}
    .notes{margin-top:24px;font-size:12px;color:#555}
    .payment{margin-top:16px;font-size:12px;color:#1C4030;font-weight:600}
  </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="display:flex;align-items:center;gap:12px">
        ${biz.logo ? `<img src="${biz.logo}" style="width:56px;height:56px;border-radius:8px;object-fit:cover"/>` : ""}
        <div><h1>${escapeHtml(biz.businessName || "Invoice")}</h1><div class="biz">${escapeHtml([biz.businessAddress, biz.businessPhone, biz.businessEmail].filter(Boolean).join(" · "))}</div></div>
      </div>
      <div style="text-align:right"><div class="label">Invoice</div><div class="val">${inv.invoiceNumber}</div><div style="margin-top:8px"><span class="badge">${inv.status.toUpperCase()}</span></div></div>
    </div>
    <div class="row">
      <div><div class="label">Bill To</div><div class="val">${escapeHtml(inv.clientName)}</div>${inv.clientPhone ? `<div style="font-size:12px;color:#555">${escapeHtml(inv.clientPhone)}</div>` : ""}</div>
      <div style="text-align:right"><div class="label">Date</div><div class="val">${inv.date}</div>${inv.dueDate ? `<div class="label" style="margin-top:8px">Due</div><div class="val">${inv.dueDate}</div>` : ""}</div>
    </div>
    <table><thead><tr><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}
    ${tax > 0 ? `<tr><td colspan="3" style="text-align:right">${escapeHtml(inv.taxLabel || "Tax")} (${inv.taxRate}%)</td><td style="text-align:right">${sym}${tax.toFixed(2)}</td></tr>` : ""}
    <tr class="total-row"><td colspan="3" style="text-align:right">Total</td><td style="text-align:right">${sym}${inv.total.toFixed(2)}</td></tr>
    </tbody></table>
    ${inv.notes ? `<div class="notes">Notes: ${escapeHtml(inv.notes)}</div>` : ""}
    ${(biz.bankAccount || biz.upiId || biz.paymentDetails) ? `<div class="payment">Payment details:${biz.bankAccount ? `<br/>Bank / Interac: ${escapeHtml(biz.bankAccount)}` : ""}${biz.upiId ? `<br/>UPI: ${escapeHtml(biz.upiId)}` : ""}${biz.paymentDetails ? `<br/>${escapeHtml(biz.paymentDetails)}` : ""}</div>` : ""}
  </body></html>`;
}

export default function InvoicesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [overdue, setOverdue] = useState<Invoice[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [biz, setBiz] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Form state
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<InvoiceLine[]>([{ description: "", qty: 1, rate: 0 }]);
  const [notes, setNotes] = useState("");
  const [taxLabelInput, setTaxLabelInput] = useState("");
  const [taxRateInput, setTaxRateInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    try {
      const [invs, od, s] = await Promise.all([api.listInvoices(), api.overdueInvoices(), api.getSettings()]);
      setInvoices(invs as Invoice[]);
      setOverdue(od as Invoice[]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setBiz(s);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openNew = () => {
    setEditId(null);
    setClientName(""); setClientPhone(""); setDate(new Date().toISOString().slice(0, 10));
    setDueDate(""); setLines([{ description: "", qty: 1, rate: 0 }]); setNotes(""); setFormError("");
    // Pre-fill tax from global settings; user can override per-invoice.
    const defLabel = biz.taxLabel && biz.taxLabel !== "None" ? (biz.taxLabel === "Custom" ? (biz.taxLabelCustom || "Tax") : biz.taxLabel) : "";
    setTaxLabelInput(defLabel);
    setTaxRateInput(biz.taxRate ? String(biz.taxRate) : "");
    setShowForm(true);
  };

  const openEdit = (inv: Invoice) => {
    setEditId(inv.id);
    setClientName(inv.clientName); setClientPhone(inv.clientPhone || "");
    setDate(inv.date); setDueDate(inv.dueDate || "");
    setLines(inv.lines.length ? inv.lines : [{ description: "", qty: 1, rate: 0 }]);
    setNotes(inv.notes || ""); setFormError("");
    setTaxLabelInput(inv.taxLabel || "");
    setTaxRateInput(inv.taxRate ? String(inv.taxRate) : "");
    setShowForm(true); setSelected(null);
  };

  const saveInvoice = async () => {
    if (!clientName.trim()) { setFormError("Client name is required"); return; }
    if (lines.every((l) => !l.description.trim())) { setFormError("Add at least one line item"); return; }
    setSaving(true); setFormError("");
    try {
      const validLines = lines.filter((l) => l.description.trim());
      const rate = parseFloat(taxRateInput) || 0;
      const label = taxLabelInput.trim();
      const payload = {
        clientName: clientName.trim(), clientPhone: clientPhone.trim(),
        date, dueDate: dueDate.trim() || undefined,
        lines: validLines,
        notes: notes.trim(),
        taxLabel: rate > 0 && label ? label : (rate > 0 ? "Tax" : undefined),
        taxRate: rate,
        total: calcTotal(validLines, rate),
      };
      if (editId) await api.updateInvoice(editId, payload);
      else await api.createInvoice(payload);
      setShowForm(false);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  };

  const markPaid = async (id: string) => {
    await api.markInvoicePaid(id);
    await load();
    setSelected(null);
  };

  const deleteInv = async (id: string) => {
    await api.deleteInvoice(id);
    await load();
    setSelected(null);
  };

  const sharePdf = async (inv: Invoice) => {
    try {
      const html = buildHtml(inv, biz, currSym);
      const { uri } = await Print.printToFileAsync({ html });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Invoice ${inv.invoiceNumber}` });
    } catch (e: any) { console.warn(e); }
  };

  const shareWhatsApp = (inv: Invoice) => {
    const phone = (inv.clientPhone || "").replace(/\D/g, "");
    const msg = `Hi ${inv.clientName}, please find your invoice ${inv.invoiceNumber} for ${currSym}${inv.total.toFixed(2)} dated ${inv.date}.${inv.dueDate ? ` Due: ${inv.dueDate}.` : ""}${biz.paymentDetails ? `\nPayment: ${biz.paymentDetails}` : ""}`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const updateLine = (i: number, field: keyof InvoiceLine, val: string) => {
    setLines((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: field === "description" ? val : parseFloat(val) || 0 } : l));
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  // Detail view
  if (selected) {
    const sub = selected.lines.reduce((s, l) => s + l.qty * l.rate, 0);
    const tax = selected.taxRate ? +(sub * selected.taxRate / 100).toFixed(2) : 0;
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
          <Text style={styles.headerTitle}>{selected.invoiceNumber}</Text>
          <Pressable onPress={() => openEdit(selected)}><Ionicons name="create-outline" size={22} color={theme.color.brandPrimary} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={styles.name}>{selected.clientName}</Text>
                {selected.clientPhone ? <Text style={styles.sub}>{selected.clientPhone}</Text> : null}
              </View>
              <View style={[styles.badge, { backgroundColor: selected.status === "paid" ? "#d4edda" : "#fff3cd" }]}>
                <Text style={{ fontSize: 11, fontWeight: "700", color: selected.status === "paid" ? "#155724" : "#856404" }}>{selected.status.toUpperCase()}</Text>
              </View>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: theme.spacing.md }}>
              <Text style={styles.sub}>Date: {shortDate(selected.date)}</Text>
              {selected.dueDate ? <Text style={[styles.sub, { color: selected.status === "unpaid" && selected.dueDate < new Date().toISOString().slice(0, 10) ? theme.color.error : theme.color.muted }]}>Due: {shortDate(selected.dueDate)}</Text> : null}
            </View>
          </Card>

          <Card style={{ marginTop: theme.spacing.md }}>
            <Text style={styles.sectionTitle}>Line Items</Text>
            {selected.lines.map((l, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.color.divider }}>
                <Text style={{ flex: 1, fontSize: 13, color: theme.color.onSurface }}>{l.description}</Text>
                <Text style={{ fontSize: 13, color: theme.color.muted, marginHorizontal: 8 }}>{l.qty} × {currSym}{l.rate.toFixed(2)}</Text>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }}>{currSym}{(l.qty * l.rate).toFixed(2)}</Text>
              </View>
            ))}
            {tax > 0 && <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}><Text style={styles.sub}>{selected.taxLabel} ({selected.taxRate}%)</Text><Text style={styles.sub}>{currSym}{tax.toFixed(2)}</Text></View>}
            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 8, borderTopWidth: 2, borderTopColor: theme.color.brandPrimary, marginTop: 4 }}>
              <Text style={{ fontWeight: "700", fontSize: 15, color: theme.color.onSurface }}>Total</Text>
              <Text style={{ fontWeight: "700", fontSize: 18, color: theme.color.brandPrimary }}>{currSym}{selected.total.toFixed(2)}</Text>
            </View>
          </Card>

          {selected.notes ? <Card style={{ marginTop: theme.spacing.md }}><Text style={styles.sub}>{selected.notes}</Text></Card> : null}

          <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md, flexWrap: "wrap" }}>
            <Pressable onPress={() => sharePdf(selected)} style={[styles.actionBtn, { flex: 1 }]}>
              <Ionicons name="document-outline" size={16} color="#fff" />
              <Text style={styles.actionText}>PDF / Share</Text>
            </Pressable>
            {selected.clientPhone ? (
              <Pressable onPress={() => shareWhatsApp(selected)} style={[styles.actionBtn, { flex: 1, backgroundColor: "#25D366" }]}>
                <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                <Text style={styles.actionText}>WhatsApp</Text>
              </Pressable>
            ) : null}
          </View>
          {selected.status === "unpaid" && (
            <Pressable onPress={() => markPaid(selected.id)} style={[styles.actionBtn, { marginTop: 8, backgroundColor: theme.color.success }]}>
              <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
              <Text style={styles.actionText}>Mark as Paid</Text>
            </Pressable>
          )}
          <Pressable onPress={() => deleteInv(selected.id)} style={{ alignItems: "center", marginTop: theme.spacing.md, padding: theme.spacing.md }}>
            <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 13 }}>Delete Invoice</Text>
          </Pressable>
          <View style={{ height: 60 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Invoices</Text>
        <Pressable onPress={openNew}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        {overdue.length > 0 && (
          <View style={[styles.overdueBar]}>
            <Ionicons name="alert-circle" size={16} color={theme.color.error} />
            <Text style={{ color: theme.color.error, fontSize: 13, fontWeight: "600", marginLeft: 6 }}>{overdue.length} overdue invoice{overdue.length > 1 ? "s" : ""}</Text>
          </View>
        )}

        {invoices.length === 0 ? (
          <Text style={styles.empty}>No invoices yet. Tap + to create one.</Text>
        ) : invoices.map((inv) => (
          <Pressable key={inv.id} onPress={() => setSelected(inv)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{inv.clientName}</Text>
              <Text style={styles.sub}>{inv.invoiceNumber} · {shortDate(inv.date)}{inv.dueDate ? ` · Due ${shortDate(inv.dueDate)}` : ""}</Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 4 }}>
              <Text style={{ fontWeight: "700", fontSize: 15, color: theme.color.onSurface }}>{currSym}{inv.total.toFixed(2)}</Text>
              <View style={[styles.badge, { backgroundColor: inv.status === "paid" ? "#d4edda" : "#fff3cd" }]}>
                <Text style={{ fontSize: 10, fontWeight: "700", color: inv.status === "paid" ? "#155724" : "#856404" }}>{inv.status.toUpperCase()}</Text>
              </View>
            </View>
          </Pressable>
        ))}
        <View style={{ height: 60 }} />
      </ScrollView>

      {/* Create / Edit Modal */}
      <Modal visible={showForm} animationType="slide">
        <SafeAreaView style={styles.container} edges={["top"]}>
          <View style={styles.headerBar}>
            <Pressable onPress={() => setShowForm(false)}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
            <Text style={styles.headerTitle}>{editId ? "Edit Invoice" : "New Invoice"}</Text>
            <View style={{ width: 26 }} />
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
              <Card>
                <Text style={styles.label}>Client Name *</Text>
                <TextInput value={clientName} onChangeText={setClientName} placeholder="Full name or business" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Client Phone</Text>
                <TextInput value={clientPhone} onChangeText={setClientPhone} placeholder="+1 555 000 0000" placeholderTextColor={theme.color.muted} keyboardType="phone-pad" style={styles.input} />
                <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Date</Text>
                    <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Due Date</Text>
                    <TextInput value={dueDate} onChangeText={setDueDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </View>
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Line Items</Text>
                {lines.map((l, i) => (
                  <View key={i} style={{ marginTop: 10 }}>
                    <TextInput value={l.description} onChangeText={(v) => updateLine(i, "description", v)} placeholder="Description" placeholderTextColor={theme.color.muted} style={styles.input} />
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <TextInput value={String(l.qty)} onChangeText={(v) => updateLine(i, "qty", v)} keyboardType="decimal-pad" placeholder="Qty" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} />
                      <TextInput value={String(l.rate)} onChangeText={(v) => updateLine(i, "rate", v)} keyboardType="decimal-pad" placeholder="Rate" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 2 }]} />
                      <View style={{ justifyContent: "center", flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }}>{currSym}{(l.qty * l.rate).toFixed(2)}</Text>
                      </View>
                    </View>
                    {lines.length > 1 && (
                      <Pressable onPress={() => setLines((p) => p.filter((_, idx) => idx !== i))} style={{ alignSelf: "flex-end", marginTop: 4 }}>
                        <Text style={{ color: theme.color.error, fontSize: 12 }}>Remove</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
                <Pressable onPress={() => setLines((p) => [...p, { description: "", qty: 1, rate: 0 }])} style={[styles.addBtn]}>
                  <Ionicons name="add-outline" size={16} color={theme.color.brandPrimary} />
                  <Text style={{ color: theme.color.brandPrimary, fontSize: 13, fontWeight: "600" }}>Add Line</Text>
                </Pressable>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                  <View style={{ flex: 2 }}>
                    <Text style={styles.label}>Tax Description</Text>
                    <TextInput value={taxLabelInput} onChangeText={setTaxLabelInput} placeholder="e.g. GST / VAT / Sales Tax" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Rate %</Text>
                    <TextInput value={taxRateInput} onChangeText={setTaxRateInput} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </View>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.color.divider }}>
                  <Text style={{ fontWeight: "700", color: theme.color.onSurface }}>Total</Text>
                  <Text style={{ fontWeight: "700", fontSize: 16, color: theme.color.brandPrimary }}>{currSym}{calcTotal(lines.filter((l) => l.description.trim()), parseFloat(taxRateInput) || 0).toFixed(2)}</Text>
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Notes</Text>
                <TextInput value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
              </Card>

              {formError ? <Text style={styles.error}>{formError}</Text> : null}
              <Pressable onPress={saveInvoice} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update Invoice" : "Create Invoice"}</Text>}
              </Pressable>
              <View style={{ height: 60 }} />
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    name: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    sub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    sectionTitle: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface, marginBottom: theme.spacing.sm },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm },
    badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
    overdueBar: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff3cd", padding: theme.spacing.md, borderRadius: theme.radius.md, marginBottom: theme.spacing.md, borderWidth: 1, borderColor: "#ffc107" },
    actionBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: 12, borderRadius: theme.radius.md },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
    saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    addBtn: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: theme.spacing.md, padding: theme.spacing.sm },
  });
}
