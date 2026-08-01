import React, { useCallback, useMemo, useState } from "react";
import { isValidDateString } from "@/src/utils/dateValidation";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Modal, Alert, Share,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { getCurrencySymbol } from "@/src/db/local";
import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";
import { amountToWords } from "@/src/utils/numberToWords";
import { printHtml } from "@/src/utils/print";
import { ActionSheetModal, ActionSheetItem } from "@/src/components/ActionSheetModal";

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

function buildHtml(inv: Invoice, biz: any, sym: string, prevBalance = 0, themeColors?: any, currencyCode: string = 'USD') {
  const sub = inv.lines.reduce((s, l) => s + lineAmt(l), 0);
  const tax = inv.taxRate ? +(sub * inv.taxRate / 100).toFixed(2) : 0;
  const invT = invTotal(inv);
  const paidOnThis = inv.status === "paid" ? invT : 0;
  const carry = +(prevBalance || 0).toFixed(2);
  const balanceDue = +(carry + invT - paidOnThis).toFixed(2);
  const money = (n: number) => `${sym}${(Number(n) || 0).toFixed(2)}`;
  const totalInWords = amountToWords(balanceDue, currencyCode);

  let primary = "#1e222b";
  let accent = "#f5a623";
  let isCleanMinimal = false;
  
  if (biz.invoiceTheme === "navy_gold") {
    primary = "#000000";
    accent = "#FDBA21";
  } else if (biz.invoiceTheme === "amoled_blue") {
    primary = "#000000";
    accent = "#3498db";
  } else if (biz.invoiceTheme === "emerald") {
    primary = "#1C4030";
    accent = "#2ecc71";
  } else if (biz.invoiceTheme === "minimal" || biz.invoiceTheme === "clean_minimal") {
    primary = "#000000";
    accent = "#000000";
    isCleanMinimal = true;
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

  const rows = inv.lines.map((l, i) =>
    `<tr>
      <td>${String(i + 1).padStart(2, "0")}</td>
      <td>${escapeHtml(l.description)}</td>
      <td>${money(lineRate(l))}</td>
      <td>${lineQty(l)} ${l.unit ? escapeHtml(l.unit) : ""}</td>
      <td>${money(lineAmt(l))}</td>
    </tr>`
  ).join("");

  if (isCleanMinimal) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invoice</title>
<style>
  @media print {
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body { background: #fff !important; padding: 0 !important; }
    .invoice { box-shadow: none !important; margin: 0 !important; border: none !important; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #e9e9e9; display: flex; justify-content: center; padding: 30px 0; color: #000; }
  .invoice { width: 800px; background: #fff; padding: 50px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 20px; margin-bottom: 30px; }
  .header-left .logo { font-size: 28px; font-weight: 800; letter-spacing: 1px; }
  .header-left img { max-height: 70px; max-width: 180px; object-fit: contain; }
  .header-right { text-align: right; font-size: 13px; line-height: 1.6; }
  .header-right strong { font-size: 24px; display: block; margin-bottom: 8px; font-weight: 700; letter-spacing: 1px; }
  .info-section { display: flex; justify-content: space-between; margin-bottom: 40px; font-size: 13px; line-height: 1.6; }
  .info-section h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 6px; }
  .meta-table { font-size: 13px; border-collapse: collapse; }
  .meta-table td { padding: 4px 0 4px 20px; text-align: right; }
  .meta-table td:first-child { color: #666; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; text-align: left; }
  .meta-table strong { font-size: 14px; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 30px; border-bottom: 2px solid #000; font-size: 13px; }
  table.items th { text-align: left; padding: 12px; border-bottom: 1px solid #000; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
  table.items th:last-child, table.items td:last-child { text-align: right; }
  table.items td { padding: 12px; border-bottom: 1px solid #eee; }
  .totals-wrapper { display: flex; justify-content: space-between; align-items: flex-start; }
  .totals-left { max-width: 60%; font-size: 12px; line-height: 1.6; }
  .totals-left h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .totals-table { width: 280px; border-collapse: collapse; font-size: 13px; }
  .totals-table td { padding: 8px 0; text-align: right; }
  .totals-table td:first-child { text-align: left; color: #666; }
  .totals-table tr.grand td { border-top: 2px solid #000; font-weight: 700; font-size: 16px; padding-top: 12px; color: #000; }
  .totals-table tr.in-words td { font-style: italic; color: #666; font-size: 11px; padding-top: 4px; text-align: right; border: none; }
  .footer { margin-top: 50px; font-size: 12px; border-top: 1px solid #eee; padding-top: 20px; color: #666; }
</style>
</head>
<body>
<div class="invoice">
  <div class="header">
    <div class="header-left">
      ${biz.logo ? `<img src="${biz.logo}" />` : `<div class="logo">Logo</div>`}
    </div>
    <div class="header-right">
      <strong>INVOICE</strong>
      ${biz.businessName ? `<div>${escapeHtml(biz.businessName)}</div>` : ''}
      ${biz.businessAddress ? `<div>${escapeHtml(biz.businessAddress)}</div>` : ''}
      ${biz.businessPhone ? `<div>${escapeHtml(biz.businessPhone)}</div>` : ''}
      ${biz.businessEmail ? `<div>${escapeHtml(biz.businessEmail)}</div>` : ''}
    </div>
  </div>
  <div class="info-section">
    <div>
      <h4>Bill To</h4>
      <div><strong>${escapeHtml(inv.clientName)}</strong></div>
      ${inv.clientPhone ? `<div>${escapeHtml(inv.clientPhone)}</div>` : ''}
      ${(inv as any).clientEmail ? `<div>${escapeHtml((inv as any).clientEmail)}</div>` : ''}
      ${(inv as any).clientAddress ? `<div>${escapeHtml((inv as any).clientAddress)}</div>` : ''}
    </div>
    <table class="meta-table">
      <tr><td>Invoice No</td><td><strong>${inv.invoiceNumber}</strong></td></tr>
      <tr><td>Date</td><td>${inv.date}</td></tr>
      ${inv.dueDate ? `<tr><td>Due Date</td><td>${inv.dueDate}</td></tr>` : ''}
    </table>
  </div>
  <table class="items">
    <thead>
      <tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
    </thead>
    <tbody>
      ${inv.lines.map(l => `<tr><td>${escapeHtml(l.description)}</td><td>${lineQty(l)} ${l.unit ? escapeHtml(l.unit) : ""}</td><td>${money(lineRate(l))}</td><td>${money(lineAmt(l))}</td></tr>`).join("")}
    </tbody>
  </table>
  <div class="totals-wrapper">
    <div class="totals-left">
      ${biz.bankAccount || biz.upiId || biz.paymentDetails ? `
        <h4>Payment Info</h4>
        ${biz.bankAccount ? `<div>${escapeHtml(biz.bankAccount)}</div>` : ''}
        ${biz.upiId ? `<div>${escapeHtml(biz.upiId)}</div>` : ''}
        ${biz.paymentDetails ? `<div>${escapeHtml(biz.paymentDetails)}</div>` : ''}
      ` : ''}
    </div>
    <table class="totals-table">
      <tr><td>Subtotal</td><td>${money(sub)}</td></tr>
      ${tax > 0 ? `<tr><td>${escapeHtml(inv.taxLabel || "Tax")} ${inv.taxRate}%</td><td>${money(tax)}</td></tr>` : ''}
      ${carry !== 0 ? `<tr><td>Previous Balance</td><td>${money(carry)}</td></tr>` : ''}
      ${paidOnThis > 0 ? `<tr><td>Amount Paid</td><td>-${money(paidOnThis)}</td></tr>` : ''}
      <tr class="grand"><td>Total Due</td><td>${money(balanceDue)}</td></tr>
      <tr class="in-words"><td colspan="2">${totalInWords}</td></tr>
    </table>
  </div>
  <div class="footer">
    ${escapeHtml(inv.terms || biz.invoiceTerms || "Thank you for your business.")}
  </div>
</div>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Invoice</title>
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
    font-size:30px;
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
          <h4>INVOICE TO</h4>
          <p>
            ${escapeHtml(inv.clientName)}<br>
            ${inv.clientPhone ? `P : ${escapeHtml(inv.clientPhone)}<br>` : ''}
            ${(inv as any).clientEmail ? `E : ${escapeHtml((inv as any).clientEmail)}<br>` : ''}
            ${(inv as any).clientAddress ? `A : ${escapeHtml((inv as any).clientAddress)}` : ''}
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
        <h1>INVOICE</h1>
      </div>
      <div class="meta">
        <div>Total Due <span>${money(balanceDue)}</span></div>
        ${inv.dueDate ? `
        <div class="divider"></div>
        <div>Due Date <span>${inv.dueDate}</span></div>` : ''}
        <div class="divider"></div>
        <div>Invoice No <span>${inv.invoiceNumber}</span></div>
      </div>
    </div>
  </div>

  <!-- Table -->
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>SL</th>
          <th>Item Description</th>
          <th>Price</th>
          <th>Quantity</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="totals">
      <div><span>Sub Total</span><span>${money(sub)}</span></div>
      ${tax > 0 ? `<div><span>${escapeHtml(inv.taxLabel || "Vat")} ${inv.taxRate}%</span><span>${money(tax)}</span></div>` : ''}
      ${carry !== 0 ? `<div><span>Previous Balance</span><span>${money(carry)}</span></div>` : ''}
      ${paidOnThis > 0 ? `<div><span>Payment Made</span><span>(-) ${money(paidOnThis)}</span></div>` : ''}
      <div class="grand"><span>Grand Total</span><span>${money(balanceDue)}</span></div>
      <div style="background:transparent;color:var(--muted);font-style:italic;font-size:10px;justify-content:flex-end;padding:10px 0 0;border:none;">${totalInWords}</div>
    </div>
  </div>

  <!-- Payment + signature -->
  <div class="footer-content">
    <div class="payment-methods">
      <h4>PAYMENT METHODS</h4>
      <ul>
        ${biz.bankAccount ? `<li>${escapeHtml(biz.bankAccount)}</li>` : ''}
        ${biz.upiId ? `<li>${escapeHtml(biz.upiId)}</li>` : ''}
        ${biz.paymentDetails ? `<li>${escapeHtml(biz.paymentDetails)}</li>` : ''}
        ${!biz.bankAccount && !biz.upiId && !biz.paymentDetails ? `<li>Cash or Check</li>` : ''}
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
    <h6>Terms &amp; Condition</h6>
    <p>${escapeHtml(inv.terms || biz.invoiceTerms || "Please remit payment at your earliest convenience.")}</p>
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
    if (!isValidDateString(date)) { setFormError("Invalid date format. Please use YYYY-MM-DD."); return; }
    if (dueDate.trim() && !isValidDateString(dueDate.trim())) { setFormError("Invalid due date format. Please use YYYY-MM-DD."); return; }
    if (!clientName.trim()) { setFormError("Client name is required"); return; }
    if (lines.every((l) => !l.description.trim())) { setFormError("Add at least one line item"); return; }
    setSaving(true); setFormError("");
    try {
      await api.findOrCreateParty(clientName.trim(), "customer", { phone: clientPhone.trim() });
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

  const markUnpaid = async (id: string) => {
    // If we mark unpaid, we might just update the metadata
    await api.updateInvoice(id, { status: "unpaid" });
    await load();
    setSelected(null);
  };

  const deleteInv = async (id: string) => {
    try {
      const paid = await api.invoicePaidAmount(id);
      if (paid > 0) {
        if (Platform.OS === "web") {
          const ok = window.confirm("This invoice has payment receipts. Delete payment receipts and reverse invoice?");
          if (ok) {
            // Delete receipts associated with invoice
            const receipts = await api.listReceipts();
            const invoiceReceipts = receipts.filter((r: any) => r.allocations?.some((a: any) => a.invoiceId === id || a.invoiceSourceId === id));
            for (const r of invoiceReceipts) await api.deleteReceipt(r.id);
            await api.deleteInvoice(id);
            await load();
            setSelected(null);
          }
        } else {
          Alert.alert(
            "Delete Invoice?",
            "This invoice has payment receipts. Delete payment receipts and reverse invoice?",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: async () => {
                const receipts = await api.listReceipts();
                const invoiceReceipts = receipts.filter((r: any) => r.allocations?.some((a: any) => a.invoiceId === id || a.invoiceSourceId === id));
                for (const r of invoiceReceipts) await api.deleteReceipt(r.id);
                await api.deleteInvoice(id);
                await load();
                setSelected(null);
              } }
            ]
          );
        }
      } else {
        await api.deleteInvoice(id);
        await load();
        setSelected(null);
      }
    } catch (e) { console.warn(e); }
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
      if (Platform.OS === 'web') {
        await printHtml(html, `Invoice ${inv.invoiceNumber}`);
      } else {
        const { uri } = await Print.printToFileAsync({ html });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Invoice ${inv.invoiceNumber}` });
      }
    } catch (e: any) { console.warn(e); }
  };

  const printInvoice = async (inv: Invoice) => {
    try {
      const prevBalance = await getPrevBalance(inv);
      const html = buildHtml(inv, biz, currSym, prevBalance, theme.color, biz.currency || 'USD');
      await printHtml(html, `Invoice ${inv.invoiceNumber}`);
    } catch (e: any) { console.warn(e); }
  };

  const shareWhatsApp = (inv: Invoice) => {
    const phone = (inv.clientPhone || "").replace(/\D/g, "");
    const msg = `Hi ${inv.clientName}, please find your invoice ${inv.invoiceNumber} for ${currSym}${invTotal(inv).toFixed(2)} dated ${inv.date}.${inv.dueDate ? ` Due: ${inv.dueDate}.` : ""}${biz.paymentDetails ? `\nPayment: ${biz.paymentDetails}` : ""}`;
    Linking.openURL(`whatsapp://send?phone=${phone}&text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  const [moreModalVisible, setMoreModalVisible] = useState(false);

  const copyTextSummary = (inv: Invoice) => {
    const msg = `Invoice ${inv.invoiceNumber}\nClient: ${inv.clientName}\nDate: ${inv.date}\nTotal: ${currSym}${invTotal(inv).toFixed(2)}\nStatus: ${inv.status.toUpperCase()}`;
    Share.share({ message: msg }).catch(() => {});
  };

  const handleMore = (inv: Invoice) => {
    setMoreModalVisible(true);
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
          <Pressable onPress={() => setSelected(null)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /><Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>Invoices</Text></Pressable>
          <Text style={styles.headerTitle}>{selected.invoiceNumber}</Text>
          <Pressable onPress={() => openEdit(selected)}><Ionicons name="create-outline" size={22} color={theme.color.brandPrimary} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
          <TransactionDetail
            title={selected.invoiceNumber}
            subtitle={`${selected.clientName} • ${shortDate(selected.date)}${(selected as any).originalDate && (selected as any).originalDate !== selected.date ? ` (was ${shortDate((selected as any).originalDate)})` : ""}`}
            badge={(selected as any).isEdited ? (<View style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.3)" }}><Text style={{ fontSize: 10, fontWeight: "700", color: "#f59e0b" }}>Edited {(selected as any).editedAt ? `• ${shortDate((selected as any).editedAt)}` : ""}</Text></View>) : undefined}
            onEdit={() => openEdit(selected)}
            onReversalDelete={() => deleteInv(selected.id)}
            onShare={() => sharePdf(selected)}
            onPrint={() => printInvoice(selected)}
            onMore={() => handleMore(selected)}
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
        <ActionSheetModal
          visible={moreModalVisible}
          onClose={() => setMoreModalVisible(false)}
          title={`Invoice ${selected.invoiceNumber}`}
          subtitle={`${selected.clientName} • ${selected.date}`}
          actions={[
            {
              id: "status",
              label: selected.status === "paid" ? "Mark as Unpaid" : "Mark as Paid",
              icon: selected.status === "paid" ? "close-circle-outline" : "checkmark-circle-outline",
              onPress: () => (selected.status === "paid" ? markUnpaid(selected.id) : markPaid(selected.id)),
            },
            {
              id: "whatsapp",
              label: "Send via WhatsApp",
              icon: "logo-whatsapp",
              onPress: () => shareWhatsApp(selected),
            },
            {
              id: "copy",
              label: "Copy Text Summary",
              icon: "copy-outline",
              onPress: () => copyTextSummary(selected),
            },
            {
              id: "pdf",
              label: "Share PDF Document",
              icon: "share-social-outline",
              onPress: () => sharePdf(selected),
            },
            {
              id: "print",
              label: "Print Document",
              icon: "print-outline",
              onPress: () => printInvoice(selected),
            },
            {
              id: "delete",
              label: "Delete / Reverse Invoice",
              icon: "trash-outline",
              destructive: true,
              onPress: () => deleteInv(selected.id),
            },
          ]}
        />
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Text style={styles.name}>{inv.clientName}</Text>
                {(inv as any).isEdited && (
                  <View style={{ backgroundColor: "rgba(245, 158, 11, 0.15)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, borderColor: "rgba(245, 158, 11, 0.3)" }}>
                    <Text style={{ fontSize: 10, fontWeight: "700", color: "#f59e0b" }}>
                      Edited {(inv as any).editedAt ? `• ${shortDate((inv as any).editedAt)}` : ""}
                    </Text>
                  </View>
                )}

              </View>
              <Text style={styles.sub}>{inv.invoiceNumber} · {shortDate(inv.date)}{(inv as any).originalDate && (inv as any).originalDate !== inv.date ? ` (was ${shortDate((inv as any).originalDate)})` : ""}{inv.dueDate ? ` · Due ${shortDate(inv.dueDate)}` : ""}</Text>
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
      <Modal visible={showForm} transparent={true} animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={() => setShowForm(false)}>
        <View style={{ flex: 1, alignItems: "center", backgroundColor: Platform.OS === "web" ? "rgba(0,0,0,0.1)" : "transparent" }}>
          <View style={{ flex: 1, width: "100%", maxWidth: 480, backgroundColor: Platform.OS === "web" ? "rgba(0,0,0,0.8)" : theme.color.surface, justifyContent: "flex-end" }}>
            <SafeAreaView style={[styles.container, { width: "100%", maxHeight: Platform.OS === "web" ? "95%" : "100%", borderTopLeftRadius: Platform.OS === "web" ? 20 : 0, borderTopRightRadius: Platform.OS === "web" ? 20 : 0, overflow: "hidden", borderWidth: Platform.OS === "web" ? 1 : 0, borderColor: theme.color.border }]} edges={["top"]}>
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
                  <PartyAutocompleteInput
                    label="Client Name *"
                    value={clientName}
                    onChangeText={setClientName}
                    placeholder="Full name or business"
                    roleFilter="all"
                  />
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
