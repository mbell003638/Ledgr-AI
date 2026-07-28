import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Modal, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { amountToWords } from "@/src/utils/numberToWords";
import { getCurrencySymbol } from "@/src/db/local";

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
  const tc = themeColors || {};
  const primary = tc.surfaceInverse || tc.surface || "#1e202c";
  const accent  = tc.brandPrimary || tc.brand || "#FDBA21";
  const accentText = tc.onBrandPrimary || "#111111";
  const money = (n: number) => `${sym}${(Number(n) || 0).toFixed(2)}`;
  const balance = Number(debtor.balance || 0);
  const totalInWords = amountToWords(Math.abs(balance), currencyCode);
  const today = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  const ledger = statement?.ledger || [];
  const rows = ledger.map((r: any, i: number) => {
    const label = r.kind === "invoice" ? "Invoice" : r.kind === "payment" ? "Payment" : r.kind === "credit_note" ? "Credit Note" : r.kind === "debit_note" ? "Debit Note" : "Entry";
    const dateStr = r.date ? new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
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
    .header-logo-text { font-size: 56px; font-weight: 900; color: #fff; letter-spacing: 2px; }
    .header-logo { max-height: 80px; max-width: 180px; object-fit: contain; }
    .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; }
    .statement-to-title { color: ${accent}; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .client-name { font-size: 14px; font-weight: 700; color: #ffffff; margin-bottom: 8px; text-transform: uppercase; }
    .contact-item { display: flex; align-items: center; margin-bottom: 6px; font-size: 11px; color: #fff; }
    .contact-icon { width: 18px; height: 18px; border-radius: 50%; background: ${accent}; color: ${primary}; display: inline-flex; justify-content: center; align-items: center; font-size: 10px; font-weight: bold; margin-right: 10px; }
    .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
    .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
    .statement-heading { font-size: 36px; font-weight: 900; color: #111; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
    .banner-right { width: 60%; display: flex; align-items: center; padding: 0 40px 0 20px; }
    .banner-col { text-align: left; border-left: 1.5px solid rgba(0,0,0,0.6); padding-left: 15px; flex: 1; margin-left: 10px; }
    .banner-col:first-child { border-left: none; padding-left: 0; margin-left: 0; }
    .banner-label { font-size: 11px; font-weight: 700; color: #222; }
    .banner-val { font-size: 14px; font-weight: 800; margin-top: 4px; color: #111; }
    .content { padding: 40px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 12px; }
    th { background: ${primary}; color: #ffffff; padding: 12px 14px; text-align: left; font-size: 11px; text-transform: uppercase; font-weight: 700; }
    td { padding: 12px 14px; border-bottom: none; color: #333; font-weight: 500; }
    tr.even td { background: #fff; }
    tr.odd td { background: #f4f4f4; }
    th.right, td.right { text-align: right; }
    .totals-wrapper { display: flex; justify-content: flex-end; }
    .totals-box { width: 280px; border-collapse: collapse; font-size: 12px; }
    .totals-box td { padding: 10px 14px; border: none; }
    .tot-row td { background: ${primary}; color: #ffffff; font-weight: 600; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .grand-tot-row td { background: ${accent}; color: ${accentText}; font-weight: 800; font-size: 13px; text-transform: uppercase; }
    .amount-words { background: #fff; padding: 12px 14px; font-size: 11px; font-style: italic; color: #555; text-align: right; border-top: 2px solid ${accent}; }
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
        <div class="statement-to-title">STATEMENT TO</div>
        <div class="client-name">${escapeHtml(debtor.name)}</div>
        ${debtor.phone ? `<div class="contact-item"><span class="contact-icon">P</span>${escapeHtml(debtor.phone)}</div>` : ''}
        ${debtor.email ? `<div class="contact-item"><span class="contact-icon">E</span>${escapeHtml(debtor.email)}</div>` : ''}
        ${biz.businessName ? `<div class="contact-item"><span class="contact-icon">C</span>${escapeHtml(biz.businessName)}</div>` : ''}
      </div>
    </div>

    <div class="banner-content">
      <div class="banner-left">
        <h1 class="statement-heading">STATEMENT</h1>
      </div>
      <div class="banner-right">
        <div class="banner-col">
          <div class="banner-label">Balance Due</div>
          <div class="banner-val">${money(balance)}</div>
        </div>
        <div class="banner-col">
          <div class="banner-label">As of Date</div>
          <div class="banner-val">${today}</div>
        </div>
        <div class="banner-col">
          <div class="banner-label">Total Invoiced</div>
          <div class="banner-val">${money(debtor.totalInvoiced || 0)}</div>
        </div>
      </div>
    </div>

    <div class="content">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>Reference</th>
            <th class="right">Debit</th>
            <th class="right">Credit</th>
            <th class="right">Balance</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <div class="totals-wrapper">
        <table class="totals-box">
          <tr class="tot-row"><td>Total Invoiced</td><td class="right">${money(debtor.totalInvoiced || 0)}</td></tr>
          <tr class="tot-row"><td>Total Paid</td><td class="right">${money(debtor.totalPaid || 0)}</td></tr>
          <tr class="grand-tot-row"><td>Balance Due</td><td class="right">${money(balance)}</td></tr>
          <tr><td colspan="2" class="amount-words">${totalInWords}</td></tr>
        </table>
      </div>
    </div>

    <div class="footer-bar">
      <div class="thank-you">Thank you for your business</div>
      <div class="terms-heading">Account Statement</div>
      <div class="terms-body">This is a computer-generated statement of your account. Please contact us if you have any queries regarding the transactions listed above.</div>
    </div>
  </div>
</body>
</html>`;
}

export default function DebtorsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [currency, setCurrency] = useState("$");
  const [currCode, setCurrCode] = useState('USD');
  const [biz, setBiz] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Debtor | null>(null);
  const [advanceCredit, setAdvanceCredit] = useState(0);
  const [statement, setStatement] = useState<any>(null);
  const [showApply, setShowApply] = useState(false);
  const [openInvoices, setOpenInvoices] = useState<{ id: string; invoiceNumber: string; total: number; open: number }[]>([]);
  const [applyBusy, setApplyBusy] = useState(false);
  // Credit/Debit note modal
  const [noteKind, setNoteKind] = useState<"credit" | "debit" | null>(null);
  const [noteAmount, setNoteAmount] = useState("");
  const [noteReason, setNoteReason] = useState<"discount" | "return" | "correction" | "other">("discount");
  const [noteNotes, setNoteNotes] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState("");
  // Edit an existing debtor (reuses the add fields; editId != null = edit mode).
  const [editId, setEditId] = useState<string | null>(null);
  const [deletingDebtor, setDeletingDebtor] = useState(false);

  // Payment editor (statement row → edit/delete, same interaction model as Sales).
  const [editingPayment, setEditingPayment] = useState<any | null>(null);

  // Invoice editor (statement row → edit/delete).
  const [editingInvoice, setEditingInvoice] = useState<any | null>(null);
  const [invAmount, setInvAmount] = useState("");
  const [invNotes, setInvNotes] = useState("");
  const [invDate, setInvDate] = useState("");
  const [invSaving, setInvSaving] = useState(false);
  const [invError, setInvError] = useState("");

  const [showPay, setShowPay] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payNotes, setPayNotes] = useState("");
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState("");

  const load = useCallback(async () => {
    try {
      const [raw, settings] = await Promise.all([api.listDebtors(), api.getSettings()]);
      // The database is authoritative because it includes invoices, payments,
      // credit notes and debit notes. Do not overwrite its balance in the UI.
      const enriched = (raw as Debtor[]).map((d) => ({
        ...d,
        totalInvoiced: Number((d as any).totalInvoiced) || 0,
        totalPaid: Number((d as any).totalPaid) || 0,
        balance: Number((d as any).balance) || 0,
      }));
      setDebtors(enriched);
      setBiz(settings || {});
      const sym = (settings as any).currency ?? "USD";
      setCurrCode(sym);
      const symMap: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", AED: "د.إ", CAD: "CA$", AUD: "A$", NGN: "₦", KES: "KSh", ZAR: "R", BDT: "৳", PKR: "₨", PHP: "₱", MXN: "MX$", BRL: "R$" };
      setCurrency(symMap[sym] ?? sym);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Load advance credit when a debtor detail is shown
  useEffect(() => {
    if (selected?.id) {
      api.getAdvanceCredit(selected.id).then(setAdvanceCredit).catch(() => setAdvanceCredit(0));
      api.getDebtorStatement(selected.id).then(setStatement).catch(() => setStatement(null));
    } else {
      setAdvanceCredit(0);
      setStatement(null);
    }
  }, [selected?.id, selected]);

  // Build the list of this customer's open (unpaid/partial) invoices, with the
  // remaining balance on each, so a deposit can be applied to one.
  const openApplyModal = async () => {
    if (!selected) return;
    try {
      const all = await api.listInvoices();
      const mine = (all as any[]).filter((i) => (i.clientName || "").trim().toLowerCase() === selected.name.trim().toLowerCase() && i.status !== "paid");
      const withOpen = await Promise.all(mine.map(async (i) => {
        const paid = await api.invoicePaidAmount(i.id);
        return { id: i.id, invoiceNumber: i.invoiceNumber, total: Number(i.total) || 0, open: +((Number(i.total) || 0) - paid).toFixed(2) };
      }));
      setOpenInvoices(withOpen.filter((i) => i.open > 0));
      setShowApply(true);
    } catch (e) { console.warn(e); }
  };

  const applyDepositTo = async (invoiceId: string) => {
    if (!selected) return;
    setApplyBusy(true);
    try {
      await api.applyAdvanceToInvoice(selected.id, invoiceId);
      setShowApply(false);
      // Refresh credit + debtor list
      const [credit] = await Promise.all([api.getAdvanceCredit(selected.id), load()]);
      setAdvanceCredit(credit);
    } catch (e: any) {
      Alert.alert("Cannot apply", e?.message || "Failed to apply deposit.");
    } finally { setApplyBusy(false); }
  };

  const openNote = (kind: "credit" | "debit") => {
    setNoteKind(kind); setNoteAmount(""); setNoteReason(kind === "credit" ? "discount" : "correction"); setNoteNotes(""); setNoteError("");
  };
  const saveNote = async () => {
    if (!selected || !noteKind) return;
    const amt = parseFloat(noteAmount);
    if (!amt || amt <= 0) { setNoteError("Enter a valid amount."); return; }
    setNoteBusy(true); setNoteError("");
    try {
      const payload = { debtorId: selected.id, clientName: selected.name, date: new Date().toISOString().slice(0, 10), amount: amt, reason: noteReason, notes: noteNotes.trim() };
      if (noteKind === "credit") await api.createCreditNote(payload);
      else await api.createDebitNote(payload);
      setNoteKind(null);
      await load();
      // Refresh selected balance from fresh list
      const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
      if (fresh) setSelected(fresh);
    } catch (e: any) {
      setNoteError(e?.message || "Failed to save note.");
    } finally { setNoteBusy(false); }
  };

  const saveDebtor = async () => {
    if (!addName.trim()) { setAddError("Name is required"); return; }
    setAddSaving(true); setAddError("");
    try {
      const payload = { name: addName.trim(), phone: addPhone.trim(), email: addEmail.trim(), notes: addNotes.trim() };
      if (editId) {
        await api.updateDebtor(editId, payload);
        // Keep the open detail view in sync with the edit.
        setSelected((prev) => (prev && prev.id === editId ? { ...prev, ...payload } : prev));
      } else {
        await api.createDebtor(payload);
      }
      setShowAdd(false); setEditId(null);
      setAddName(""); setAddPhone(""); setAddEmail(""); setAddNotes("");
      await load();
    } catch (e: any) { setAddError(e.message); }
    finally { setAddSaving(false); }
  };

  // Open the form pre-filled to edit an existing customer.
  const openEdit = (d: Debtor) => {
    setEditId(d.id);
    setAddName(d.name || "");
    setAddPhone(d.phone || "");
    setAddEmail((d as any).email || "");
    setAddNotes((d as any).notes || "");
    setAddError("");
    setShowAdd(true);
  };

  const confirmAction = (title: string, message: string, onConfirm: () => void) => {
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
        onConfirm();
      }
    } else {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: onConfirm },
      ]);
    }
  };

  // Delete a customer.
  const deleteDebtor = (d: Debtor) => {
    confirmAction(
      "Delete customer?",
      `Remove ${d.name}? This will remove this customer from your active Debtors list.`,
      async () => {
        setDeletingDebtor(true);
        try {
          await api.deleteDebtor(d.id);
          setSelected(null);
          await load();
        } catch (e: any) {
          Alert.alert("Delete failed", e.message || "Could not delete");
        } finally { setDeletingDebtor(false); }
      },
    );
  };

  const savePaymentEdit = async () => {
    if (!selected || !editingPayment) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setPayError("Enter a valid amount"); return; }
    setPaySaving(true); setPayError("");
    try {
      await api.updateDebtorPayment(selected.id, editingPayment.id, { amount, date: payDate, notes: payNotes.trim() });
      setEditingPayment(null); setPayAmount(""); setPayNotes("");
      const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
      if (fresh) setSelected(fresh);
      await load();
    } catch (e: any) { setPayError(e?.message || "Could not update payment"); }
    finally { setPaySaving(false); }
  };

  const deletePayment = (payment: any) => {
    if (!selected) return;
    confirmAction(
      "Delete payment?",
      "This reverses the receipt, cash movement, debtor balance and invoice allocation.",
      async () => {
        try {
          await api.deleteDebtorPayment(selected.id, payment.id);
          const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
          if (fresh) setSelected(fresh);
          await load();
        } catch (e: any) { Alert.alert("Delete failed", e?.message || "Could not delete payment"); }
      },
    );
  };

  const openPaymentEdit = (payment: any) => {
    setEditingPayment(payment);
    setPayAmount(String(payment.amount ?? ""));
    setPayDate(payment.date || new Date().toISOString().slice(0, 10));
    setPayNotes(payment.notes || "");
    setPayError("");
  };

  const openInvoiceEdit = (inv: any) => {
    setEditingInvoice(inv);
    setInvAmount(String(inv.debit || inv.amount || ""));
    setInvDate(inv.date || new Date().toISOString().slice(0, 10));
    setInvNotes(inv.ref || inv.notes || "");
    setInvError("");
  };

  const saveInvoiceEdit = async () => {
    if (!selected || !editingInvoice) return;
    const amount = Number(invAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setInvError("Enter a valid amount"); return; }
    setInvSaving(true); setInvError("");
    try {
      await api.updateInvoice(editingInvoice.id, {
        clientName: selected.name,
        date: invDate,
        total: amount,
        notes: invNotes.trim(),
      });
      setEditingInvoice(null);
      const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
      if (fresh) setSelected(fresh);
      await load();
    } catch (e: any) { setInvError(e?.message || "Could not update invoice"); }
    finally { setInvSaving(false); }
  };

  const deleteInvoiceEntry = (inv: any) => {
    if (!selected) return;
    confirmAction(
      "Delete invoice?",
      "This reverses the invoice entry and updates the debtor balance.",
      async () => {
        try {
          await api.deleteInvoice(inv.id);
          const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
          if (fresh) setSelected(fresh);
          await load();
        } catch (e: any) { Alert.alert("Delete failed", e?.message || "Could not delete invoice"); }
      },
    );
  };

  const recordPayment = async () => {
    if (!selected) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { setPayError("Enter a valid amount"); return; }
    setPaySaving(true); setPayError("");
    try {
      await api.addDebtorPayment(selected.id, { amount: amt, date: payDate, notes: payNotes.trim() });
      // addDebtorPayment now returns a Receipt, not a Debtor. Re-fetch the
      // debtor to get the updated ledger.
      const fresh = (await api.listDebtors() as Debtor[]).find((x) => x.id === selected.id);
      if (fresh) setSelected(fresh);
      setShowPay(false); setPayAmount(""); setPayNotes("");
      await load();
    } catch (e: any) { setPayError(e.message); }
    finally { setPaySaving(false); }
  };

  const sendWhatsApp = (d: Debtor) => {
    const phone = (d.phone || "").replace(/\D/g, "");
    if (!phone) return;
    const msg = `Hi ${d.name}, your outstanding balance is ${currency}${(d.balance ?? 0).toFixed(2)}. Please arrange payment. Thank you.`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const sendEmail = (d: Debtor) => {
    if (!d.email) return;
    const subject = "Payment Reminder";
    const body = `Hi ${d.name},\n\nYour outstanding balance is ${currency}${(d.balance ?? 0).toFixed(2)}. Please arrange payment at your earliest convenience.\n\nThank you.`;
    Linking.openURL(`mailto:${d.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch(() => {});
  };

  const shareStatementPdf = async () => {
    if (!selected || !statement) return;
    try {
      const html = buildStatementHtml(selected, statement, biz, currency, theme.color, currCode);
      const { uri } = await Print.printToFileAsync({ html });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${selected.name}` });
    } catch (e: any) { console.warn(e); }
  };

  const printStatement = async () => {
    if (!selected || !statement) return;
    try {
      await Print.printAsync({ html: buildStatementHtml(selected, statement, biz, currency, theme.color, currCode) });
    } catch (e: any) { console.warn(e); }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      </SafeAreaView>
    );
  }

  if (selected) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
          <Text style={styles.headerTitle}>Customer Detail</Text>
          <Pressable testID="btn-edit-debtor" onPress={() => openEdit(selected)} hitSlop={10}>
            <Ionicons name="create-outline" size={24} color={theme.color.brandPrimary} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <Card>
            <View style={styles.top}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{selected.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{selected.name}</Text>
                <Text style={styles.sub}>{selected.phone || "No phone"}</Text>
              </View>
            </View>
            <View style={styles.balBox}>
              <Text style={styles.balLabel}>Outstanding Balance</Text>
              <Text style={[styles.balValue, { color: (selected.balance ?? 0) > 0 ? theme.color.error : theme.color.success }]}>
                {currency}{(selected.balance ?? 0).toFixed(2)}
              </Text>
              <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 12, gap: 8 }}>
                <View style={{ alignItems: "center", flex: 1 }}>
                  <Text style={styles.smLabel}>Invoiced</Text>
                  <Text style={styles.smVal}>{currency}{(selected.totalInvoiced ?? 0).toFixed(2)}</Text>
                </View>
                <View style={{ alignItems: "center", flex: 1 }}>
                  <Text style={styles.smLabel}>Paid</Text>
                  <Text style={styles.smVal}>{currency}{(selected.totalPaid ?? 0).toFixed(2)}</Text>
                </View>
                <View style={{ alignItems: "center", flex: 1 }}>
                  <Text style={styles.smLabel}>Deposit</Text>
                  <Text style={[styles.smVal, { color: advanceCredit > 0 ? theme.color.success : theme.color.muted }]}>{currency}{advanceCredit.toFixed(2)}</Text>
                </View>
              </View>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: theme.spacing.md }}>
              <Pressable onPress={() => { setPayAmount(""); setPayDate(new Date().toISOString().slice(0, 10)); setPayNotes(""); setPayError(""); setShowPay(true); }} style={styles.actionBtn}>
                <Ionicons name="cash-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Record Payment</Text>
              </Pressable>
              {advanceCredit > 0 ? (
                <Pressable onPress={openApplyModal} style={[styles.actionBtn, { backgroundColor: theme.color.success }]}>
                  <Ionicons name="wallet-outline" size={16} color="#fff" />
                  <Text style={styles.actionText}>Apply Deposit</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={() => router.push(`/reconcile?customerId=${selected.id}` as any)} style={[styles.actionBtn, { backgroundColor: theme.color.brandSecondary }]}>
                <Ionicons name="git-compare-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Compare Statement</Text>
              </Pressable>
              <Pressable onPress={() => openNote("credit")} style={[styles.actionBtn, { backgroundColor: theme.color.warning }]}>
                <Ionicons name="pricetag-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Give Discount / Credit</Text>
              </Pressable>
              <Pressable onPress={() => openNote("debit")} style={[styles.actionBtn, { backgroundColor: theme.color.info }]}>
                <Ionicons name="add-circle-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Add Charge / Debit</Text>
              </Pressable>
              <Pressable onPress={shareStatementPdf} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>
                <Ionicons name="document-text-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Statement PDF</Text>
              </Pressable>
              <Pressable onPress={printStatement} style={[styles.actionBtn, { backgroundColor: theme.color.brandSecondary }]}>
                <Ionicons name="print-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Print</Text>
              </Pressable>
              {selected.phone ? (
                <Pressable onPress={() => sendWhatsApp(selected)} style={[styles.actionBtn, { backgroundColor: "#25D366" }]}>
                  <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                  <Text style={styles.actionText}>WhatsApp Reminder</Text>
                </Pressable>
              ) : null}
              {selected.email ? (
                <Pressable onPress={() => sendEmail(selected)} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>
                  <Ionicons name="mail-outline" size={16} color="#fff" />
                  <Text style={styles.actionText}>Email Reminder</Text>
                </Pressable>
              ) : null}
              <Pressable testID="btn-delete-debtor" onPress={() => deleteDebtor(selected)} disabled={deletingDebtor} style={[styles.actionBtn, { backgroundColor: theme.color.error }]}>
                {deletingDebtor ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Ionicons name="trash-outline" size={16} color="#fff" />
                    <Text style={styles.actionText}>Delete Customer</Text>
                  </>
                )}
              </Pressable>
            </View>
          </Card>

          <Text style={styles.section}>Statement</Text>
          {(!statement || statement.ledger.length === 0) ? (
            <Text style={styles.empty}>No transactions yet.</Text>
          ) : [...statement.ledger].reverse().map((r: any) => {
            const isCredit = r.credit > 0;
            const label = r.kind === "invoice" ? "Invoice" : r.kind === "payment" ? "Payment" : r.kind === "credit_note" ? "Credit Note" : r.kind === "debit_note" ? "Debit Note" : "Entry";
            const dotColor = r.kind === "invoice" || r.kind === "debit_note" ? theme.color.error : theme.color.success;
            return (
              <View key={`${r.kind}-${r.id}`} style={styles.timelineRow}>
                <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.tlTitle}>{label} • {shortDate(r.date)}{r.ref ? ` • ${r.ref}` : ""}</Text>
                  <Text style={styles.tlSub}>Balance: {currency}{Number(r.balance).toFixed(2)}{r.status && r.kind !== "invoice" ? ` • ${r.status}` : ""}</Text>
                </View>
                <Text style={[styles.tlAmount, { color: isCredit ? theme.color.success : theme.color.error }]}>
                  {isCredit ? "−" : "+"}{currency}{Number(isCredit ? r.credit : r.debit).toFixed(2)}
                </Text>
                <View style={styles.rowActions}>
                  {r.kind === "invoice" ? (
                    <>
                      <Pressable accessibilityLabel="Edit invoice" hitSlop={8} onPress={() => openInvoiceEdit(r)}>
                        <Ionicons name="create-outline" size={18} color={theme.color.brandPrimary} />
                      </Pressable>
                      <Pressable accessibilityLabel="Delete invoice" hitSlop={8} onPress={() => deleteInvoiceEntry(r)}>
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                      </Pressable>
                    </>
                  ) : r.kind === "payment" ? (
                    <>
                      <Pressable accessibilityLabel="Edit payment" hitSlop={8} onPress={() => openPaymentEdit({ id: r.id, amount: r.credit, date: r.date, notes: r.ref })}>
                        <Ionicons name="create-outline" size={18} color={theme.color.brandPrimary} />
                      </Pressable>
                      <Pressable accessibilityLabel="Delete payment" hitSlop={8} onPress={() => deletePayment({ id: r.id })}>
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                      </Pressable>
                    </>
                  ) : null}
                </View>
              </View>
            );
          })}
          <View style={{ height: 60 }} />
        </ScrollView>

        <Modal visible={editingInvoice !== null} transparent animationType="slide">
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <View style={styles.modalOverlay}><View style={styles.modalBox}>
              <View style={styles.modalHeader}><Text style={styles.headerTitle}>Edit Invoice</Text><Pressable onPress={() => setEditingInvoice(null)}><Ionicons name="close" size={24} color={theme.color.onSurface}/></Pressable></View>
              <Text style={styles.label}>Amount</Text><TextInput value={invAmount} onChangeText={setInvAmount} keyboardType="decimal-pad" style={styles.input}/>
              <Text style={[styles.label,{marginTop:12}]}>Date</Text><TextInput value={invDate} onChangeText={setInvDate} style={styles.input}/>
              <Text style={[styles.label,{marginTop:12}]}>Notes</Text><TextInput value={invNotes} onChangeText={setInvNotes} style={[styles.input,{minHeight:50}]} multiline/>
              {invError?<Text style={styles.error}>{invError}</Text>:null}
              <Pressable onPress={saveInvoiceEdit} disabled={invSaving} style={styles.saveBtn}>{invSaving?<ActivityIndicator color="#fff"/>:<Text style={styles.saveText}>Update Invoice</Text>}</Pressable>
            </View></View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={showPay} transparent animationType="slide">
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <View style={styles.modalOverlay}>
              <View style={styles.modalBox}>
                <View style={styles.modalHeader}>
                  <Text style={styles.headerTitle}>Record Payment</Text>
                  <Pressable onPress={() => setShowPay(false)}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
                </View>
                <Text style={styles.label}>Amount</Text>
                <TextInput value={payAmount} onChangeText={setPayAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Date</Text>
                <TextInput value={payDate} onChangeText={setPayDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
                <TextInput value={payNotes} onChangeText={setPayNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
                {payError ? <Text style={styles.error}>{payError}</Text> : null}
                <Pressable onPress={recordPayment} disabled={paySaving} style={({ pressed }) => [styles.saveBtn, (pressed || paySaving) && { opacity: 0.85 }]}>
                  {paySaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Payment</Text>}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={editingPayment !== null} transparent animationType="slide">
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <View style={styles.modalOverlay}><View style={styles.modalBox}>
              <View style={styles.modalHeader}><Text style={styles.headerTitle}>Edit Payment</Text><Pressable onPress={() => setEditingPayment(null)}><Ionicons name="close" size={24} color={theme.color.onSurface}/></Pressable></View>
              <Text style={styles.label}>Amount</Text><TextInput value={payAmount} onChangeText={setPayAmount} keyboardType="decimal-pad" style={styles.input}/>
              <Text style={[styles.label,{marginTop:12}]}>Date</Text><TextInput value={payDate} onChangeText={setPayDate} style={styles.input}/>
              <Text style={[styles.label,{marginTop:12}]}>Notes</Text><TextInput value={payNotes} onChangeText={setPayNotes} style={[styles.input,{minHeight:50}]} multiline/>
              {payError?<Text style={styles.error}>{payError}</Text>:null}
              <Pressable onPress={savePaymentEdit} disabled={paySaving} style={styles.saveBtn}>{paySaving?<ActivityIndicator color="#fff"/>:<Text style={styles.saveText}>Update Payment</Text>}</Pressable>
            </View></View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal visible={showApply} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <View style={styles.modalBox}>
              <View style={styles.modalHeader}>
                <Text style={styles.headerTitle}>Apply Deposit ({currency}{advanceCredit.toFixed(2)})</Text>
                <Pressable onPress={() => setShowApply(false)}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
              </View>
              <Text style={styles.tlSub}>Pick an open invoice to apply this customer&apos;s deposit credit to.</Text>
              {openInvoices.length === 0 ? (
                <Text style={styles.empty}>No open invoices to apply to.</Text>
              ) : openInvoices.map((inv) => (
                <Pressable key={inv.id} onPress={() => applyDepositTo(inv.id)} disabled={applyBusy} style={styles.applyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tlTitle}>{inv.invoiceNumber}</Text>
                    <Text style={styles.tlSub}>Open: {currency}{inv.open.toFixed(2)} of {currency}{inv.total.toFixed(2)}</Text>
                  </View>
                  <Ionicons name="arrow-forward-circle" size={22} color={theme.color.brandPrimary} />
                </Pressable>
              ))}
              {applyBusy ? <ActivityIndicator color={theme.color.brandPrimary} style={{ marginTop: 10 }} /> : null}
            </View>
          </View>
        </Modal>

        <Modal visible={noteKind !== null} transparent animationType="slide">
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
            <View style={styles.modalOverlay}>
              <View style={styles.modalBox}>
                <View style={styles.modalHeader}>
                  <Text style={styles.headerTitle}>{noteKind === "credit" ? "Credit Note (reduce balance)" : "Debit Note (add charge)"}</Text>
                  <Pressable onPress={() => setNoteKind(null)}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
                </View>
                <Text style={styles.tlSub}>{noteKind === "credit" ? "A discount or return — lowers what the customer owes. No cash moves." : "An extra charge — raises what the customer owes. No cash moves."}</Text>
                <Text style={[styles.label, { marginTop: 12 }]}>Amount</Text>
                <TextInput value={noteAmount} onChangeText={setNoteAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
                <Text style={[styles.label, { marginTop: 12 }]}>Reason</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {(noteKind === "credit" ? ["discount", "return", "correction", "other"] : ["correction", "other"]).map((r) => (
                    <Pressable key={r} onPress={() => setNoteReason(r as any)} style={[styles.reasonChip, noteReason === r && styles.reasonChipActive]}>
                      <Text style={[styles.reasonChipText, noteReason === r && { color: "#fff" }]}>{r}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
                <TextInput value={noteNotes} onChangeText={setNoteNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
                {noteError ? <Text style={styles.error}>{noteError}</Text> : null}
                <Pressable onPress={saveNote} disabled={noteBusy} style={({ pressed }) => [styles.saveBtn, (pressed || noteBusy) && { opacity: 0.85 }]}>
                  {noteBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{noteKind === "credit" ? "Save Credit Note" : "Save Debit Note"}</Text>}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Text style={styles.headerTitle}>Debtors</Text>
        <Pressable onPress={() => { setAddName(""); setAddPhone(""); setAddNotes(""); setAddError(""); setShowAdd(true); }}>
          <Ionicons name="add" size={28} color={theme.color.brandPrimary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        {debtors.length === 0 ? (
          <Text style={styles.empty}>No debtors yet. Tap + to add one.</Text>
        ) : debtors.map((d) => (
          <Pressable key={d.id} onPress={() => setSelected(d)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{d.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{d.name}</Text>
              <Text style={styles.sub}>{d.phone || "No phone"}</Text>
            </View>
            <Text style={[styles.balValue, { fontSize: 16, color: (d.balance ?? 0) > 0 ? theme.color.error : theme.color.success }]}>
              {currency}{(d.balance ?? 0).toFixed(2)}
            </Text>
          </Pressable>
        ))}
        <View style={{ height: 60 }} />
      </ScrollView>

      <Modal visible={showAdd} transparent animationType="slide">
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalBox}>
              <View style={styles.modalHeader}>
                <Text style={styles.headerTitle}>{editId ? "Edit Customer" : "Add Customer"}</Text>
                <Pressable onPress={() => { setShowAdd(false); setEditId(null); }}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
              </View>
              <Text style={styles.label}>Name *</Text>
              <TextInput value={addName} onChangeText={setAddName} placeholder="Full name" placeholderTextColor={theme.color.muted} style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Phone</Text>
              <TextInput value={addPhone} onChangeText={setAddPhone} placeholder="+123****7890" placeholderTextColor={theme.color.muted} keyboardType="phone-pad" style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Email</Text>
              <TextInput value={addEmail} onChangeText={setAddEmail} placeholder="Optional — for email reminders" placeholderTextColor={theme.color.muted} keyboardType="email-address" autoCapitalize="none" style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
              <TextInput value={addNotes} onChangeText={setAddNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 50 }]} multiline />
              {addError ? <Text style={styles.error}>{addError}</Text> : null}
              <Pressable onPress={saveDebtor} disabled={addSaving} style={({ pressed }) => [styles.saveBtn, (pressed || addSaving) && { opacity: 0.85 }]}>
                {addSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Add Debtor</Text>}
              </Pressable>
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
    top: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.brandTertiary, justifyContent: "center", alignItems: "center" },
    avatarText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 16 },
    name: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    sub: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
    row: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    balBox: { marginTop: theme.spacing.lg, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, alignItems: "center" },
    balLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
    balValue: { fontSize: 22, fontWeight: "700", marginTop: 4 },
    smLabel: { fontSize: 11, color: theme.color.muted },
    smVal: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface, marginTop: 2 },
    actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.color.brandPrimary, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 12 },
    section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
    empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
    timelineRow: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    applyRow: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surface, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.sm, gap: theme.spacing.md },
    reasonChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    reasonChipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    reasonChipText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface, textTransform: "capitalize" },
    timelineDot: { width: 10, height: 10, borderRadius: 5 },
    tlTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    tlSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    tlAmount: { fontSize: 14, fontWeight: "700" },
    rowActions: { flexDirection: "row", alignItems: "center", gap: 12, marginLeft: 4 },
    label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
    saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
    modalBox: { backgroundColor: theme.color.surfaceSecondary, borderTopLeftRadius: theme.radius.lg, borderTopRightRadius: theme.radius.lg, padding: theme.spacing.lg },
    modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: theme.spacing.md },
  });
}
