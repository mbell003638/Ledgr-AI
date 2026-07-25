import React, { useState, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";

type Msg = { role: "user" | "assistant"; text: string };

const SUGGESTIONS = [
  "What was my profit this month?",
  "Who owes me the most money?",
  "What are my biggest expenses?",
  "How much do I owe suppliers?",
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
      const answer = await api.askBooks(q, context);
      setMessages((m) => [...m, { role: "assistant", text: answer }]);
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
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask a question..."
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            onSubmitEditing={() => send(input)}
            returnKeyType="send"
          />
          <Pressable onPress={() => send(input)} disabled={loading || !input.trim()} style={[styles.sendBtn, (loading || !input.trim()) && { opacity: 0.5 }]}>
            <Ionicons name="arrow-up" size={20} color="#fff" />
          </Pressable>
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
    inputBar: { flexDirection: "row", padding: theme.spacing.md, gap: 8, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" },
    input: { flex: 1, borderWidth: 1, borderColor: theme.color.border, borderRadius: 24, paddingHorizontal: theme.spacing.md, paddingVertical: 10, fontSize: 14, color: theme.color.onSurface, backgroundColor: theme.color.surface },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.color.brandPrimary, alignItems: "center", justifyContent: "center" },
  });
}
