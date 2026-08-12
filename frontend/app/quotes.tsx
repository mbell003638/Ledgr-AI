import React, { useCallback, useMemo, useState } from "react";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Alert, Linking, InteractionManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { confirmAction } from "@/src/utils/alerts";
import { getDataVersion } from "@/src/utils/dataVersion";
import { useFocusEffect, useRouter } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import { getCurrencySymbol } from "@/src/db/local";
import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";

type Line = { description: string; qty: number; rate: number };
type Quote = {
  id: string; quoteNumber: string; clientName: string; clientPhone?: string;
  date: string; validUntil?: string; lines: Line[]; taxRate?: number; taxLabel?: string;
  notes?: string; total: number; status: string; convertedInvoiceId?: string | null;
};

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  draft: { bg: "#EDEDED", fg: "#666" },
  sent: { bg: "#D8E4F0", fg: "#1C4A7A" },
  accepted: { bg: "#DCE8DC", fg: "#1C4030" },
  expired: { bg: "#F0DCDC", fg: "#8A2A2A" },
  converted: { bg: "#E6DCE4", fg: "#5A2A6A" },
};

function escapeHtml(v: any): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildHtml(q: Quote, biz: any, sym: string) {
  const sub = q.lines.reduce((s, l) => s + l.qty * l.rate, 0);
  const tax = q.taxRate ? +(sub * q.taxRate / 100).toFixed(2) : 0;
  const money = (n: number) => `${sym}${n.toFixed(2)}`;
  const rows = q.lines.map((l, i) =>
    `<tr><td style="text-align:center">${i + 1}</td><td>${escapeHtml(l.description)}</td><td style="text-align:center">${l.qty}</td><td style="text-align:right">${money(l.rate)}</td><td style="text-align:right">${money(l.qty * l.rate)}</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body{font-family:sans-serif;padding:32px;color:#1a1a1a;font-size:14px}
    h1{font-size:22px;color:#1C4030;margin:0}
    .title{font-size:26px;color:#555;font-weight:700;letter-spacing:1px}
    .biz{color:#555;font-size:12px;margin-top:4px;line-height:1.5}
    .row{display:flex;justify-content:space-between;margin-top:28px;gap:24px}
    .label{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:.5px}
    .val{font-size:14px;font-weight:600;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:24px}
    th{background:#2b2b2b;color:#fff;padding:9px 8px;text-align:left;font-size:12px}
    td{padding:9px 8px;border-bottom:1px solid #eee;font-size:13px}
    .totals{margin-top:18px;margin-left:auto;width:60%}
    .totals td{border:none;padding:5px 8px}
    .totals .k{text-align:right;color:#555}
    .totals .v{text-align:right;font-weight:600;width:120px}
    .grand td{font-weight:700;font-size:15px;border-top:2px solid #2b2b2b}
    .notes{margin-top:24px;font-size:12px;color:#555}
  </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="display:flex;align-items:flex-start;gap:12px">
        ${biz.logo ? `<img src="${biz.logo}" style="width:64px;height:64px;border-radius:8px;object-fit:cover"/>` : ""}
        <div><h1>${escapeHtml(biz.businessName || "Quote")}</h1><div class="biz">${escapeHtml([biz.businessAddress, biz.businessPhone, biz.businessEmail].filter(Boolean).join(" · "))}</div></div>
      </div>
      <div style="text-align:right">
        <div class="title">QUOTATION</div>
        <div class="val" style="margin-top:6px">${q.quoteNumber}</div>
      </div>
    </div>
    <div class="row">
      <div><div class="label">Quote For</div><div class="val">${escapeHtml(q.clientName)}</div>${q.clientPhone ? `<div style="font-size:12px;color:#555">${escapeHtml(q.clientPhone)}</div>` : ""}</div>
      <div style="text-align:right"><div><span class="label">Date :</span> <span class="val" style="display:inline">${escapeHtml(q.date)}</span></div>${q.validUntil ? `<div><span class="label">Valid Until :</span> <span class="val" style="display:inline">${escapeHtml(q.validUntil)}</span></div>` : ""}</div>
    </div>
    <table><thead><tr><th style="text-align:center">#</th><th>Item &amp; Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <table class="totals">
      <tr><td class="k">Sub Total</td><td class="v">${money(sub)}</td></tr>
      ${tax > 0 ? `<tr><td class="k">${escapeHtml(q.taxLabel || "Tax")} (${q.taxRate}%)</td><td class="v">${money(tax)}</td></tr>` : ""}
      <tr class="grand"><td class="k">Total</td><td class="v">${money(q.total)}</td></tr>
    </table>
    ${q.notes ? `<div class="notes">Notes: ${escapeHtml(q.notes)}</div>` : ""}
    <div class="notes">This is a quotation, not a tax invoice. Prices valid ${q.validUntil ? `until ${escapeHtml(q.validUntil)}` : "as stated"}.</div>
  </body></html>`;
}

export default function QuotesScreen() {
  const theme = useTheme();
  const router = useRouter();
  void router;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [biz, setBiz] = useState<any>({});
  const [taxRateDefault, setTaxRateDefault] = useState(0);
  const [taxLabelDefault, setTaxLabelDefault] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Quote | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [date, setDate] = useState(localTodayIso());
  const [validUntil, setValidUntil] = useState("");
  const [lines, setLines] = useState<Line[]>([{ description: "", qty: 1, rate: 0 }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [ql, s] = await Promise.all([api.listQuotes(), api.getSettings()]);
      setQuotes(ql as Quote[]);
      setCurrSym(getCurrencySymbol(s.currency || "USD"));
      setBiz(s);
      setTaxRateDefault(Number(s.taxRate) || 0);
      setTaxLabelDefault(s.taxLabel && s.taxLabel !== "None" ? s.taxLabel : "");
      loadedVersion.current = getDataVersion();
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);
  const loadedVersion = React.useRef<number>(-1);
  useFocusEffect(useCallback(() => {
    if (loadedVersion.current === getDataVersion()) return;
    const task = InteractionManager.runAfterInteractions(() => { load(); });
    return () => task.cancel();
  }, [load]));

  const subtotal = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0), [lines]);
  const taxAmt = +(subtotal * taxRateDefault / 100).toFixed(2);
  const total = +(subtotal + taxAmt).toFixed(2);

  const openNew = () => {
    setEditId(null); setClientName(""); setClientPhone(""); setDate(localTodayIso());
    setValidUntil(""); setLines([{ description: "", qty: 1, rate: 0 }]); setNotes(""); setErr(""); setShowForm(true);
  };
  const openEdit = (q: Quote) => {
    setEditId(q.id); setClientName(q.clientName); setClientPhone(q.clientPhone || "");
    setDate(q.date); setValidUntil(q.validUntil || ""); setLines(q.lines.length ? q.lines : [{ description: "", qty: 1, rate: 0 }]);
    setNotes(q.notes || ""); setErr(""); setShowForm(true); setSelected(null);
  };

  const updateLine = (i: number, field: keyof Line, val: string) => {
    setLines((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: field === "description" ? val : val as any } : l));
  };
  const addLine = () => setLines((p) => [...p, { description: "", qty: 1, rate: 0 }]);
  const removeLine = (i: number) => setLines((p) => p.filter((_, idx) => idx !== i));

  const save = async () => {
    setErr("");
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setErr(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    const validUntilIso = validUntil.trim() ? normalizeDateInput(validUntil) : "";
    if (validUntilIso && !isValidDateString(validUntilIso)) { setErr(`Couldn't read "${validUntil.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (validUntilIso !== validUntil) setValidUntil(validUntilIso);
    if (!clientName.trim()) { setErr("Enter a client name."); return; }
    const clean = lines.filter((l) => l.description.trim() || l.rate > 0);
    setSaving(true);
    try {
      if (clientName.trim()) {
        await api.findOrCreateParty(clientName.trim(), "customer", { phone: clientPhone.trim() });
      }
      const payload = { clientName: clientName.trim(), clientPhone: clientPhone.trim(), date: dateIso, validUntil: validUntilIso, lines: clean, taxRate: taxRateDefault, taxLabel: taxLabelDefault, notes: notes.trim() };
      if (editId) await api.updateQuote(editId, payload);
      else await api.createQuote(payload);
      setShowForm(false);
      await load();
    } catch (e: any) { setErr(e?.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const convert = (q: Quote) => {
    confirmAction(
      "Convert to Invoice",
      `Create an invoice from ${q.quoteNumber}? This bills ${q.clientName} ${currSym}${q.total.toFixed(2)} and adds the balance to their customer account.`,
      async () => {
        try {
          await api.convertQuoteToInvoice(q.id, { date: localTodayIso() });
          setSelected(null);
          await load();
          Alert.alert("Done", "Invoice created. Find it in Invoices.");
        } catch (e: any) { Alert.alert("Cannot convert", e?.message || "Failed."); }
      },
      "Convert"
    );
  };

  const setStatus = async (q: Quote, status: string) => {
    try { await api.setQuoteStatus(q.id, status); await load(); setSelected((s) => s ? { ...s, status } : s); } catch (e) { console.warn(e); }
  };

  const remove = (q: Quote) => {
    confirmAction(
      "Delete Quote",
      `Delete ${q.quoteNumber}?`,
      async () => { await api.deleteQuote(q.id); setSelected(null); await load(); },
      "Delete"
    );
  };

  const sharePdf = async (q: Quote) => {
    try {
      const { uri } = await Print.printToFileAsync({ html: buildHtml(q, biz, currSym) });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Quote ${q.quoteNumber}` });
    } catch (e) { console.warn(e); }
  };
  const shareWhatsApp = (q: Quote) => {
    const phone = (q.clientPhone || "").replace(/\D/g, "");
    const msg = `Hi ${q.clientName}, here's your quote ${q.quoteNumber} for ${currSym}${q.total.toFixed(2)} dated ${q.date}.${q.validUntil ? ` Valid until ${q.validUntil}.` : ""}`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  if (selected) {
    const sc = STATUS_COLOR[selected.status] || STATUS_COLOR.draft;
    const isConverted = selected.status === "converted";
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setSelected(null)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /><Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>Quotes</Text></Pressable>
          <Text style={styles.headerTitle}>{selected.quoteNumber}</Text>
          <Pressable onPress={() => openEdit(selected)} disabled={isConverted}><Ionicons name="create-outline" size={22} color={isConverted ? theme.color.muted : theme.color.brandPrimary} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.name}>{selected.clientName}</Text>
              <View style={[styles.badge, { backgroundColor: sc.bg }]}><Text style={{ color: sc.fg, fontSize: 11, fontWeight: "700" }}>{selected.status.toUpperCase()}</Text></View>
            </View>
            <Text style={styles.sub}>{selected.quoteNumber} · {shortDate(selected.date)}{selected.validUntil ? ` · Valid until ${shortDate(selected.validUntil)}` : ""}</Text>
            <View style={{ marginTop: 16 }}>
              {selected.lines.map((l, i) => (
                <View key={i} style={styles.lineRow}>
                  <Text style={styles.lineDesc}>{l.description || "—"}</Text>
                  <Text style={styles.lineAmt}>{l.qty} × {currSym}{l.rate.toFixed(2)} = {currSym}{(l.qty * l.rate).toFixed(2)}</Text>
                </View>
              ))}
            </View>
            <View style={styles.totalRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalVal}>{currSym}{selected.total.toFixed(2)}</Text></View>
          </Card>

          {!isConverted && (
            <Pressable onPress={() => convert(selected)} style={[styles.bigBtn, { backgroundColor: theme.color.brandPrimary }]}>
              <Ionicons name="swap-horizontal-outline" size={18} color="#fff" />
              <Text style={styles.bigBtnText}>Convert to Invoice</Text>
            </Pressable>
          )}
          {isConverted && <Text style={[styles.sub, { textAlign: "center", marginTop: 12 }]}>Already converted to an invoice ✓</Text>}

          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            <Pressable onPress={() => sharePdf(selected)} style={[styles.smBtn, { backgroundColor: theme.color.brandSecondary }]}><Ionicons name="document-outline" size={16} color="#fff" /><Text style={styles.smBtnText}>PDF</Text></Pressable>
            {selected.clientPhone ? <Pressable onPress={() => shareWhatsApp(selected)} style={[styles.smBtn, { backgroundColor: "#25D366" }]}><Ionicons name="logo-whatsapp" size={16} color="#fff" /><Text style={styles.smBtnText}>WhatsApp</Text></Pressable> : null}
          </View>

          {!isConverted && (
            <View style={styles.statusRow}>
              {["draft", "sent", "accepted", "expired"].map((st) => (
                <Pressable key={st} onPress={() => setStatus(selected, st)} style={[styles.statusChip, selected.status === st && styles.statusChipActive]}>
                  <Text style={[styles.statusChipText, selected.status === st && { color: "#fff" }]}>{st}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <Pressable onPress={() => remove(selected)} style={styles.deleteBtn}><Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 13 }}>Delete Quote</Text></Pressable>
          <View style={{ height: 60 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Quotes / Estimates</Text>
        <Pressable onPress={openNew}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        {quotes.length === 0 ? (
          <Text style={styles.empty}>No quotes yet. Tap + to create one, then convert it to an invoice when accepted.</Text>
        ) : quotes.map((q) => {
          const sc = STATUS_COLOR[q.status] || STATUS_COLOR.draft;
          return (
            <Pressable key={q.id} onPress={() => setSelected(q)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{q.clientName}</Text>
                <Text style={styles.sub}>{q.quoteNumber} · {shortDate(q.date)}</Text>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Text style={{ fontWeight: "700", fontSize: 15, color: theme.color.onSurface }}>{currSym}{q.total.toFixed(2)}</Text>
                <View style={[styles.badge, { backgroundColor: sc.bg }]}><Text style={{ fontSize: 10, fontWeight: "700", color: sc.fg }}>{q.status.toUpperCase()}</Text></View>
              </View>
            </Pressable>
          );
        })}
        <View style={{ height: 60 }} />
      </ScrollView>

      <Modal visible={showForm} transparent={true} animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={() => setShowForm(false)}>
        <View style={{ flex: 1, alignItems: "center", backgroundColor: Platform.OS === "web" ? "rgba(0,0,0,0.1)" : "transparent" }}>
          <View style={{ flex: 1, width: "100%", maxWidth: 480, backgroundColor: Platform.OS === "web" ? "rgba(0,0,0,0.8)" : theme.color.surface, justifyContent: "flex-end" }}>
            <SafeAreaView style={[styles.container, { width: "100%", maxHeight: Platform.OS === "web" ? "95%" : "100%", borderTopLeftRadius: Platform.OS === "web" ? 20 : 0, borderTopRightRadius: Platform.OS === "web" ? 20 : 0, overflow: "hidden", borderWidth: Platform.OS === "web" ? 1 : 0, borderColor: theme.color.border }]} edges={["top"]}>
          <View style={styles.headerBar}>
            <Pressable onPress={() => setShowForm(false)}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
            <Text style={styles.headerTitle}>{editId ? "Edit Quote" : "New Quote"}</Text>
            <View style={{ width: 26 }} />
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
              <Card>
                <PartyAutocompleteInput
                  label="Client Name *"
                  value={clientName}
                  onChangeText={setClientName}
                  placeholder="Full name or business"
                  roleFilter="all"
                />
                <Text style={[styles.label, { marginTop: 12 }]}>Client Phone</Text>
                <TextInput value={clientPhone} onChangeText={setClientPhone} placeholder="+1 555 000 0000" placeholderTextColor={theme.color.muted} keyboardType="phone-pad" style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Date</Text>
                <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Valid Until</Text>
                <TextInput value={validUntil} onChangeText={setValidUntil} placeholder="YYYY-MM-DD (optional)" placeholderTextColor={theme.color.muted} style={styles.input} />
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Line Items</Text>
                {lines.map((l, i) => (
                  <View key={i} style={styles.lineEdit}>
                    <TextInput value={l.description} onChangeText={(v) => updateLine(i, "description", v)} placeholder="Description" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 2 }]} />
                    <TextInput value={l.qty ? String(l.qty) : ""} onChangeText={(v) => updateLine(i, "qty", v)} placeholder="Qty" keyboardType="decimal-pad" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} />
                    <TextInput value={l.rate ? String(l.rate) : ""} onChangeText={(v) => updateLine(i, "rate", v)} placeholder="Rate" keyboardType="decimal-pad" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} />
                    {lines.length > 1 ? <Pressable onPress={() => removeLine(i)}><Ionicons name="close-circle" size={22} color={theme.color.error} /></Pressable> : null}
                  </View>
                ))}
                <Pressable onPress={addLine} style={styles.addLine}><Ionicons name="add" size={18} color={theme.color.brandPrimary} /><Text style={{ color: theme.color.brandPrimary, fontWeight: "600" }}>Add line</Text></Pressable>
                <View style={styles.totalRow}><Text style={styles.totalLabel}>Total{taxRateDefault ? ` (incl. ${taxLabelDefault || "tax"} ${taxRateDefault}%)` : ""}</Text><Text style={styles.totalVal}>{currSym}{total.toFixed(2)}</Text></View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Notes</Text>
                <TextInput value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
              </Card>

              {err ? <Text style={styles.error}>{err}</Text> : null}
              <Pressable onPress={save} disabled={saving} style={({ pressed }) => [styles.bigBtn, { backgroundColor: theme.color.brandPrimary, marginTop: theme.spacing.lg }, (pressed || saving) && { opacity: 0.85 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.bigBtnText}>{editId ? "Save Quote" : "Create Quote"}</Text>}
              </Pressable>
              <View style={{ height: 40 }} />
            </ScrollView>
          </KeyboardAvoidingView>
            </SafeAreaView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    name: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    sub: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
    empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
    lineRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.color.border },
    lineDesc: { fontSize: 13, color: theme.color.onSurface, flex: 1 },
    lineAmt: { fontSize: 13, color: theme.color.muted },
    totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, paddingTop: 10, borderTopWidth: 2, borderTopColor: theme.color.brandPrimary },
    totalLabel: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface },
    totalVal: { fontSize: 16, fontWeight: "700", color: theme.color.brandPrimary },
    lineEdit: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
    addLine: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10 },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    bigBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: theme.spacing.lg, borderRadius: theme.radius.md, marginTop: theme.spacing.md },
    bigBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
    smBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 12, borderRadius: theme.radius.md },
    smBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 16 },
    statusChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    statusChipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    statusChipText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface, textTransform: "capitalize" },
    deleteBtn: { alignItems: "center", padding: theme.spacing.lg, marginTop: theme.spacing.md },
  });
}
