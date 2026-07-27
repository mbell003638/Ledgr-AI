import { Alert } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

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
};

export function transactionHtml(document: TransactionDocument) {
  const rows = document.rows.map(([label, value]) =>
    `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:sans-serif;padding:32px;color:#202020}h1{font-size:24px;margin-bottom:4px}
    p{color:#666;margin-top:0}table{width:100%;border-collapse:collapse;margin-top:24px}
    th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}th{width:35%;color:#555}
  </style></head><body><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.subtitle)}</p><table>${rows}</table></body></html>`;
}

export async function printTransaction(document: TransactionDocument) {
  await Print.printAsync({ html: transactionHtml(document) });
}

export async function shareTransaction(document: TransactionDocument) {
  const { uri } = await Print.printToFileAsync({ html: transactionHtml(document) });
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Sharing unavailable", "This device cannot share files.");
    return;
  }
  await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: document.title });
}
