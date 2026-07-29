import React, { useState, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { executeV2AiAction, validateV2AiAction } from "@/src/accountingV2/aiActions";

type Msg = { role: "user" | "assistant"; text: string };

async function applyAction(action: { type: string; params: any }): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const p = action.params || {};
  switch (action.type) {
    case "add_expense":
      await api.createExpense({ category: p.category || "General", amount: p.amount, date: p.date || today, notes: p.notes || "" });
      return "Expense recorded ✓";
    case "add_sale":
      await api.createSale({ amount: p.amount, date: p.date || today, paymentType: p.paymentType || "cash", notes: p.notes || "" });
      return "Sale recorded ✓";
    case "add_bill":
      await api.createBill({ supplierName: p.supplierName || "Unknown", amount: p.amount, date: p.date || today, paymentType: p.paymentType || "cash", notes: p.notes || "" });
      return "Purchase recorded ✓";
    case "add_debtor":
      await api.createDebtor({ name: p.name, phone: p.phone || "", notes: p.notes || "" });
      return `Debtor "${p.name}" added ✓`;
    case "add_debtor_payment": {
      const debtors: any[] = await api.listDebtors();
      const debtor = debtors.find((d: any) => d.name?.toLowerCase() === (p.name || "").toLowerCase());
      if (!debtor) return `Could not find debtor "${p.name}". Please add them first.`;
      await api.addDebtorPayment(debtor.id, { amount: p.amount, date: p.date || today, notes: "" });
      return `Payment from "${p.name}" recorded ✓`;
    }
    case "create_invoice": {
      const amt = Number(p.amount) || 0;
      await api.createInvoice({
        clientName: p.clientName,
        lines: [{ description: p.notes || "Service", qty: 1, rate: amt }],
        taxRate: 0,
        total: amt,
        date: p.date || today,
        notes: p.notes || "",
      });
      return `Invoice for "${p.clientName}" created ✓`;
    }
    case "create_receipt": {
      const amt = Number(p.amount) || 0;
      const mode = ["cash_sale", "against_invoice", "advance"].includes(p.mode) ? p.mode : (p.customerName ? "against_invoice" : "cash_sale");
      let debtorId: string | null = null;
      let allocations: { invoiceId: string; amountApplied: number }[] = [];
      if (mode !== "cash_sale" && p.customerName) {
        const debtors = await api.listDebtors();
        const match = debtors.find((d: any) => (d.name || "").toLowerCase().includes(String(p.customerName).toLowerCase()));
        if (match) debtorId = match.id;
        else { const c = await api.createDebtor({ name: p.customerName }); debtorId = c.id; }
        if (mode === "against_invoice") {
          const invs = (await api.listInvoices())
            .filter((i: any) => i.status !== "paid" && (i.clientName || "").toLowerCase().includes(String(p.customerName).toLowerCase()))
            .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
          if (invs[0]) allocations = [{ invoiceId: invs[0].id, amountApplied: amt }];
        }
      }
      await api.createReceipt({ mode, amount: amt, date: p.date || today, method: p.method || "cash", debtorId, clientName: p.customerName || "", allocations, notes: p.notes || "" });
      return `Receipt for ${amt.toFixed(2)} recorded ✓`;
    }
    case "create_quote": {
      const amt = Number(p.amount) || 0;
      await api.createQuote({
        clientName: p.clientName,
        lines: [{ description: p.notes || "Service", qty: 1, rate: amt }],
        taxRate: 0,
        date: p.date || today,
        notes: p.notes || "",
      });
      return `Quote for "${p.clientName}" created ✓`;
    }
    default:
      return "Unknown action — no changes made.";
  }
}

const SUGGESTIONS = [
  "What was my profit this month?",
  "How do I create an invoice?",
  "Record a 500 expense for fuel",
  "Who owes me the most money?",
];

export default function AskBooks() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const scrollRef = useRef<ScrollView>(null);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const buildContext = async (): Promise<string> => {
    const today = new Date();
    const from = `${today.getFullYear()}-01-01`;
    const to = today.toISOString().slice(0, 10);
    const [s, dash, pnlYear, creditors, debtors, expenses, invoices] = await Promise.all([
      api.getSettings(), api.dashboard(), api.pnlRange(from, to),
      api.creditorsReport(), api.debtorsReport(), api.listExpenses(), api.listInvoices(),
    ]);
    const sym = getCurrencySymbol(s.currency || "USD");
    const expenseByCat: Record<string, number> = {};
    for (const e of expenses as any[]) expenseByCat[e.category] = (expenseByCat[e.category] || 0) + Number(e.amount);
    return JSON.stringify({
      currency: s.currency, currencySymbol: sym, businessName: s.businessName,
      snapshot: {
        cash: dash.cash, inventoryValue: dash.inventoryValue, netWorth: dash.netWorth,
        totalSales: dash.totalSales, totalPurchases: dash.totalPurchases,
        grossProfit: dash.grossProfit, netProfit: dash.netProfit,
      },
      yearToDate: pnlYear,
      creditors: (creditors as any[]).filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((c) => ({ name: c.name, owed: c.balance })),
      debtors: (debtors as any[]).filter((d) => d.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((d) => ({ name: d.name, owes: d.balance })),
      expensesByCategory: expenseByCat,
      openInvoices: (invoices as any[]).filter((i) => i.status === "unpaid").sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 20).map((i) => ({ number: i.invoiceNumber, client: i.clientName, amount: i.total })),
    });
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setLoading(true);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    try {
      const context = await buildContext();
      const res: any = await api.askBooks(q, context);
      const answer = typeof res === "string" ? res : res?.answer || "";
      const action = typeof res === "string" ? null : res?.action || null;
      setMessages((m) => [...m, { role: "assistant", text: answer }]);
      if (action && action.type) {
        const v2Action = validateV2AiAction({
          source: "ai", intent: "create_payment",
          partyId: action.params?.clientName || action.params?.supplierName || action.params?.name || "AI action",
          date: action.params?.date || new Date().toISOString().slice(0, 10),
          amount: Number(action.params?.amount),
          method: ["cash", "bank", "card", "mobile", "other"].includes(action.params?.method) ? action.params.method : "cash",
          direction: action.type === "add_sale" || action.type === "create_receipt" || action.type === "add_debtor_payment" ? "received" : "paid",
        });
        if (!v2Action.ok || v2Action.action.access !== "write") {
          const errors = v2Action.ok ? ["action is not a write"] : v2Action.errors;
          setMessages((m) => [...m, { role: "assistant", text: `I couldn't validate that change: ${errors.join("; ")}` }]);
          return;
        }
        const confirmationPreview = v2Action.action.confirmation.preview;
        Alert.alert(
          "Apply this change?",
          confirmationPreview,
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Apply",
              onPress: async () => {
                try {
                  const result = await executeV2AiAction(v2Action, { confirmed: true }, () => applyAction(action));
                  setMessages((m) => [...m, { role: "assistant", text: result }]);
                } catch (err: any) {
                  setMessages((m) => [...m, { role: "assistant", text: `Couldn't apply that: ${err?.message || "error"}` }]);
                } finally {
                  setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
                }
              },
            },
          ],
        );
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `Sorry, I couldn't answer that. ${e?.message || "Check your AI key in Settings."}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Ask about your books</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }} keyboardVerticalOffset={80}>
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          {messages.length === 0 && (
            <View>
              <View style={styles.welcome}>
                <Ionicons name="sparkles-outline" size={32} color={theme.color.brandPrimary} />
                <Text style={styles.welcomeText}>Ask me anything about your finances. I'll answer using your actual data.</Text>
              </View>
              <Text style={styles.suggestLabel}>Try asking</Text>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => send(s)} style={styles.suggestChip}>
                  <Text style={styles.suggestText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {messages.map((m, i) => (
            <View key={i} style={[styles.bubble, m.role === "user" ? styles.bubbleUser : styles.bubbleAI]}>
              <Text style={[styles.bubbleText, m.role === "user" && { color: "#fff" }]}>{m.text}</Text>
            </View>
          ))}

          {loading && (
            <View style={[styles.bubble, styles.bubbleAI]}>
              <ActivityIndicator color={theme.color.brandPrimary} />
            </View>
          )}
        </ScrollView>

        <View style={styles.inputBar}>
          <Pressable style={styles.cameraBtn} onPress={() => Alert.alert("Coming soon", "Camera scanning will be available in the next update!")}>
            <Ionicons name="camera-outline" size={28} color={theme.color.muted} />
          </Pressable>
          <View style={styles.inputWrapper}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Message Ledgr AI..."
              placeholderTextColor={theme.color.muted}
              style={[styles.input, Platform.OS === 'web' && { outlineStyle: 'none' } as any]}
              multiline={true}
              showsVerticalScrollIndicator={false}
            />
            {input.trim().length > 0 ? (
              <Pressable onPress={() => send(input)} disabled={loading} style={[styles.sendBtn, loading && { opacity: 0.5 }]}>
                <Ionicons name="send" size={20} color={theme.color.brandPrimary} />
              </Pressable>
            ) : (
              <Pressable style={styles.micBtn} onPress={() => Alert.alert("Coming soon", "Voice input will be available in the next update!")}>
                <Ionicons name="mic-outline" size={22} color={theme.color.muted} />
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    welcome: { alignItems: "center", padding: theme.spacing.xl, gap: 12 },
    welcomeText: { textAlign: "center", color: theme.color.muted, fontSize: 14, lineHeight: 20 },
    suggestLabel: { fontSize: 12, fontWeight: "700", color: theme.color.muted, textTransform: "uppercase", letterSpacing: 0.5, marginTop: theme.spacing.lg, marginBottom: theme.spacing.sm },
    suggestChip: { padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, marginBottom: 8 },
    suggestText: { fontSize: 14, color: theme.color.onSurface },
    bubble: { maxWidth: "85%", padding: theme.spacing.md, borderRadius: theme.radius.md, marginBottom: theme.spacing.sm },
    bubbleUser: { alignSelf: "flex-end", backgroundColor: theme.color.brandPrimary },
    bubbleAI: { alignSelf: "flex-start", backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
    bubbleText: { fontSize: 14, lineHeight: 20, color: theme.color.onSurface },
    inputBar: { flexDirection: "row", padding: theme.spacing.md, gap: 12, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "flex-end" },
    cameraBtn: { padding: 4, justifyContent: "center", alignItems: "center" },
    inputWrapper: { flex: 1, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: theme.color.border, borderRadius: 24, backgroundColor: theme.color.surface, paddingLeft: theme.spacing.md, paddingRight: 4, paddingVertical: 6, maxHeight: 100 },
    input: { flex: 1, fontSize: 15, color: theme.color.onSurface, padding: 0, paddingVertical: 0, margin: 0, maxHeight: 96, textAlignVertical: "center" },
    micBtn: { padding: 6, justifyContent: "center", alignItems: "center", marginRight: 2 },
    sendBtn: { padding: 6, justifyContent: "center", alignItems: "center", marginRight: 2 },
  });
}
