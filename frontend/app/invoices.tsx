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
import * as ImagePicker from "expo-image-picker";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { getCurrencySymbol } from "@/src/db/local";
import { amountToWords } from "@/src/utils/numberToWords";

type InvoiceLine = { description: string; qty: number; rate: number; unit?: string };
type Invoice = {
  id: string; invoiceNumber: string; status: "unpaid" | "paid";
  clientName: string; clientPhone?: string;
  date: string; dueDate?: string;
  lines: InvoiceLine[];
  notes?: string; taxLabel?: string; taxRate?: number;
  total: number; paidAt?: string;
  terms?: string;
};

// Robust line accessors: older invoices (from the quick sale form) stored the
// unit price under `price` instead of `rate`, and some rows may be missing
// numbers entirely. Coerce everything to a safe number so rendering can never
// crash on `.toFixed` of undefined.
const lineRate = (l: any): number => Number(l?.rate ?? l?.price ?? 0) || 0;
const lineQty = (l: any): number => Number(l?.qty ?? 1) || 0;
const lineAmt = (l: any): number => lineQty(l) * lineRate(l);
const invTotal = (inv: any): number => {
  const t = Number(inv?.total);
  if (Number.isFinite(t)) return t;
  const sub = (inv?.lines || []).reduce((s: number, l: any) => s + lineAmt(l), 0);
  const rate = Number(inv?.taxRate) || 0;
  return +(sub + sub * rate / 100).toFixed(2);
};

function calcTotal(lines: InvoiceLine[], taxRate = 0) {
  const sub = lines.reduce((s, l) => s + lineAmt(l), 0);
  return +(sub + sub * taxRate / 100).toFixed(2);
}

function escapeHtml(v: any): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// prevBalance = customer's outstanding balance carried forward from BEFORE this
// invoice (0 when none / walk-in). balanceDue = prevBalance + this invoice total
// − any amount already paid on this invoice.
function buildHtml(inv: Invoice, biz: any, sym: string, prevBalance = 0, themeColors?: any, currencyCode: string = 'USD') {
  const sub = inv.lines.reduce((s, l) => s + lineAmt(l), 0);
  const tax = inv.taxRate ? +(sub * inv.taxRate / 100).toFixed(2) : 0;
  const invT = invTotal(inv);
  const paidOnThis = inv.status === "paid" ? invT : 0;
  const carry = +(prevBalance || 0).toFixed(2);
  const balanceDue = +(carry + invT - paidOnThis).toFixed(2);
  const money = (n: number) => `${sym}${(Number(n) || 0).toFixed(2)}`;
  const totalInWords = amountToWords(balanceDue, currencyCode);

  const tc = themeColors || {};
  const primary = tc.surfaceInverse || tc.surface || "#1e202c";
  const accent  = tc.brandPrimary || tc.brand || "#FDBA21";
  const accentText = tc.onBrandPrimary || "#111111";

  const rows = inv.lines.map((l, i) =>
    `<tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td class="center" style="font-weight:600;color:#888">${String(i + 1).padStart(2, "0")}</td>
      <td style="font-weight:500">${escapeHtml(l.description)}</td>
      <td class="center">${money(lineRate(l))}</td>
      <td class="center">${lineQty(l)} ${l.unit ? escapeHtml(l.unit) : ""}</td>
      <td class="right" style="font-weight:700">${money(lineAmt(l))}</td>
    </tr>`
  ).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; color: #333; background: #fff; }
    .page-container { width: 100%; max-width: 800px; margin: 0 auto; background: #fff; position: relative; }
    
    /* Backgrounds */
    .top-bg-container { position: absolute; top: 0; left: 0; width: 100%; height: 264px; z-index: 0; overflow: hidden; }
    .bg-dark { position: absolute; top: 0; left: 0; width: 100%; height: 160px; background: ${primary}; }
    .bg-white-slant { position: absolute; top: 0; left: 40%; width: 12px; height: 160px; background: #fff; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-slant { position: absolute; top: 160px; left: calc(40% - 46px); width: 100px; height: 100px; background: ${accent}; transform-origin: top left; transform: skewX(-20deg); }
    .bg-yellow-rect { position: absolute; top: 160px; left: calc(40% - 46px); right: 0; height: 100px; background: ${accent}; }
    .bg-yellow-border { position: absolute; top: 260px; left: 0; right: 0; height: 4px; background: ${accent}; }

    /* Foreground Headers */
    .header-content { display: flex; height: 160px; position: relative; z-index: 10; }
    .header-left { width: 40%; padding: 40px; display: flex; align-items: center; justify-content: center; }
    .header-logo { max-height: 80px; max-width: 180px; object-fit: contain; }
    .header-logo-text { font-size: 56px; font-weight: 900; color: #fff; letter-spacing: 2px; }
    
    .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; }
    .invoice-to-title { color: ${accent}; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .client-name { font-size: 14px; font-weight: 700; color: #ffffff; margin-bottom: 8px; text-transform: uppercase; }
    .contact-item { display: flex; align-items: center; margin-bottom: 6px; font-size: 11px; color: #fff; }
    .contact-icon { width: 18px; height: 18px; border-radius: 50%; background: ${accent}; color: ${primary}; display: inline-flex; justify-content: center; align-items: center; font-size: 10px; font-weight: bold; margin-right: 10px; }

    /* Banner Content */
    .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
    .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
    .invoice-heading { font-size: 42px; font-weight: 900; color: #111; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
    .banner-right { width: 60%; display: flex; align-items: center; padding: 0 40px 0 20px; }
    .banner-col { text-align: left; border-left: 1.5px solid rgba(0,0,0,0.6); padding-left: 15px; flex: 1; margin-left: 10px; }
    .banner-col:first-child { border-left: none; padding-left: 0; margin-left: 0; }
    .banner-label { font-size: 11px; font-weight: 700; color: #222; }
    .banner-val { font-size: 14px; font-weight: 800; margin-top: 4px; color: #111; }

    /* Content */
    .content { padding: 40px; }
    
    /* Table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
    th { background: ${primary}; color: #ffffff; padding: 12px 14px; text-align: left; font-size: 11px; text-transform: uppercase; font-weight: 700; }
    td { padding: 12px 14px; border-bottom: none; color: #333; font-weight: 500; }
    tr.even td { background: #fff; }
    tr.odd td { background: #f4f4f4; }
    th.center, td.center { text-align: center; }
    th.right, td.right { text-align: right; }
    th.left, td.left { text-align: left; }
    
    /* Totals Box */
    .totals-wrapper { display: flex; justify-content: flex-end; }
    .totals-box { width: 280px; border-collapse: collapse; font-size: 12px; }
    .totals-box td { padding: 10px 14px; border: none; }
    .tot-row td { background: ${primary}; color: #ffffff; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .grand-tot-row td { background: ${accent}; color: ${accentText}; font-weight: 800; font-size: 13px; text-transform: uppercase; }

    /* Bottom Info & Signature */
    .bottom-info { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 10px; margin-bottom: 40px; padding: 0 40px; }
    .payment-methods { font-size: 11px; color: #444; max-width: 320px; }
    .payment-title { font-weight: 800; color: #111; text-transform: uppercase; font-size: 12px; letter-spacing: 1px; margin-bottom: 10px; border-bottom: 2px solid ${accent}; display: inline-block; padding-bottom: 4px; }
    .payment-text { margin-top: 4px; line-height: 1.5; font-weight: 500; }
    .payment-bullet { margin-bottom: 4px; display: flex; }
    .payment-bullet::before { content: "+"; color: #111; margin-right: 8px; font-weight: 900; }
    
    .signature-box { text-align: center; width: 180px; }
    .signature-line { border-bottom: 1px solid #777; margin-bottom: 6px; height: 40px; position: relative; }
    .signature-text { font-family: 'Brush Script MT', cursive, sans-serif; font-size: 24px; position: absolute; bottom: 2px; width: 100%; text-align: center; color: #333; }
    .signature-title { font-size: 9px; font-weight: 700; color: #777; text-transform: uppercase; letter-spacing: 1px; }

    /* Footer */
    .footer-bar { background: ${primary}; color: #fff; padding: 24px 40px; font-size: 10px; border-top: 6px solid ${accent}; }
    .thank-you { color: ${accent}; font-weight: 800; font-size: 13px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .terms-heading { font-weight: 700; color: #fff; margin-bottom: 2px; text-transform: uppercase; font-size: 10px; }
    .terms-body { color: #aaa; line-height: 1.4; white-space: pre-wrap; font-size: 9px; max-width: 600px; }
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
        ${biz.logo ? `<img src="${biz.logo}" class="header-logo" />` : `<div class="header-logo-text">Logo</div>`}
      </div>
      <div class="header-right">
        <div class="invoice-to-title">INVOICE TO</div>
        <div class="client-name">${escapeHtml(inv.clientName)}</div>
        ${biz.businessName ? `<div class="contact-item"><span class="contact-icon">C</span>${escapeHtml(biz.businessName)}</div>` : ''}
        ${inv.clientPhone ? `<div class="contact-item"><span class="contact-icon">P</span>${escapeHtml(inv.clientPhone)}</div>` : ''}
        ${biz.businessEmail ? `<div class="contact-item"><span class="contact-icon">E</span>${escapeHtml(biz.businessEmail)}</div>` : ''}
        ${biz.businessAddress ? `<div class="contact-item"><span class="contact-icon">A</span>${escapeHtml(biz.businessAddress)}</div>` : ''}
      </div>
    </div>

    <div class="banner-content">
      <div class="banner-left">
        <h1 class="invoice-heading">INVOICE</h1>
      </div>
      <div class="banner-right">
        <div class="banner-col">
          <div class="banner-label">Total Due</div>
          <div class="banner-val">${money(balanceDue)}</div>
        </div>
        ${inv.dueDate ? `
        <div class="banner-col">
          <div class="banner-label">Due Date</div>
          <div class="banner-val">${inv.dueDate}</div>
        </div>` : ''}
        <div class="banner-col">
          <div class="banner-label">Invoice No</div>
          <div class="banner-val">${inv.invoiceNumber}</div>
        </div>
      </div>
    </div>

    <div class="content">
      <table>
        <thead>
          <tr>
            <th style="width:40px" class="center">SL</th>
            <th class="left">Item Description</th>
            <th class="center">Price</th>
            <th class="center">Quantity</th>
            <th class="right">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <div class="totals-wrapper">
        <table class="totals-box">
          <tr class="tot-row"><td class="left">Sub Total</td><td class="right">${money(sub)}</td></tr>
          ${tax > 0 ? `<tr class="tot-row"><td class="left">${escapeHtml(inv.taxLabel || "Vat")} ${inv.taxRate}%</td><td class="right">${money(tax)}</td></tr>` : ""}
          ${carry !== 0 ? `<tr class="tot-row"><td class="left">Previous Balance</td><td class="right">${money(carry)}</td></tr>` : ""}
          ${paidOnThis > 0 ? `<tr class="tot-row"><td class="left">Payment Made</td><td class="right">(-) ${money(paidOnThis)}</td></tr>` : ""}
          <tr class="grand-tot-row"><td class="left">Grand Total</td><td class="right">${money(balanceDue)}</td></tr>
          <tr><td colspan="2" style="background:#fff;padding:12px 14px;font-size:11px;font-style:italic;color:#555;text-align:right;border-top:2px solid ${accent}">${totalInWords}</td></tr>
        </table>
      </div>
    </div>

    <div class="bottom-info">
      <div class="payment-methods">
        <div class="payment-title">PAYMENT METHODS</div>
        <div class="payment-text">
          ${biz.bankAccount ? `<div class="payment-bullet">${escapeHtml(biz.bankAccount)}</div>` : ''}
          ${biz.upiId ? `<div class="payment-bullet">${escapeHtml(biz.upiId)}</div>` : ''}
          ${biz.paymentDetails ? `<div class="payment-bullet">${escapeHtml(biz.paymentDetails)}</div>` : ''}
          ${!biz.bankAccount && !biz.upiId && !biz.paymentDetails ? `<div class="payment-bullet">Cash or Check</div>` : ''}
        </div>
      </div>
      <div class="signature-box">
        <div class="signature-line">
           <div class="signature-text">${escapeHtml(biz.businessName || "Signature")}</div>
        </div>
        <div class="signature-title">ACCOUNT MANAGER</div>
      </div>
    </div>

    <div class="footer-bar">
      <div class="thank-you">Thank you for your business</div>
      <div class="terms-heading">Terms &amp; Condition</div>
      <div class="terms-body">${escapeHtml(inv.terms || biz.invoiceTerms || "Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed Lorem ipsum dolor sit amet, consectetuer Lorem ipsum dolor sit amet.")}</div>
    </div>
  </div>
</body>
</html>`;
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
  const [ocrBusy, setOcrBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
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
    setDueDate(""); setLines([{ description: "", qty: 1, rate: 0 }]); setNotes(""); setTerms(""); setFormError("");
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
    setNotes(inv.notes || ""); setTerms(inv.terms || ""); setFormError("");
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
        terms: terms.trim() || undefined,
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

  const getPrevBalance = async (inv: Invoice) => {
    let prevBalance = 0;
    try {
      const debtors = await api.listDebtors();
      const match = (debtors as any[]).find((d) => (d.name || "").trim().toLowerCase() === (inv.clientName || "").trim().toLowerCase());
      if (match) {
        const st = await api.getDebtorStatement(match.id);
        const thisInvoiceOpen = inv.status === "paid" ? 0 : invTotal(inv);
        prevBalance = +((st.balance || 0) - thisInvoiceOpen).toFixed(2);
        if (prevBalance < 0) prevBalance = 0;
      }
    } catch {}
    return prevBalance;
  };

  const sharePdf = async (inv: Invoice) => {
    try {
      const prevBalance = await getPrevBalance(inv);
      const html = buildHtml(inv, biz, currSym, prevBalance, theme.color, biz.currency || 'USD');
      const { uri } = await Print.printToFileAsync({ html });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Invoice ${inv.invoiceNumber}` });
    } catch (e: any) { console.warn(e); }
  };

  const printInvoice = async (inv: Invoice) => {
    try {
      const prevBalance = await getPrevBalance(inv);
      await Print.printAsync({ html: buildHtml(inv, biz, currSym, prevBalance, theme.color, biz.currency || 'USD') });
    } catch (e: any) { console.warn(e); }
  };

  const shareWhatsApp = (inv: Invoice) => {
    const phone = (inv.clientPhone || "").replace(/\D/g, "");
    const msg = `Hi ${inv.clientName}, please find your invoice ${inv.invoiceNumber} for ${currSym}${invTotal(inv).toFixed(2)} dated ${inv.date}.${inv.dueDate ? ` Due: ${inv.dueDate}.` : ""}${biz.paymentDetails ? `\nPayment: ${biz.paymentDetails}` : ""}`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const updateLine = (i: number, field: keyof InvoiceLine, val: string) => {
    setLines((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: (field === "description" || field === "unit") ? val : val as any } : l));
  };

  // Scan / upload a document → OCR → prefill client name + a line item with the total.
  const runInvoiceOcr = async (base64: string, mimeType: string) => {
    setOcrBusy(true);
    try {
      const r = await api.ocrReceipt(base64, mimeType);
      if (r.supplierName && !clientName) setClientName(r.supplierName);
      if (r.date) setDate(r.date);
      if (r.amount) {
        setLines([{ description: r.invoiceNo ? `Ref ${r.invoiceNo}` : "Scanned item", qty: 1, rate: Number(r.amount) || 0 }]);
      }
    } catch (e) { console.warn(e); }
    finally { setOcrBusy(false); }
  };
  const scanInvoice = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await runInvoiceOcr(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };
  const uploadInvoiceImg = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await runInvoiceOcr(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };

  if (loading) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;

  // Detail view
  if (selected) {
    const sub = selected.lines.reduce((s, l) => s + lineAmt(l), 0);
    const tax = selected.taxRate ? +(sub * selected.taxRate / 100).toFixed(2) : 0;
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
          <Text style={styles.headerTitle}>{selected.invoiceNumber}</Text>
          <Pressable onPress={() => openEdit(selected)}><Ionicons name="create-outline" size={22} color={theme.color.brandPrimary} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <TransactionDetail
            title={selected.invoiceNumber}
            subtitle={`${selected.clientName} • ${shortDate(selected.date)}`}
            onEdit={() => openEdit(selected)}
            onReversalDelete={() => deleteInv(selected.id)}
            onShare={() => sharePdf(selected)}
            onPrint={() => printInvoice(selected)}
            onMore={() => selected.status === "unpaid" ? markPaid(selected.id) : shareWhatsApp(selected)}
          >
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
                <Text style={{ fontSize: 13, color: theme.color.muted, marginHorizontal: 8 }}>{lineQty(l)} × {currSym}{lineRate(l).toFixed(2)}</Text>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }}>{currSym}{lineAmt(l).toFixed(2)}</Text>
              </View>
            ))}
            {tax > 0 && <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}><Text style={styles.sub}>{selected.taxLabel} ({selected.taxRate}%)</Text><Text style={styles.sub}>{currSym}{tax.toFixed(2)}</Text></View>}
            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: 8, borderTopWidth: 2, borderTopColor: theme.color.brandPrimary, marginTop: 4 }}>
              <Text style={{ fontWeight: "700", fontSize: 15, color: theme.color.onSurface }}>Total</Text>
              <Text style={{ fontWeight: "700", fontSize: 18, color: theme.color.brandPrimary }}>{currSym}{invTotal(selected).toFixed(2)}</Text>
            </View>
          </Card>

          {selected.notes ? <Card style={{ marginTop: theme.spacing.md }}><Text style={styles.sub}>{selected.notes}</Text></Card> : null}
          </TransactionDetail>

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
              <Text style={{ fontWeight: "700", fontSize: 15, color: theme.color.onSurface }}>{currSym}{invTotal(inv).toFixed(2)}</Text>
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
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                  <Pressable onPress={scanInvoice} disabled={ocrBusy} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, paddingVertical: 10, borderRadius: theme.radius.md }}>
                    <Ionicons name="camera-outline" size={16} color="#fff" />
                    <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>Scan</Text>
                  </Pressable>
                  <Pressable onPress={uploadInvoiceImg} disabled={ocrBusy} style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandSecondary, paddingVertical: 10, borderRadius: theme.radius.md }}>
                    <Ionicons name="image-outline" size={16} color="#fff" />
                    <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>Upload</Text>
                  </Pressable>
                </View>
                {ocrBusy ? <Text style={{ fontSize: 12, color: theme.color.muted, marginBottom: 8 }}>Reading document…</Text> : null}
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
                      <TextInput value={String(l.qty)} onChangeText={(v) => updateLine(i, "qty", v)} keyboardType="decimal-pad" placeholder="Qty" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1.2 }]} />
                      <TextInput value={l.unit || ""} onChangeText={(v) => updateLine(i, "unit", v)} placeholder="Unit (e.g. pcs, box)" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1.2 }]} />
                      <TextInput value={String(l.rate ?? "")} onChangeText={(v) => updateLine(i, "rate", v)} keyboardType="decimal-pad" placeholder="Rate" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1.5 }]} />
                      <View style={{ justifyContent: "center", flex: 1.1 }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }} numberOfLines={1} adjustsFontSizeToFit>{currSym}{lineAmt(l).toFixed(2)}</Text>
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
                <TextInput value={notes} onChangeText={setNotes} placeholder="Internal or extra notes (optional)" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60, marginBottom: 12 }]} multiline />
                <Text style={styles.label}>Invoice Terms</Text>
                <TextInput value={terms} onChangeText={setTerms} placeholder="Terms & Conditions (Optional)" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
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
