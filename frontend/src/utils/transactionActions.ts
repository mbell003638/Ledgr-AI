import { Platform } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { printHtml } from "@/src/utils/print";
import { amountToWords } from "@/src/utils/numberToWords";
import { showAlert } from "@/src/utils/alerts";
import { api } from "@/src/api";

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

export type TransactionDocument = {
  title: string;
  subtitle?: string;
  rows: Array<[string, unknown]>;
  amount?: number;
  themeColors?: any;
  biz?: any;
  currencyCode?: string;
};

export function transactionHtml(doc: TransactionDocument, themeColors?: any, bizInfo?: any, currCode: string = 'USD') {
  const biz = bizInfo || doc.biz || {};
  let primary = "#000000";
  let accent = "#FDBA21";

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
    const tc = themeColors || doc.themeColors || {};
    primary = tc.surfaceInverse || tc.surface || "#000000";
    accent  = tc.brandPrimary || tc.brand || "#3498db";
  }

  const tableRows = doc.rows.map(([label, value], i) => `
    <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
      <td style="font-weight:700;color:${primary};width:35%">${escapeHtml(label)}</td>
      <td style="text-align:right">${escapeHtml(value)}</td>
    </tr>
  `).join("");

  let totalWords = "";
  if (doc.amount && Number.isFinite(doc.amount)) {
    totalWords = amountToWords(Math.abs(doc.amount), currCode);
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @media print {
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
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
    .header-logo-text { font-size: 48px; font-weight: 900; color: #fff; letter-spacing: 2px; }
    .header-logo { max-height: 80px; max-width: 180px; object-fit: contain; }
    .header-right { width: 60%; padding: 35px 40px; box-sizing: border-box; }
    .doc-to-title { color: ${accent}; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .biz-name { font-size: 16px; font-weight: 700; color: #ffffff; margin-bottom: 4px; text-transform: uppercase; }
    .contact-item { display: flex; align-items: center; margin-bottom: 4px; font-size: 11px; color: #fff; }
    .banner-content { display: flex; height: 100px; position: relative; z-index: 10; }
    .banner-left { width: 40%; padding: 0 40px; display: flex; align-items: center; justify-content: center; }
    .doc-heading { font-size: 32px; font-weight: 900; color: #111; letter-spacing: 2px; text-transform: uppercase; margin: 0; }
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
    .amount-words { background: #fff; padding: 12px 14px; font-size: 11px; font-style: italic; color: #555; text-align: right; border-top: 2px solid ${accent}; margin-top: 10px; }
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
        ${biz.logo ? `<img src="${biz.logo}" class="header-logo" />` : `<div class="header-logo-text">${escapeHtml(biz.businessName || "Ledgr")}</div>`}
      </div>
      <div class="header-right">
        <div class="doc-to-title">TRANSACTION RECORD</div>
        <div class="biz-name">${escapeHtml(biz.businessName || "Ledgr")}</div>
        ${biz.businessPhone ? `<div class="contact-item">P: ${escapeHtml(biz.businessPhone)}</div>` : ''}
        ${biz.businessEmail ? `<div class="contact-item">E: ${escapeHtml(biz.businessEmail)}</div>` : ''}
      </div>
    </div>

    <div class="banner-content">
      <div class="banner-left">
        <h1 class="doc-heading">${escapeHtml(doc.title)}</h1>
      </div>
      <div class="banner-right">
        <div class="banner-col">
          <div class="banner-label">Date</div>
          <div class="banner-val">${escapeHtml(doc.subtitle || new Date().toLocaleDateString())}</div>
        </div>
      </div>
    </div>

    <div class="content">
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th style="text-align:right">Value</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>

      ${totalWords ? `<div class="amount-words">Amount in words: <b>${totalWords}</b></div>` : ''}
    </div>

    <div class="footer-bar">
      <div class="thank-you">Thank you for your business</div>
      <div>This is an official transaction record generated by Ledgr.</div>
    </div>
  </div>
</body>
</html>`;
}

export async function printTransaction(doc: TransactionDocument, themeColors?: any, biz?: any) {
  try {
    const s = biz || await api.getSettings().catch(() => ({}));
    const html = transactionHtml(doc, themeColors, s, s.currency || 'USD');
    await printHtml(html, doc.title);
  } catch (e: any) {
    showAlert("Print Failed", e?.message || "Could not print document.");
  }
}

export async function shareTransaction(doc: TransactionDocument, themeColors?: any, biz?: any) {
  try {
    const s = biz || await api.getSettings().catch(() => ({}));
    const html = transactionHtml(doc, themeColors, s, s.currency || 'USD');
    if (Platform.OS === 'web') {
      await printHtml(html, doc.title);
    } else {
      const { uri } = await Print.printToFileAsync({ html });
      const can = await Sharing.isAvailableAsync();
      if (can) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: doc.title });
      } else {
        showAlert("Sharing Unavailable", "Sharing is not available on this device.");
      }
    }
  } catch (e: any) {
    showAlert("Share Failed", e?.message || "Could not share document.");
  }
}
