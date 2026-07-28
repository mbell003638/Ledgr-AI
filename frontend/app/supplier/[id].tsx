import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Platform, Modal, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { fmt as fmtBase, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { getCurrencySymbol } from "@/src/db/local";
import { printHtml } from "@/src/utils/print";
import { confirmAction, showAlert } from "@/src/utils/alerts";

export default function SupplierDetail() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [biz, setBiz] = useState<any>({});
  const [currCode, setCurrCode] = useState("USD");
  const [currency, setCurrency] = useState("$");
  const [deleting, setDeleting] = useState(false);

  // Note Modal state (Debit / Credit Note)
  const [noteKind, setNoteKind] = useState<"debit" | "credit" | null>(null);
  const [noteAmount, setNoteAmount] = useState("");
  const [noteReason, setNoteReason] = useState("");
  const [noteNotes, setNoteNotes] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [r, settings] = await Promise.all([api.getSupplier(id), api.getSettings()]);
      setData(r);
      setBiz(settings);
      const code = settings.currency || "USD";
      setCurrCode(code);
      setCurrency(getCurrencySymbol(code));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const fmt = (val: number | null | undefined) => fmtBase(val, currency);

  const buildStatementHtml = (supplier: any) => {
    const primary = "#000000";
    const accent = "#FDBA21";
    const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const timeline = [
      ...(supplier.bills || []).map((b: any) => ({ ...b, kind: "bill" })),
      ...(supplier.payments || []).map((p: any) => ({ ...p, kind: "payment" })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));

    let runningBalance = 0;
    const tableRows = timeline.map((item, i) => {
      if (item.kind === 'bill') runningBalance += Number(item.amount) || 0;
      else runningBalance -= Number(item.amount) || 0;
      
      return `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">
        <td>${esc(shortDate(item.date))}</td>
        <td>${esc(item.kind === 'bill' ? 'Bill #' + (item.invoiceNo || item.id) : 'Payment')}</td>
        <td>${esc(item.notes || item.reference || '—')}</td>
        <td style="text-align:right">${item.kind === 'bill' ? fmtBase(item.amount, currency) : '—'}</td>
        <td style="text-align:right">${item.kind === 'payment' ? fmtBase(item.amount, currency) : '—'}</td>
        <td style="text-align:right;font-weight:700">${fmtBase(runningBalance, currency)}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Vendor Statement — ${esc(supplier.name)}</title>
  <style>
    @media print {
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      body { background: #fff !important; padding: 0 !important; }
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; color: #333; background: #fff; }
    .page-container { width: 100%; max-width: 800px; margin: 0 auto; background: #fff; position: relative; }
    .top-bg-container { position: absolute; top: 0; left: 0; width: 100%; height: 264px; z-index: 0; overflow: hidden; }
    .bg-dark { position: absolute; top: 0; left: 0; width: 100%; height: 160px; background: ${primary}; }
    .bg-white-slant { position: absolute; top: 0; left: 40%; width: 12px; height: 160px; background: #fff; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-slant { position: absolute; top: 160px; left: calc(40% - 46px); width: 100px; height: 100px; background: ${accent}; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-rect { position: absolute; top: 160px; left: calc(40% - 46px); right: 0; height: 100px; background: ${accent}; }
    .bg-yellow-border { position: absolute; top: 260px; left: 0; right: 0; height: 4px; background: ${accent}; }
    .header-content { display: flex; height: 160px; position: relative; z-index: 10; }
    .header-left { width: 40%; padding: 40px; display: flex; align-items: center; justify-content: center; }
    .header-logo-text { font-size: 40px; font-weight: 900; color: #fff; letter-spacing: 2px; text-transform: uppercase; }
    .header-logo { max-height: 80px; max-width: 180px; object-fit: contain; }
    .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; }
    .doc-to-title { color: ${accent}; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .biz-name { font-size: 16px; font-weight: 700; color: #ffffff; margin-bottom: 4px; text-transform: uppercase; }
    .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
    .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
    .doc-heading { font-size: 28px; font-weight: 900; color: #111; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
    .banner-right { width: 60%; display: flex; align-items: center; padding: 0 40px 0 20px; }
    .banner-col { text-align: left; border-left: 1.5px solid rgba(0,0,0,0.6); padding-left: 15px; flex: 1; margin-left: 10px; }
    .banner-col:first-child { border-left: none; padding-left: 0; margin-left: 0; }
    .banner-label { font-size: 11px; font-weight: 700; color: #222; }
    .banner-val { font-size: 14px; font-weight: 800; margin-top: 4px; color: #111; }
    .content { padding: 40px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
    th { background: ${primary}; color: #ffffff; padding: 12px 14px; text-align: left; font-size: 11px; text-transform: uppercase; font-weight: 700; }
    td { padding: 12px 14px; border-bottom: 1px solid #eee; color: #333; font-weight: 500; }
    tr.even td { background: #fff; }
    tr.odd td { background: #f9f9f9; }
    .footer-bar { background: ${primary}; color: #fff; padding: 24px 40px; font-size: 10px; border-top: 6px solid ${accent}; }
    .thank-you { color: ${accent}; font-weight: 800; font-size: 13px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="top-bg-container">
      <div class="bg-dark"></div>
      <div class="bg-white-slant"></div>
      <div class="bg-yellow-slant"></div>
      <div class="bg-yellow-rect"></div>
      <div class="bg-yellow-border"></div>
    </div>

    <div class="header-content">
      <div class="header-left">
        ${biz.logo ? `<img src="${biz.logo}" class="header-logo" />` : `<div class="header-logo-text">${esc(biz.businessName || "Ledgr")}</div>`}
      </div>
      <div class="header-right">
        <div class="doc-to-title">VENDOR STATEMENT FOR</div>
        <div class="biz-name">${esc(supplier.name)}</div>
        ${supplier.phone ? `<div style="font-size:11px;color:#fff;">P: ${esc(supplier.phone)}</div>` : ''}
        ${supplier.email ? `<div style="font-size:11px;color:#fff;">E: ${esc(supplier.email)}</div>` : ''}
      </div>
    </div>

    <div class="banner-content">
      <div class="banner-left">
        <h1 class="doc-heading">STATEMENT</h1>
      </div>
      <div class="banner-right">
        <div class="banner-col">
          <div class="banner-label">Date</div>
          <div class="banner-val">${new Date().toLocaleDateString()}</div>
        </div>
        <div class="banner-col">
          <div class="banner-label">Balance Payable</div>
          <div class="banner-val">${fmtBase(supplier.balance, currency)}</div>
        </div>
      </div>
    </div>

    <div class="content">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Type / Ref</th>
            <th>Notes</th>
            <th style="text-align:right">Bill Amount</th>
            <th style="text-align:right">Payment</th>
            <th style="text-align:right">Balance</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="6" style="text-align:center">No transactions recorded</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <div class="thank-you">Thank you for your business</div>
      <div>Official vendor account statement for ${esc(supplier.name)} &middot; Generated by Ledgr</div>
    </div>
  </div>
</body>
</html>`;
  };

  const shareStatementPdf = async () => {
    if (!data) return;
    try {
      const html = buildStatementHtml(data);
      if (Platform.OS === 'web') {
        await printHtml(html, `Statement — ${data.name}`);
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${data.name}` });
      }
    } catch (e: any) {
      showAlert("Statement Error", e?.message || "Could not generate supplier statement PDF.");
    }
  };

  const printStatement = async () => {
    if (!data) return;
    try {
      const html = buildStatementHtml(data);
      await printHtml(html, `Statement — ${data.name}`);
    } catch (e: any) {
      showAlert("Print Error", e?.message || "Could not print supplier statement.");
    }
  };

  const deleteSupplier = () => {
    if (!data) return;
    confirmAction(
      "Delete Supplier?",
      `Remove ${data.name}? This will remove this vendor from your active suppliers list.`,
      async () => {
        setDeleting(true);
        try {
          await api.deleteSupplier(data.id);
          router.back();
        } catch (e: any) {
          showAlert("Cannot Delete Supplier", e?.message || "Could not delete supplier.");
        } finally { setDeleting(false); }
      }
    );
  };

  const saveNote = async () => {
    if (!data || !noteKind) return;
    const amt = parseFloat(noteAmount);
    if (!amt || amt <= 0) { setNoteError("Enter a valid amount."); return; }
    setNoteBusy(true); setNoteError("");
    try {
      const payload = { supplierId: data.id, supplierName: data.name, date: new Date().toISOString().slice(0, 10), amount: amt, reason: noteReason, notes: noteNotes.trim() };
      if (noteKind === "credit") await api.createCreditNote(payload);
      else await api.createDebitNote(payload);
      setNoteKind(null); setNoteAmount(""); setNoteNotes(""); setNoteReason("");
      await load();
    } catch (e: any) {
      setNoteError(e?.message || "Failed to save note.");
    } finally { setNoteBusy(false); }
  };

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }
  if (!data) {
    return <SafeAreaView style={styles.container}><Text style={{ padding: 20, color: theme.color.onSurface }}>Supplier not found</Text></SafeAreaView>;
  }

  const initials = data.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();
  const owing = (data.balance ?? 0) > 0;

  const timeline = [
    ...(data.bills || []).map((b: any) => ({ ...b, kind: "bill" })),
    ...(data.payments || []).map((p: any) => ({ ...p, kind: "payment" })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back" onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Vendor Detail</Text>
        <Pressable testID="btn-edit-supplier" onPress={() => router.push({ pathname: "/party-form", params: { id: id, type: "supplier" } })} hitSlop={10}>
          <Ionicons name="pencil-outline" size={22} color={theme.color.brandPrimary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <Card>
          <View style={styles.top}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} testID="supplier-detail-name">{data.name}</Text>
              <Text style={styles.sub}>{data.phone || "No phone"}{data.email ? ` • ${data.email}` : ""}</Text>
            </View>
          </View>

          <View style={styles.balBox}>
            <Text style={styles.balLabel}>OUTSTANDING BALANCE</Text>
            <Text style={[styles.balValue, { color: owing ? theme.color.error : theme.color.success }]} testID="supplier-balance">{fmt(data.balance)}</Text>
            <View style={styles.balGrid}>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Total Bills</Text>
                <Text style={styles.smVal}>{fmt(data.billsTotal)}</Text>
              </View>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.smLabel}>Paid</Text>
                <Text style={styles.smVal}>{fmt(data.paymentsTotal)}</Text>
              </View>
            </View>
          </View>

          {/* Action Buttons Bar */}
          <View style={styles.btnRow}>
            <Pressable
              testID="btn-pay-supplier"
              onPress={() => router.push({ pathname: "/payment-form", params: { supplierId: id } })}
              style={[styles.btnPill, { backgroundColor: theme.color.brandPrimary }]}
            >
              <Ionicons name="cash-outline" size={16} color="#fff" />
              <Text style={styles.btnPillTextText}>Pay Vendor</Text>
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
              onPress={() => router.push({ pathname: "/reconcile", params: { supplierId: id } })}
              style={styles.btnOutline}
            >
              <Ionicons name="repeat-outline" size={15} color={theme.color.onSurface} />
              <Text style={styles.btnOutlineText}>Compare Statement</Text>
            </Pressable>

            <Pressable
              testID="btn-debit-credit"
              onPress={() => setNoteKind("credit")}
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
              testID="btn-delete-supplier"
              onPress={deleteSupplier}
              disabled={deleting}
              style={[styles.btnOutline, { flex: 1, borderColor: theme.color.error }]}
            >
              <Ionicons name="trash-outline" size={15} color={theme.color.error} />
              <Text style={[styles.btnOutlineText, { color: theme.color.error }]}>Delete Vendor</Text>
            </Pressable>
          </View>
        </Card>

        <Text style={styles.section}>Statement Timeline</Text>
        {timeline.length === 0 ? (
          <Text style={styles.empty}>No transactions recorded for this vendor.</Text>
        ) : timeline.map((t) => (
          <View
            key={`${t.kind}-${t.id}`}
            testID={`tl-${t.kind}-${t.id}`}
            style={styles.timelineRow}
          >
            <View style={[styles.timelineDot, { backgroundColor: t.kind === "bill" ? theme.color.error : theme.color.success }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.tlTitle}>{t.kind === "bill" ? "Bill" : "Payment"} • {shortDate(t.date)}</Text>
              <Text style={styles.tlSub}>{t.notes || t.reference || t.invoiceNo || "—"}</Text>
            </View>
            <Text style={[styles.tlAmount, { color: t.kind === "bill" ? theme.color.error : theme.color.success }]}>
              {t.kind === "bill" ? "+" : "-"}{fmt(t.amount)}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginLeft: 8 }}>
              <Pressable
                accessibilityLabel="Edit"
                hitSlop={8}
                onPress={() => router.push({ pathname: t.kind === "bill" ? "/bill-form" : "/payment-form", params: { id: t.id } })}
              >
                <Ionicons name="create-outline" size={18} color={theme.color.brandPrimary} />
              </Pressable>
            </View>
          </View>
        ))}
        <View style={{ height: 60 }} />
      </ScrollView>

      {/* Note Modal */}
      {noteKind ? (
        <Modal visible transparent animationType="fade">
          <View style={styles.modalBg}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{noteKind === "credit" ? "Credit" : "Debit"} Note for {data.name}</Text>
              {noteError ? <Text style={styles.modalErr}>{noteError}</Text> : null}
              <Text style={styles.modalLabel}>Amount ({currency})</Text>
              <TextInput
                value={noteAmount}
                onChangeText={setNoteAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                style={styles.modalInput}
              />
              <Text style={styles.modalLabel}>Reason</Text>
              <TextInput
                value={noteReason}
                onChangeText={setNoteReason}
                placeholder="Adjustment reason"
                style={styles.modalInput}
              />
              <Text style={styles.modalLabel}>Notes</Text>
              <TextInput
                value={noteNotes}
                onChangeText={setNoteNotes}
                placeholder="Optional notes"
                style={styles.modalInput}
              />
              <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
                <Pressable onPress={() => setNoteKind(null)} style={[styles.modalBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                  <Text style={{ color: theme.color.onSurface }}>Cancel</Text>
                </Pressable>
                <Pressable onPress={saveNote} disabled={noteBusy} style={[styles.modalBtn, { backgroundColor: theme.color.brandPrimary, flex: 1 }]}>
                  {noteBusy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "700" }}>Save</Text>}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  top: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.brandTertiary, justifyContent: "center", alignItems: "center" },
  avatarText: { color: theme.color.brandPrimary, fontWeight: "800", fontSize: 18 },
  name: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface },
  sub: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
  balBox: { marginTop: theme.spacing.lg, padding: theme.spacing.lg, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.lg, alignItems: "center" },
  balLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "700", letterSpacing: 0.5 },
  balValue: { fontSize: 32, fontWeight: "800", marginTop: 4 },
  balGrid: { flexDirection: "row", justifyContent: "space-around", width: "100%", marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.color.border },
  smLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "600" },
  smVal: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: 2 },
  
  btnRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  btnPill: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 12, borderRadius: 999 },
  btnPillTextText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  btnOutline: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  btnOutlineText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 12 },

  section: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.xl, marginBottom: theme.spacing.md },
  empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
  timelineRow: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
  timelineDot: { width: 10, height: 10, borderRadius: 5 },
  tlTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
  tlSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
  tlAmount: { fontSize: 14, fontWeight: "700" },

  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: theme.color.surface, borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface, marginBottom: 12 },
  modalLabel: { fontSize: 12, color: theme.color.muted, marginTop: 10, marginBottom: 4 },
  modalInput: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border, borderRadius: 8, padding: 10, color: theme.color.onSurface },
  modalBtn: { padding: 12, borderRadius: 8, alignItems: "center" },
  modalErr: { color: theme.color.error, fontSize: 12, marginBottom: 6 },
}); }
