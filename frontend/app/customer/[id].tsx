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

  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [selected, setSelected] = useState<Debtor | null>(null);
  const [statement, setStatement] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [currency, setCurrency] = useState("$");
  const [currCode, setCurrCode] = useState("USD");
  const [biz, setBiz] = useState<any>({});

  const load = useCallback(async () => {
    try {
      const [raw, settings] = await Promise.all([api.listDebtors(), api.getSettings()]);
      setBiz(settings);
      const code = settings.currency || "USD";
      setCurrCode(code);
      setCurrency(getCurrencySymbol(code));

      const enriched = (raw as any[]).map((d) => {
        const invoiced = Number(d.totalInvoiced) || 0;
        const paid = Number(d.totalPaid) || 0;
        return { ...d, totalInvoiced: invoiced, totalPaid: paid, balance: d.balance ?? invoiced - paid };
      });
      setDebtors(enriched);

      if (id) {
        const found = enriched.find((d) => d.id === id);
        if (found) {
          setSelected(found);
          const stmt = await api.getDebtorStatement(found.id);
          setStatement(stmt);
        }
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

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
      await printHtml(buildStatementHtml(selected, statement, biz, currency, theme.color, currCode));
    } catch (e: any) { console.warn(e); }
  };

  if (loading) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{selected ? selected.name : "Customer Statement"}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        {selected ? (
          <Card>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <View>
                <Text style={{ fontSize: 18, fontWeight: "700", color: theme.color.onSurface }}>{selected.name}</Text>
                {selected.phone ? <Text style={{ fontSize: 13, color: theme.color.muted }}>{selected.phone}</Text> : null}
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ fontSize: 11, color: theme.color.muted, textTransform: "uppercase" }}>Balance Due</Text>
                <Text style={{ fontSize: 18, fontWeight: "800", color: theme.color.brandPrimary }}>{currency}{Number(selected.balance || 0).toFixed(2)}</Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 8, marginTop: 12, marginBottom: 16 }}>
              <Pressable onPress={shareStatementPdf} style={[styles.actBtn, { backgroundColor: theme.color.brandPrimary, flex: 1 }]}>
                <Ionicons name="document-text-outline" size={14} color="#fff" />
                <Text style={styles.actBtnText}>PDF Statement</Text>
              </Pressable>
              <Pressable onPress={printStatement} style={[styles.actBtn, { backgroundColor: theme.color.brandSecondary, flex: 1 }]}>
                <Ionicons name="print-outline" size={14} color="#fff" />
                <Text style={styles.actBtnText}>Print</Text>
              </Pressable>
            </View>

            <Text style={{ fontSize: 14, fontWeight: "700", color: theme.color.onSurface, marginBottom: 8 }}>Transaction History</Text>
            {(statement?.ledger || []).length === 0 ? (
              <Text style={{ fontSize: 13, color: theme.color.muted }}>No transactions recorded yet.</Text>
            ) : (
              (statement?.ledger || []).map((r: any, idx: number) => (
                <View key={idx} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.color.border }}>
                  <View>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }}>{r.ref || r.kind}</Text>
                    <Text style={{ fontSize: 11, color: theme.color.muted }}>{shortDate(r.date)}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    {r.debit ? <Text style={{ fontSize: 13, fontWeight: "700", color: theme.color.error }}>+{currency}{r.debit.toFixed(2)}</Text> : null}
                    {r.credit ? <Text style={{ fontSize: 13, fontWeight: "700", color: theme.color.success }}>-{currency}{r.credit.toFixed(2)}</Text> : null}
                    <Text style={{ fontSize: 11, color: theme.color.muted }}>Bal: {currency}{r.balance.toFixed(2)}</Text>
                  </View>
                </View>
              ))
            )}
          </Card>
        ) : (
          <Text style={{ color: theme.color.muted, textAlign: "center", marginTop: 40 }}>Select a customer from the Parties tab to view statement.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    actBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: theme.radius.md },
    actBtnText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  });
}
