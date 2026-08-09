import React, { useCallback, useMemo, useState } from "react";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal, Linking, InteractionManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { confirmAction } from "@/src/utils/alerts";
import { getDataVersion } from "@/src/utils/dataVersion";
import { useFocusEffect } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";

type Item = { description: string; qty: number };
type DeliveryNote = {
  id: string; noteNumber: string; clientName: string; clientPhone?: string;
  date: string; items: Item[]; vehicleNo?: string; status: string; notes?: string;
};

function escapeHtml(v: any): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildHtml(n: DeliveryNote, biz: any) {
  const rows = n.items.map((it, i) =>
    `<tr><td style="text-align:center">${i + 1}</td><td>${escapeHtml(it.description)}</td><td style="text-align:right">${it.qty}</td></tr>`
  ).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    body{font-family:sans-serif;padding:32px;color:#1a1a1a;font-size:14px}
    h1{font-size:22px;color:#1C4030;margin:0}
    .title{font-size:24px;color:#555;font-weight:700;letter-spacing:1px}
    .biz{color:#555;font-size:12px;margin-top:4px;line-height:1.5}
    .row{display:flex;justify-content:space-between;margin-top:28px;gap:24px}
    .label{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:.5px}
    .val{font-size:14px;font-weight:600;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-top:24px}
    th{background:#2b2b2b;color:#fff;padding:9px 8px;text-align:left;font-size:12px}
    td{padding:9px 8px;border-bottom:1px solid #eee;font-size:13px}
    .sign{margin-top:60px;display:flex;justify-content:space-between}
    .sign div{border-top:1px solid #999;padding-top:6px;width:40%;text-align:center;font-size:12px;color:#555}
    .notes{margin-top:24px;font-size:12px;color:#555}
  </style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="display:flex;align-items:flex-start;gap:12px">
        ${biz.logo ? `<img src="${biz.logo}" style="width:64px;height:64px;border-radius:8px;object-fit:cover"/>` : ""}
        <div><h1>${escapeHtml(biz.businessName || "Delivery Note")}</h1><div class="biz">${escapeHtml([biz.businessAddress, biz.businessPhone, biz.businessEmail].filter(Boolean).join(" · "))}</div></div>
      </div>
      <div style="text-align:right">
        <div class="title">DELIVERY NOTE</div>
        <div class="val" style="margin-top:6px">${n.noteNumber}</div>
      </div>
    </div>
    <div class="row">
      <div><div class="label">Deliver To</div><div class="val">${escapeHtml(n.clientName)}</div>${n.clientPhone ? `<div style="font-size:12px;color:#555">${escapeHtml(n.clientPhone)}</div>` : ""}</div>
      <div style="text-align:right"><div><span class="label">Date :</span> <span class="val" style="display:inline">${escapeHtml(n.date)}</span></div>${n.vehicleNo ? `<div><span class="label">Vehicle :</span> <span class="val" style="display:inline">${escapeHtml(n.vehicleNo)}</span></div>` : ""}<div><span class="label">Status :</span> <span class="val" style="display:inline">${escapeHtml(n.status.toUpperCase())}</span></div></div>
    </div>
    <table><thead><tr><th style="text-align:center">#</th><th>Item &amp; Description</th><th style="text-align:right">Qty</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${n.notes ? `<div class="notes">Notes: ${escapeHtml(n.notes)}</div>` : ""}
    <div class="notes">This is a delivery note (challan) recording goods movement only — not a tax invoice or a demand for payment.</div>
    <div class="sign"><div>Received By</div><div>Authorised Signature</div></div>
  </body></html>`;
}

export default function DeliveryNotesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [biz, setBiz] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DeliveryNote | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [date, setDate] = useState(localTodayIso());
  const [vehicleNo, setVehicleNo] = useState("");
  const [items, setItems] = useState<Item[]>([{ description: "", qty: 1 }]);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([api.listDeliveryNotes(), api.getSettings()]);
      setNotes(list as DeliveryNote[]);
      setBiz(s);
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

  const openNew = () => {
    setEditId(null); setClientName(""); setClientPhone(""); setDate(localTodayIso());
    setVehicleNo(""); setItems([{ description: "", qty: 1 }]); setNoteText(""); setErr(""); setShowForm(true);
  };
  const openEdit = (n: DeliveryNote) => {
    setEditId(n.id); setClientName(n.clientName); setClientPhone(n.clientPhone || "");
    setDate(n.date); setVehicleNo(n.vehicleNo || ""); setItems(n.items.length ? n.items : [{ description: "", qty: 1 }]);
    setNoteText(n.notes || ""); setErr(""); setShowForm(true); setSelected(null);
  };

  const updateItem = (i: number, field: keyof Item, val: string) => {
    setItems((prev) => prev.map((it, idx) => idx === i ? { ...it, [field]: field === "description" ? val : val as any } : it));
  };
  const addItem = () => setItems((p) => [...p, { description: "", qty: 1 }]);
  const removeItem = (i: number) => setItems((p) => p.filter((_, idx) => idx !== i));

  const save = async () => {
    setErr("");
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setErr(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    if (!clientName.trim()) { setErr("Enter a customer name."); return; }
    const clean = items.filter((it) => it.description.trim() || it.qty > 0);
    setSaving(true);
    try {
      if (clientName.trim()) {
        await api.findOrCreateParty(clientName.trim(), "customer", { phone: clientPhone.trim() });
      }
      const payload = { clientName: clientName.trim(), clientPhone: clientPhone.trim(), date: dateIso, vehicleNo: vehicleNo.trim(), items: clean, notes: noteText.trim() };
      if (editId) await api.updateDeliveryNote(editId, payload);
      else await api.createDeliveryNote(payload);
      setShowForm(false);
      await load();
    } catch (e: any) { setErr(e?.message || "Failed to save."); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (n: DeliveryNote) => {
    try {
      await api.updateDeliveryNote(n.id, { status: n.status === "delivered" ? "pending" : "delivered" });
      await load();
      setSelected((s) => s ? { ...s, status: s.status === "delivered" ? "pending" : "delivered" } : s);
    } catch (e) { console.warn(e); }
  };

  const remove = (n: DeliveryNote) => {
    confirmAction(
      "Delete Delivery Note",
      `Delete ${n.noteNumber}?`,
      async () => { await api.deleteDeliveryNote(n.id); setSelected(null); await load(); },
      "Delete"
    );
  };

  const sharePdf = async (n: DeliveryNote) => {
    try {
      const { uri } = await Print.printToFileAsync({ html: buildHtml(n, biz) });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Delivery ${n.noteNumber}` });
    } catch (e) { console.warn(e); }
  };
  const shareWhatsApp = (n: DeliveryNote) => {
    const phone = (n.clientPhone || "").replace(/\D/g, "");
    const msg = `Hi ${n.clientName}, delivery note ${n.noteNumber} dated ${n.date} for ${n.items.length} item(s).`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  if (selected) {
    const delivered = selected.status === "delivered";
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setSelected(null)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /><Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>Delivery Notes</Text></Pressable>
          <Text style={styles.headerTitle}>{selected.noteNumber}</Text>
          <Pressable onPress={() => openEdit(selected)}><Ionicons name="create-outline" size={22} color={theme.color.brandPrimary} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.name}>{selected.clientName}</Text>
              <View style={[styles.badge, { backgroundColor: delivered ? "#DCE8DC" : "#F0E4D0" }]}><Text style={{ color: delivered ? "#1C4030" : "#8A5A2A", fontSize: 11, fontWeight: "700" }}>{selected.status.toUpperCase()}</Text></View>
            </View>
            <Text style={styles.sub}>{selected.noteNumber} · {shortDate(selected.date)}{selected.vehicleNo ? ` · ${selected.vehicleNo}` : ""}</Text>
            <View style={{ marginTop: 16 }}>
              {selected.items.map((it, i) => (
                <View key={i} style={styles.lineRow}>
                  <Text style={styles.lineDesc}>{it.description || "—"}</Text>
                  <Text style={styles.lineAmt}>Qty: {it.qty}</Text>
                </View>
              ))}
            </View>
          </Card>

          <Pressable onPress={() => toggleStatus(selected)} style={[styles.bigBtn, { backgroundColor: delivered ? theme.color.brandSecondary : theme.color.brandPrimary }]}>
            <Ionicons name={delivered ? "arrow-undo-outline" : "checkmark-done-outline"} size={18} color="#fff" />
            <Text style={styles.bigBtnText}>{delivered ? "Mark Pending" : "Mark Delivered"}</Text>
          </Pressable>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            <Pressable onPress={() => sharePdf(selected)} style={[styles.smBtn, { backgroundColor: theme.color.brandSecondary }]}><Ionicons name="document-outline" size={16} color="#fff" /><Text style={styles.smBtnText}>PDF</Text></Pressable>
            {selected.clientPhone ? <Pressable onPress={() => shareWhatsApp(selected)} style={[styles.smBtn, { backgroundColor: "#25D366" }]}><Ionicons name="logo-whatsapp" size={16} color="#fff" /><Text style={styles.smBtnText}>WhatsApp</Text></Pressable> : null}
          </View>
          <Pressable onPress={() => remove(selected)} style={styles.deleteBtn}><Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 13 }}>Delete Delivery Note</Text></Pressable>
          <View style={{ height: 60 }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Delivery Notes</Text>
        <Pressable onPress={openNew}><Ionicons name="add" size={28} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        {notes.length === 0 ? (
          <Text style={styles.empty}>No delivery notes yet. Tap + to record goods handed over to a customer.</Text>
        ) : notes.map((n) => {
          const delivered = n.status === "delivered";
          return (
            <Pressable key={n.id} onPress={() => setSelected(n)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{n.clientName}</Text>
                <Text style={styles.sub}>{n.noteNumber} · {shortDate(n.date)} · {n.items.length} item(s)</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: delivered ? "#DCE8DC" : "#F0E4D0" }]}><Text style={{ fontSize: 10, fontWeight: "700", color: delivered ? "#1C4030" : "#8A5A2A" }}>{n.status.toUpperCase()}</Text></View>
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
            <Text style={styles.headerTitle}>{editId ? "Edit Delivery Note" : "New Delivery Note"}</Text>
            <View style={{ width: 26 }} />
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
              <Card>
                <PartyAutocompleteInput
                  label="Customer Name *"
                  value={clientName}
                  onChangeText={setClientName}
                  placeholder="Full name or business"
                  roleFilter="all"
                />
                <Text style={[styles.label, { marginTop: 12 }]}>Customer Phone</Text>
                <TextInput value={clientPhone} onChangeText={setClientPhone} placeholder="+1 555 000 0000" placeholderTextColor={theme.color.muted} keyboardType="phone-pad" style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Date</Text>
                <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Vehicle No.</Text>
                <TextInput value={vehicleNo} onChangeText={setVehicleNo} placeholder="Optional" placeholderTextColor={theme.color.muted} style={styles.input} />
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Items (quantity only — no prices)</Text>
                {items.map((it, i) => (
                  <View key={i} style={styles.lineEdit}>
                    <TextInput value={it.description} onChangeText={(v) => updateItem(i, "description", v)} placeholder="Item description" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 3 }]} />
                    <TextInput value={it.qty ? String(it.qty) : ""} onChangeText={(v) => updateItem(i, "qty", v)} placeholder="Qty" keyboardType="decimal-pad" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1 }]} />
                    {items.length > 1 ? <Pressable onPress={() => removeItem(i)}><Ionicons name="close-circle" size={22} color={theme.color.error} /></Pressable> : null}
                  </View>
                ))}
                <Pressable onPress={addItem} style={styles.addLine}><Ionicons name="add" size={18} color={theme.color.brandPrimary} /><Text style={{ color: theme.color.brandPrimary, fontWeight: "600" }}>Add item</Text></Pressable>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Notes</Text>
                <TextInput value={noteText} onChangeText={setNoteText} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
              </Card>

              {err ? <Text style={styles.error}>{err}</Text> : null}
              <Pressable onPress={save} disabled={saving} style={({ pressed }) => [styles.bigBtn, { backgroundColor: theme.color.brandPrimary, marginTop: theme.spacing.lg }, (pressed || saving) && { opacity: 0.85 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.bigBtnText}>{editId ? "Save" : "Create Delivery Note"}</Text>}
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
    lineEdit: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
    addLine: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10 },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    bigBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: theme.spacing.lg, borderRadius: theme.radius.md, marginTop: theme.spacing.md },
    bigBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
    smBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: 12, borderRadius: theme.radius.md },
    smBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    deleteBtn: { alignItems: "center", padding: theme.spacing.lg, marginTop: theme.spacing.md },
  });
}
