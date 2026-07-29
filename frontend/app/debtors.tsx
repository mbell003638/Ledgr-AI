import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Modal, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { amountToWords } from "@/src/utils/numberToWords";
import { getCurrencySymbol } from "@/src/db/local";
import { printHtml } from "@/src/utils/print";
import { confirmAction, showAlert } from "@/src/utils/alerts";

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

  let primary = "#1e222b";
  let accent = "#f5a623";
  
  if (biz.invoiceTheme === "navy_gold") {
    primary = "#000000";
    accent = "#FDBA21";
  } else if (biz.invoiceTheme === "amoled_blue") {
    primary = "#000000";
    accent = "#3498db";
  } else if (biz.invoiceTheme === "emerald") {
    primary = "#1C4030";
    accent = "#2ecc71";
  } else if (biz.invoiceTheme === "minimal") {
    primary = "#111513";
    accent = "#8FB99A";
  } else {
    const tc = themeColors || {};
    const getDarkest = (c1: string, c2: string, fallback: string) => {
      const parse = (c: string) => {
        const hex = (c || "").replace('#', '');
        if (hex.length !== 6) return 255;
        return (parseInt(hex.substring(0,2), 16) * 299 + parseInt(hex.substring(2,4), 16) * 587 + parseInt(hex.substring(4,6), 16) * 114) / 1000;
      };
      const b1 = parse(c1); const b2 = parse(c2);
      if (!c1 && !c2) return fallback;
      return b1 < b2 ? c1 : c2;
    };
    primary = getDarkest(tc.surface, tc.surfaceInverse, "#1e222b");
    accent  = tc.brandPrimary || tc.brand || "#f5a623";
  }

  const rows = statement.map((r: any, i: number) =>
    `<tr>
      <td>${new Date(r.date).toLocaleDateString()}</td>
      <td>${escapeHtml(r.type === 'invoice' ? "Invoice" : r.type === 'payment' ? "Payment Received" : r.type === 'credit' ? "Credit Note / Discount" : "Debit Note / Charge")}</td>
      <td>${escapeHtml(r.ref || "")}</td>
      <td>${r.type === 'invoice' || r.type === 'debit' ? money(r.amount) : ""}</td>
      <td>${r.type === 'payment' || r.type === 'credit' ? money(r.amount) : ""}</td>
      <td>${money(r.runningBalance)}</td>
    </tr>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Statement</title>
<style>
  :root{
    --dark: ${primary};
    --gold: ${accent};
    --gray-row: #eef0f2;
    --text: #1e222b;
    --muted: #7a7f8a;
  }

  @media print {
    * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body { background: #fff !important; padding: 0 !important; }
    .invoice { box-shadow: none !important; width: 100% !important; max-width: 100% !important; margin: 0 !important; }
  }

  *{ box-sizing: border-box; margin:0; padding:0; }

  body{
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
    background:#e9e9e9;
    display:flex;
    justify-content:center;
    padding:30px 0;
  }

  .invoice{
    width: 800px;
    background:#fff;
    box-shadow: 0 10px 30px rgba(0,0,0,0.15);
    overflow:hidden;
  }

  /* ---------- HEADER ---------- */
  .header{
    position:relative;
    background:#fff;
    color:#fff;
    min-height:150px;
    overflow:hidden;
  }

  /* two separate dark panels with a thin gap between them = the white diagonal stripe
     NOTE: the cut is narrower at the top and widens going down (not the reverse) */
  .header-panel-left{
    position:absolute;
    top:0; left:0; bottom:0;
    width:100%;
    background:var(--dark);
    clip-path: polygon(0 0, 37% 0, 44% 100%, 0% 100%);
  }

  .header-panel-right{
    position:absolute;
    top:0; left:0; bottom:0;
    width:100%;
    background:var(--dark);
    clip-path: polygon(38% 0, 100% 0, 100% 100%, 45% 100%);
  }

  .header-content{
    position:relative;
    z-index:2;
    display:flex;
    min-height:150px;
  }

  .header-left{
    width:44%;
    padding:35px 30px;
    display:flex;
    flex-direction:column;
    justify-content:center;
  }

  .logo{
    font-size:34px;
    font-weight:800;
    letter-spacing:1px;
  }

  .header-right{
    flex:1;
    padding:30px 40px 30px 10px;
    display:flex;
    justify-content:space-between;
    align-items:flex-start;
  }

  .invoice-to h4{
    color:var(--gold);
    font-size:13px;
    letter-spacing:1px;
    margin-bottom:8px;
  }

  .invoice-to p{
    font-size:12px;
    line-height:1.9;
    color:#e6e6e6;
    text-transform: uppercase;
  }

  .contact-list{
    text-align:right;
    font-size:11px;
    line-height:1.6;
  }

  .contact-list div{
    display:flex;
    align-items:center;
    justify-content:flex-end;
    gap:8px;
    margin-bottom:6px;
  }

  .contact-icon{
    width:22px;
    height:22px;
    border-radius:50%;
    background:var(--gold);
    color:var(--dark);
    font-size:11px;
    display:flex;
    align-items:center;
    justify-content:center;
    flex-shrink:0;
  }

  /* ---------- TITLE BAR ---------- */
  .title-bar{
    position:relative;
    background:var(--gold);
    min-height:78px;
    overflow:hidden;
  }

  /* white panel behind "INVOICE" - same direction as header: narrow at top, wider at bottom */
  .title-bar-white{
    position:absolute;
    top:0; left:0; bottom:0;
    width:100%;
    background:#fff;
    clip-path: polygon(0 0, 45% 0, 48% 100%, 0% 100%);
  }

  .title-bar-content{
    position:relative;
    z-index:2;
    display:flex;
    min-height:78px;
  }

  .title-bar-content .title{
    width:44%;
    padding:20px 30px;
    display:flex;
    align-items:center;
  }

  .title-bar-content .title h1{
    font-size:28px;
    font-weight:800;
    letter-spacing:1px;
    color:var(--dark);
    margin:0;
  }

  .meta{
    flex:1;
    display:flex;
    align-items:center;
    justify-content:space-around;
    padding:10px 20px;
  }

  .meta div{
    text-align:center;
    font-size:11px;
    color:var(--dark);
  }

  .meta div span{
    display:block;
    font-weight:700;
    font-size:13px;
    margin-top:2px;
  }

  .meta .divider{
    width:1px;
    height:30px;
    background:rgba(30,34,43,0.3);
  }

  /* ---------- TABLE ---------- */
  .table-wrap{
    padding:35px 40px 10px;
  }

  table{
    width:100%;
    border-collapse:collapse;
  }

  thead tr{
    background:var(--dark);
    color:#fff;
  }

  thead th{
    text-align:left;
    font-size:12px;
    padding:12px 14px;
    font-weight:600;
    text-transform: uppercase;
  }

  thead th:last-child,
  tbody td:last-child{
    text-align:right;
  }

  tbody td{
    font-size:12px;
    padding:14px;
    color:var(--text);
  }

  tbody tr:nth-child(even){
    background:var(--gray-row);
  }

  /* ---------- TOTALS ---------- */
  .totals{
    width:280px;
    margin-left:auto;
    margin-top:20px;
    font-size:12px;
    border:1px solid #e0e0e0;
  }

  .totals div{
    display:flex;
    justify-content:space-between;
    padding:10px 16px;
    background:var(--gray-row);
    border-bottom:1px solid #e0e0e0;
  }

  .totals div:last-child{
    border-bottom:none;
  }

  .totals span:first-child{
    color:var(--muted);
  }

  .totals span:last-child{
    font-weight:700;
    color:var(--text);
  }

  .totals .grand{
    background:var(--gold);
    font-weight:700;
    font-size:13px;
  }

  .totals .grand span{
    color:var(--dark) !important;
  }

  /* ---------- FOOTER CONTENT ---------- */
  .footer-content{
    display:flex;
    justify-content:space-between;
    align-items:flex-end;
    padding:30px 40px 40px;
  }

  .payment-methods h4{
    font-size:13px;
    margin-bottom:10px;
    position:relative;
    padding-bottom:8px;
    text-transform: uppercase;
  }

  .payment-methods h4::after{
    content:"";
    position:absolute;
    left:0; bottom:0;
    width:40px;
    height:3px;
    background:var(--gold);
  }

  .payment-methods ul{
    list-style:none;
    max-width:320px;
  }

  .payment-methods li{
    display:flex;
    gap:8px;
    font-size:11px;
    color:var(--muted);
    margin-bottom:10px;
    line-height:1.5;
  }

  .payment-methods li::before{
    content:"+";
    color:var(--gold);
    font-weight:700;
  }

  .signature{
    text-align:center;
  }

  .signature .sig-name{
    font-family: 'Brush Script MT', cursive, sans-serif;
    font-size:28px;
    margin-bottom:6px;
    color:var(--dark);
  }

  .signature p{
    font-size:11px;
    color:var(--muted);
    border-top:1px solid #ccc;
    padding-top:4px;
    text-transform: uppercase;
  }

  .signature p.role{
    font-weight:700;
    color:var(--text);
    border-top:none;
    padding-top:0;
  }

  /* ---------- BOTTOM BAR ---------- */
  .bottom-bar{
    background:var(--dark);
    color:#fff;
    padding:25px 40px;
    position:relative;
  }

  .bottom-bar::before{
    content:"";
    position:absolute;
    top:0; left:0; right:0;
    height:4px;
    background:var(--gold);
  }

  .bottom-bar h5{
    color:var(--gold);
    font-size:13px;
    margin-bottom:4px;
  }

  .bottom-bar h6{
    font-size:12px;
    margin-bottom:10px;
  }

  .bottom-bar p{
    font-size:10px;
    color:#c7c9cf;
    line-height:1.6;
    white-space: pre-wrap;
  }
</style>
</head>
<body>

<div class="invoice">

  <!-- Header -->
  <div class="header">
    <div class="header-panel-left"></div>
    <div class="header-panel-right"></div>
    <div class="header-content">
      <div class="header-left">
        ${biz.logo ? `<img src="${biz.logo}" class="logo-img" style="max-height: 80px; max-width: 180px; object-fit: contain;" />` : `<div class="logo">Logo</div>`}
      </div>
      <div class="header-right">
        <div class="invoice-to">
          <h4>STATEMENT TO</h4>
          <p>
            ${escapeHtml(debtor.name)}<br>
            ${debtor.phone ? `P : ${escapeHtml(debtor.phone)}<br>` : ''}
            ${debtor.email ? `E : ${escapeHtml(debtor.email)}<br>` : ''}
          </p>
        </div>
        <div class="contact-list">
          ${biz.businessName ? `<div>${escapeHtml(biz.businessName)} <span class="contact-icon">&#9742;</span></div>` : ''}
          ${biz.businessPhone ? `<div>${escapeHtml(biz.businessPhone)} <span class="contact-icon">&#9742;</span></div>` : ''}
          ${biz.businessEmail ? `<div>${escapeHtml(biz.businessEmail)} <span class="contact-icon">&#64;</span></div>` : ''}
          ${biz.businessAddress ? `<div>${escapeHtml(biz.businessAddress)} <span class="contact-icon">&#128205;</span></div>` : ''}
        </div>
      </div>
    </div>
  </div>

  <!-- Title / meta bar -->
  <div class="title-bar">
    <div class="title-bar-white"></div>
    <div class="title-bar-content">
      <div class="title">
        <h1>STATEMENT</h1>
      </div>
      <div class="meta">
        <div>Total Due <span>${money(balance)}</span></div>
        <div class="divider"></div>
        <div>As of Date <span>${today}</span></div>
        <div class="divider"></div>
        <div>Total Invoiced <span>${money(debtor.totalInvoiced || 0)}</span></div>
      </div>
    </div>
  </div>

  <!-- Table -->
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Description</th>
          <th>Reference</th>
          <th>Debit</th>
          <th>Credit</th>
          <th>Balance</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="totals">
      <div><span>Total Invoiced</span><span>${money(debtor.totalInvoiced || 0)}</span></div>
      <div><span>Total Paid</span><span>${money(debtor.totalPaid || 0)}</span></div>
      <div class="grand"><span>Balance Due</span><span>${money(balance)}</span></div>
      <div style="background:transparent;color:var(--muted);font-style:italic;font-size:10px;justify-content:flex-end;padding:10px 0 0;border:none;">${totalInWords}</div>
    </div>
  </div>

  <!-- Payment + signature -->
  <div class="footer-content">
    <div class="payment-methods">
      <h4>ACCOUNT SUMMARY</h4>
      <ul>
        <li>This is a computer-generated statement.</li>
        <li>Please review transactions carefully.</li>
        <li>Contact us immediately if you find any discrepancies.</li>
      </ul>
    </div>
    <div class="signature">
      <div class="sig-name">${escapeHtml(biz.businessName || "Signature")}</div>
      <p class="role">Authorized Signatory</p>
      <p>ACCOUNT MANAGER</p>
    </div>
  </div>

  <!-- Bottom bar -->
  <div class="bottom-bar">
    <h5>Thank you for your business</h5>
    <h6>Statement Terms</h6>
    <p>This statement reflects all activity up to ${today}. Please settle outstanding balances promptly.</p>
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

  const { customerId } = useLocalSearchParams<{ customerId?: string }>();
  useEffect(() => {
    if (customerId && debtors.length > 0 && !selected) {
      const found = debtors.find(d => d.id === customerId);
      if (found) setSelected(found);
    }
  }, [customerId, debtors, selected]);

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
          showAlert("Cannot Delete Customer", e.message || "Could not delete customer");
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
    if (!selected) return;
    try {
      let stmt = statement;
      if (!stmt) {
        stmt = await api.getDebtorStatement(selected.id);
        setStatement(stmt);
      }
      let b = biz;
      if (!b || !b.businessName) {
        b = await api.getSettings();
        setBiz(b);
      }
      const html = buildStatementHtml(selected, stmt, b, currency, theme.color, currCode);
      if (Platform.OS === 'web') {
        await printHtml(html, `Statement — ${selected.name}`);
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Statement — ${selected.name}` });
      }
    } catch (e: any) {
      console.warn(e);
      showAlert("Statement Error", e?.message || "Could not generate statement PDF.");
    }
  };

  const printStatement = async () => {
    if (!selected) return;
    try {
      let stmt = statement;
      if (!stmt) {
        stmt = await api.getDebtorStatement(selected.id);
        setStatement(stmt);
      }
      let b = biz;
      if (!b || !b.businessName) {
        b = await api.getSettings();
        setBiz(b);
      }
      const html = buildStatementHtml(selected, stmt, b, currency, theme.color, currCode);
      await printHtml(html, `Statement — ${selected.name}`);
    } catch (e: any) {
      console.warn(e);
      showAlert("Print Error", e?.message || "Could not print statement.");
    }
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
          <Pressable onPress={() => { setSelected(null); router.setParams({ customerId: '' }); }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
          <Text style={styles.headerTitle}>Customer Detail</Text>
          <Pressable testID="btn-edit-debtor" onPress={() => router.push({ pathname: "/party-form", params: { id: selected.id, type: "customer" } } as any)} hitSlop={10}>
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
              <Pressable onPress={shareStatementPdf} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>
                <Ionicons name="document-text-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Statement PDF</Text>
              </Pressable>
              <Pressable onPress={() => router.push(`/reconcile?customerId=${selected.id}` as any)} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }]}>
                <Ionicons name="git-compare-outline" size={16} color={theme.color.onSurface} />
                <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Compare Statement</Text>
              </Pressable>
              <Pressable onPress={() => openNote("credit")} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }]}>
                <Ionicons name="pricetag-outline" size={16} color={theme.color.onSurface} />
                <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Give Discount / Credit</Text>
              </Pressable>
              <Pressable onPress={() => openNote("debit")} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }]}>
                <Ionicons name="add-circle-outline" size={16} color={theme.color.onSurface} />
                <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Add Charge / Debit</Text>
              </Pressable>
              <Pressable onPress={printStatement} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }]}>
                <Ionicons name="print-outline" size={16} color={theme.color.onSurface} />
                <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Print</Text>
              </Pressable>
              {selected.phone ? (
                <Pressable onPress={() => sendWhatsApp(selected)} style={[styles.actionBtn, { backgroundColor: "#25D366" }]}>
                  <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                  <Text style={styles.actionText}>WhatsApp</Text>
                </Pressable>
              ) : null}
              {selected.email ? (
                <Pressable onPress={() => sendEmail(selected)} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }]}>
                  <Ionicons name="mail-outline" size={16} color={theme.color.onSurface} />
                  <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Email</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={() => deleteDebtor(selected)} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.error }]}>
                <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                <Text style={[styles.actionText, { color: theme.color.error }]}>Delete Customer</Text>
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

        <Modal visible={editingInvoice !== null} transparent animationType="slide" onRequestClose={() => setEditingInvoice(null)}>
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

        <Modal visible={showPay} transparent animationType="slide" onRequestClose={() => setShowPay(false)}>
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

        <Modal visible={editingPayment !== null} transparent animationType="slide" onRequestClose={() => setEditingPayment(null)}>
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

        <Modal visible={showApply} transparent animationType="slide" onRequestClose={() => setShowApply(false)}>
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

        <Modal visible={noteKind !== null} transparent animationType="slide" onRequestClose={() => setNoteKind(null)}>
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
        <Pressable onPress={() => router.push({ pathname: "/party-form", params: { type: "customer" } } as any)}>
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
