import React, { useCallback, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { amountToWords } from "@/src/utils/numberToWords";
import { getCurrencySymbol } from "@/src/db/local";
import { printHtml } from "@/src/utils/print";
import { confirmAction, showAlert } from "@/src/utils/alerts";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";

type Debtor = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  payments: { id: string; amount: number; date: string; notes?: string }[];
  totalInvoiced?: number;
  totalPaid?: number;
  balance?: number;
};

function escapeHtml(v: any): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildStatementHtml(
  debtor: any, statement: any, biz: any, sym: string,
  themeColors?: any, currencyCode: string = 'USD'
) {
  const money = (n: number) => `${sym}${(Number(n) || 0).toFixed(2)}`;
  const balance = Number(debtor.balance || 0);
  const totalInWords = amountToWords(Math.abs(balance), currencyCode);
  const today = new Date().toLocaleDateString();

  let primary = "#000000";
  let accent = "#FDBA21";
  
  if (biz.invoiceTheme === "amoled_blue") {
    accent = "#3498db";
  } else if (biz.invoiceTheme === "emerald") {
    primary = "#1C4030";
    accent = "#2ecc71";
  }

  const rows = (statement?.ledger || []).map((r: any, i: number) => {
    const label = r.kind === "invoice" ? "Invoice" : r.kind === "payment" ? "Payment" : r.kind === "credit_note" ? "Credit Note" : r.kind === "debit_note" ? "Debit Note" : "Entry";
    const dateStr = r.date ? shortDate(r.date) : '';
    return `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td>${escapeHtml(dateStr)}</td>
      <td>${escapeHtml(label)}</td>
      <td>${escapeHtml(r.ref || '-')}</td>
      <td class="right">${r.debit ? money(r.debit) : '-'}</td>
      <td class="right">${r.credit ? money(r.credit) : '-'}</td>
      <td class="right" style="font-weight:600">${money(r.balance)}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; color: #333; background: #fff; }
    .page-container { width: 100%; max-width: 800px; margin: 0 auto; background: #fff; position: relative; }
    .header { padding: 30px 40px; background: ${primary}; color: #fff; display: flex; justify-content: space-between; }
    .title { font-size: 24px; font-weight: 800; color: ${accent}; text-transform: uppercase; }
    .client { font-size: 14px; margin-top: 6px; }
    .content { padding: 30px 40px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
    th { background: ${primary}; color: #fff; padding: 10px; text-align: left; text-transform: uppercase; }
    td { padding: 10px; border-bottom: 1px solid #eee; }
    .right { text-align: right; }
    .totals { width: 280px; margin-left: auto; font-size: 13px; }
    .tot-row { display: flex; justify-content: space-between; padding: 6px 0; }
    .grand { background: ${accent}; color: #111; font-weight: 800; padding: 10px; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="header">
      <div>
        <div class="title">STATEMENT OF ACCOUNT</div>
        <div class="client">${escapeHtml(debtor.name)}</div>
      </div>
      <div style="text-align:right">
        <div>Date: ${today}</div>
        <div>Balance: ${money(balance)}</div>
      </div>
    </div>
    <div class="content">
      <table>
        <thead>
          <tr><th>Date</th><th>Type</th><th>Ref</th><th class="right">Debit</th><th class="right">Credit</th><th class="right">Balance</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="totals">
        <div class="tot-row"><span>Total Invoiced</span><span>${money(debtor.totalInvoiced || 0)}</span></div>
        <div class="tot-row"><span>Total Paid</span><span>${money(debtor.totalPaid || 0)}</span></div>
        <div class="tot-row grand"><span>Balance Due</span><span>${money(balance)}</span></div>
        <div style="font-size:11px;font-style:italic;margin-top:8px;text-align:right">${totalInWords}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export default function CustomerDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; customerId?: string }>();
  const id = params.id || params.customerId;

  const [selected, setSelected] = useState<Debtor | null>(null);
  const [statement, setStatement] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState("$");
  const [currCode, setCurrCode] = useState("USD");
  const [biz, setBiz] = useState<any>({});
  const [deleting, setDeleting] = useState(false);

  // Note Modal state (Debit / Credit Note)
  const [noteKind, setNoteKind] = useState<"debit" | "credit" | null>(null);
  const [noteAmount, setNoteAmount] = useState("");
  const [noteReason, setNoteReason] = useState("");
  const [noteNotes, setNoteNotes] = useState("");
  const [noteDate, setNoteDate] = useState(localTodayIso());
  const [noteReference, setNoteReference] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState("");

  const closeNote = () => {
    setNoteKind(null);
    setEditingNoteId(null);
    setNoteAmount("");
    setNoteDate(localTodayIso());
    setNoteReference("");
    setNoteReason("");
    setNoteNotes("");
    setNoteError("");
  };

  const openNewNote = () => {
    closeNote();
    setNoteKind("credit");
  };

  const openEditNote = (row: any, amount: number) => {
    closeNote();
    setEditingNoteId(row.id);
    setNoteKind(row.kind === "credit_note" ? "credit" : "debit");
    setNoteAmount(String(row.amount || amount));
    setNoteDate(row.date || localTodayIso());
    setNoteReference(row.ref || "");
    setNoteReason(row.reason || "");
    setNoteNotes(row.notes || "");
  };

  const load = useCallback(async () => {
    try {
      const [customer, settings] = await Promise.all([id ? api.getCustomer(id) : null, api.getSettings()]);
      setBiz(settings);
      const code = settings.currency || "USD";
      setCurrCode(code);
      setCurrency(getCurrencySymbol(code));

      if (customer) {
        const invoiced = Number((customer as any).totalInvoiced) || 0;
        const paid = Number((customer as any).totalPaid) || 0;
        const found = { ...(customer as any), totalInvoiced: invoiced, totalPaid: paid, balance: (customer as any).balance ?? invoiced - paid };
        setSelected(found);
        setStatement(await api.getDebtorStatement(found.id));
      } else {
        setSelected(null);
        setStatement(null);
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shareStatementPdf = async () => {
    if (!selected || !statement) return;
    try {
      const html = buildStatementHtml(selected, statement, biz, currency, theme.color, currCode);
      if (Platform.OS === 'web') {
        await printHtml(html, `Statement — ${selected.name}`);
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${selected.name}` });
      }
    } catch (e: any) { showAlert("Statement Error", e?.message || "Could not generate statement PDF."); }
  };

  const printStatement = async () => {
    if (!selected || !statement) return;
    try {
      await printHtml(buildStatementHtml(selected, statement, biz, currency, theme.color, currCode));
    } catch (e: any) { showAlert("Print Error", e?.message || "Could not print statement."); }
  };

  const deleteCustomer = () => {
    if (!selected) return;
    confirmAction(
      "Delete Customer?",
      `Remove ${selected.name}? This will remove this customer from your active records.`,
      async () => {
        setDeleting(true);
        try {
          await api.deleteDebtor(selected.id);
          router.back();
        } catch (e: any) {
          showAlert("Cannot Delete Customer", e?.message || "Could not delete customer.");
        } finally { setDeleting(false); }
      }
    );
  };

  const saveNote = async () => {
    if (!selected || !noteKind) return;
    const amt = parseFloat(noteAmount);
    if (!amt || amt <= 0) { setNoteError("Enter a valid amount."); return; }
    const dateIso = normalizeDateInput(noteDate);
    if (!isValidDateString(dateIso)) { setNoteError("Enter a valid date using YYYY-MM-DD."); return; }
    setNoteBusy(true); setNoteError("");
    try {
      const payload = { customerId: selected.id, customerName: selected.name, date: dateIso, amount: amt, reference: noteReference.trim(), reason: noteReason.trim(), notes: noteNotes.trim() };
      if (editingNoteId) await api.updateNote(editingNoteId, payload);
      else if (noteKind === "credit") await api.createCreditNote(payload);
      else await api.createDebitNote(payload);
      closeNote();
      await load();
    } catch (e: any) {
      setNoteError(e?.message || "Failed to save note.");
    } finally { setNoteBusy(false); }
  };

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  if (!selected) {
    return <SafeAreaView style={styles.container}><Text style={{ padding: 20, color: theme.color.onSurface }}>Customer not found</Text></SafeAreaView>;
  }

  const initials = selected.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
  const owing = Number(selected.balance || 0) > 0;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back" onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Customer Detail</Text>
        <Pressable testID="btn-edit-customer" onPress={() => router.push({ pathname: "/party-form", params: { id: selected.id, type: "customer" } })} hitSlop={10}>
          <Ionicons name="pencil-outline" size={22} color={theme.color.brandPrimary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <Card>
          <View style={styles.top}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} testID="customer-detail-name">{selected.name}</Text>
              <Text style={styles.sub}>{selected.phone || "No phone"}{selected.email ? ` • ${selected.email}` : ""}</Text>
            </View>
          </View>

          <View style={styles.balBox}>
            <Text style={styles.balLabel}>OUTSTANDING BALANCE</Text>
            <Text style={[styles.balValue, { color: owing ? theme.color.error : theme.color.success }]} testID="customer-balance">
              {currency}{Number(selected.balance || 0).toFixed(2)}
            </Text>
            <View style={styles.balGrid}>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Total Invoiced</Text>
                <Text style={styles.smVal}>{currency}{Number(selected.totalInvoiced || 0).toFixed(2)}</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Paid</Text>
                <Text style={styles.smVal}>{currency}{Number(selected.totalPaid || 0).toFixed(2)}</Text>
              </View>
            </View>
          </View>

          {/* Action Buttons 6-Button Grid (Matching Vendor Layout) */}
          <View style={styles.btnRow}>
            <Pressable
              testID="btn-receive-payment"
              onPress={() => router.push({ pathname: "/receipt-form", params: { customerId: selected.id } })}
              style={[styles.btnPill, { backgroundColor: theme.color.brandPrimary }]}
            >
              <Ionicons name="cash-outline" size={16} color="#fff" />
              <Text style={styles.btnPillTextText}>Receive Payment</Text>
            </Pressable>

            <Pressable
              testID="btn-statement-pdf"
              onPress={shareStatementPdf}
              style={[styles.btnPill, { backgroundColor: theme.color.brandPrimary }]}
            >
              <Ionicons name="document-text-outline" size={16} color="#fff" />
              <Text style={styles.btnPillTextText}>Statement PDF</Text>
            </Pressable>
          </View>

          <View style={styles.btnRow}>
            <Pressable
              testID="btn-reconcile"
              onPress={() => router.push({ pathname: "/reconcile", params: { customerId: selected.id } })}
              style={styles.btnOutline}
            >
              <Ionicons name="repeat-outline" size={15} color={theme.color.onSurface} />
              <Text style={styles.btnOutlineText}>Compare Statement</Text>
            </Pressable>

            <Pressable
              testID="btn-debit-credit"
              onPress={openNewNote}
              style={styles.btnOutline}
            >
              <Ionicons name="pricetag-outline" size={15} color={theme.color.onSurface} />
              <Text style={styles.btnOutlineText}>Debit / Credit Note</Text>
            </Pressable>
          </View>

          <View style={styles.btnRow}>
            <Pressable
              testID="btn-print"
              onPress={printStatement}
              style={[styles.btnOutline, { flex: 1 }]}
            >
              <Ionicons name="print-outline" size={15} color={theme.color.onSurface} />
              <Text style={styles.btnOutlineText}>Print</Text>
            </Pressable>

            <Pressable
              testID="btn-delete-customer"
              disabled={deleting}
              onPress={deleteCustomer}
              style={[styles.btnOutlineDanger, { flex: 1 }]}
            >
              <Ionicons name="trash-outline" size={15} color={theme.color.error} />
              <Text style={styles.btnOutlineDangerText}>Delete Customer</Text>
            </Pressable>
          </View>
        </Card>

        {/* Statement Timeline (Matching Vendor Layout) */}
        <Text style={styles.sectionTitle}>Statement Timeline</Text>
        {(statement?.ledger || []).length === 0 ? (
          <Card><Text style={{ fontSize: 13, color: theme.color.muted }}>No transactions recorded yet.</Text></Card>
        ) : (
          (statement?.ledger || []).map((r: any, idx: number) => {
            const isInv = r.kind === "invoice";
            const isCredit = r.kind === "credit_note" || r.kind === "receipt" || r.kind === "payment";
            const isNote = r.kind === "credit_note" || r.kind === "debit_note";
            const label = r.kind === "credit_note" ? "Credit Note" : r.kind === "debit_note" ? "Debit Note" : isInv ? "Invoice" : "Payment";
            const amt = r.debit || r.credit || 0;
            return (
              <Card key={idx} style={{ marginBottom: 8, padding: 12 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: isCredit ? theme.color.success : theme.color.error }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "700", color: theme.color.onSurface }}>
                        {label}{r.ref ? ` #${r.ref}` : ""} • {shortDate(r.date)}
                      </Text>
                      <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 2 }}>{[r.reason, r.notes].filter(Boolean).join(" — ") || "—"}</Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 14, fontWeight: "800", color: isCredit ? theme.color.success : theme.color.error }}>
                    {isCredit ? "-" : "+"}{currency}{amt.toFixed(2)}
                  </Text>
                  {isNote ? <Pressable accessibilityLabel={`Edit ${label}`} hitSlop={8} onPress={() => openEditNote(r, amt)}><Ionicons name="create-outline" size={18} color={theme.color.brandPrimary} /></Pressable> : null}
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>

      {/* Note Modal */}
      {noteKind ? (
        <Modal visible transparent animationType="fade" onRequestClose={closeNote}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 20 }}>
            <View style={{ backgroundColor: theme.color.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: theme.color.border }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginBottom: 12 }}>
                {editingNoteId ? "Edit" : "Issue"} {noteKind === "credit" ? "Credit" : "Debit"} Note for {selected.name}
              </Text>
              {!editingNoteId ? <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
                {(["credit", "debit"] as const).map((kind) => <Pressable key={kind} onPress={() => setNoteKind(kind)} style={{ flex: 1, padding: 10, borderRadius: 8, alignItems: "center", borderWidth: 1, borderColor: noteKind === kind ? theme.color.brandPrimary : theme.color.border, backgroundColor: noteKind === kind ? `${theme.color.brandPrimary}20` : theme.color.surfaceSecondary }}><Text style={{ color: noteKind === kind ? theme.color.brandPrimary : theme.color.onSurface, fontWeight: "700" }}>{kind === "credit" ? "Credit Note" : "Debit Note"}</Text></Pressable>)}
              </View> : null}
              <TextInput placeholder="Date (YYYY-MM-DD)" placeholderTextColor={theme.color.muted} value={noteDate} onChangeText={setNoteDate} style={{ backgroundColor: theme.color.surfaceSecondary, color: theme.color.onSurface, padding: 10, borderRadius: 8, marginBottom: 10 }} />
              <TextInput placeholder="Reference (optional)" placeholderTextColor={theme.color.muted} value={noteReference} onChangeText={setNoteReference} style={{ backgroundColor: theme.color.surfaceSecondary, color: theme.color.onSurface, padding: 10, borderRadius: 8, marginBottom: 10 }} />
              <TextInput
                placeholder="Amount"
                placeholderTextColor={theme.color.muted}
                keyboardType="numeric"
                value={noteAmount}
                onChangeText={setNoteAmount}
                style={{ backgroundColor: theme.color.surfaceSecondary, color: theme.color.onSurface, padding: 10, borderRadius: 8, marginBottom: 10 }}
              />
              <TextInput
                placeholder="Reason"
                placeholderTextColor={theme.color.muted}
                value={noteReason}
                onChangeText={setNoteReason}
                style={{ backgroundColor: theme.color.surfaceSecondary, color: theme.color.onSurface, padding: 10, borderRadius: 8, marginBottom: 16 }}
              />
              <TextInput placeholder="Notes (optional)" placeholderTextColor={theme.color.muted} value={noteNotes} onChangeText={setNoteNotes} style={{ backgroundColor: theme.color.surfaceSecondary, color: theme.color.onSurface, padding: 10, borderRadius: 8, marginBottom: 16 }} />
              {noteError ? <Text style={{ color: theme.color.error, fontSize: 12, marginBottom: 10 }}>{noteError}</Text> : null}
              <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
                <Pressable onPress={closeNote} style={{ padding: 10 }}>
                  <Text style={{ color: theme.color.muted, fontWeight: "600" }}>Cancel</Text>
                </Pressable>
                <Pressable onPress={saveNote} disabled={noteBusy} style={{ backgroundColor: theme.color.brandPrimary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 }}>
                  <Text style={{ color: "#fff", fontWeight: "700" }}>Save Note</Text>
                </Pressable>
              </View>
            </View>
          </View>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: theme.spacing.lg, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    top: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.brandTertiary || "#e0f2fe", justifyContent: "center", alignItems: "center" },
    avatarText: { fontSize: 16, fontWeight: "800", color: theme.color.brandPrimary },
    name: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface },
    sub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    balBox: { backgroundColor: theme.color.surfaceSecondary, borderRadius: 12, padding: 16, marginBottom: 16, alignItems: "center" },
    balLabel: { fontSize: 11, fontWeight: "700", color: theme.color.muted, letterSpacing: 0.5 },
    balValue: { fontSize: 26, fontWeight: "800", marginVertical: 6 },
    balGrid: { flexDirection: "row", justifyContent: "space-around", width: "100%", marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.color.border },
    smLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "600" },
    smVal: { fontSize: 14, fontWeight: "700", color: theme.color.onSurface, marginTop: 2 },
    btnRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
    btnPill: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 24 },
    btnPillTextText: { color: "#fff", fontWeight: "700", fontSize: 13 },
    btnOutline: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 24, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    btnOutlineText: { color: theme.color.onSurface, fontWeight: "700", fontSize: 12 },
    btnOutlineDanger: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 24, borderWidth: 1, borderColor: theme.color.error + "50", backgroundColor: theme.color.error + "10" },
    btnOutlineDangerText: { color: theme.color.error, fontWeight: "700", fontSize: 12 },
    sectionTitle: { fontSize: 16, fontWeight: "800", color: theme.color.onSurface, marginTop: 16, marginBottom: 12 },
  });
}
