import React, { useCallback, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform, Linking, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt, shortDate } from "@/src/theme";
import { Card } from "@/src/components/UI";

type Debtor = {
  id: string;
  name: string;
  phone?: string;
  notes?: string;
  payments: { id: string; amount: number; date: string; notes?: string }[];
  totalInvoiced?: number;
  totalPaid?: number;
  balance?: number;
};

export default function DebtorsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [currency, setCurrency] = useState("$");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Debtor | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addNotes, setAddNotes] = useState("");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState("");

  const [showPay, setShowPay] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payNotes, setPayNotes] = useState("");
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState("");

  const load = useCallback(async () => {
    try {
      const [raw, settings] = await Promise.all([api.listDebtors(), api.getSettings()]);
      const enriched = (raw as Debtor[]).map((d) => {
        const totalInvoiced = (d as any).totalInvoiced ?? 0;
        const totalPaid = (d.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
        return { ...d, totalInvoiced, totalPaid, balance: +(totalInvoiced - totalPaid).toFixed(2) };
      });
      setDebtors(enriched);
      const sym = (settings as any).currency ?? "USD";
      const symMap: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", AED: "د.إ", CAD: "CA$", AUD: "A$", NGN: "₦", KES: "KSh", ZAR: "R", BDT: "৳", PKR: "₨", PHP: "₱", MXN: "MX$", BRL: "R$" };
      setCurrency(symMap[sym] ?? sym);
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const saveDebtor = async () => {
    if (!addName.trim()) { setAddError("Name is required"); return; }
    setAddSaving(true); setAddError("");
    try {
      await api.createDebtor({ name: addName.trim(), phone: addPhone.trim(), notes: addNotes.trim() });
      setShowAdd(false); setAddName(""); setAddPhone(""); setAddNotes("");
      await load();
    } catch (e: any) { setAddError(e.message); }
    finally { setAddSaving(false); }
  };

  const recordPayment = async () => {
    if (!selected) return;
    const amt = parseFloat(payAmount);
    if (!amt || amt <= 0) { setPayError("Enter a valid amount"); return; }
    setPaySaving(true); setPayError("");
    try {
      const updated = await api.addDebtorPayment(selected.id, { amount: amt, date: payDate, notes: payNotes.trim() });
      const totalInvoiced = (updated as any).totalInvoiced ?? selected.totalInvoiced ?? 0;
      const totalPaid = ((updated as any).payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
      setSelected({ ...updated, totalInvoiced, totalPaid, balance: +(totalInvoiced - totalPaid).toFixed(2) });
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
          <Text style={styles.headerTitle}>Debtor Detail</Text>
          <View style={{ width: 26 }} />
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
              <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 12 }}>
                <View style={{ alignItems: "center" }}>
                  <Text style={styles.smLabel}>Invoiced</Text>
                  <Text style={styles.smVal}>{currency}{(selected.totalInvoiced ?? 0).toFixed(2)}</Text>
                </View>
                <View style={{ alignItems: "center" }}>
                  <Text style={styles.smLabel}>Paid</Text>
                  <Text style={styles.smVal}>{currency}{(selected.totalPaid ?? 0).toFixed(2)}</Text>
                </View>
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md }}>
              <Pressable onPress={() => { setPayAmount(""); setPayDate(new Date().toISOString().slice(0, 10)); setPayNotes(""); setPayError(""); setShowPay(true); }} style={styles.actionBtn}>
                <Ionicons name="cash-outline" size={16} color="#fff" />
                <Text style={styles.actionText}>Record Payment</Text>
              </Pressable>
              {selected.phone ? (
                <Pressable onPress={() => sendWhatsApp(selected)} style={[styles.actionBtn, { backgroundColor: "#25D366" }]}>
                  <Ionicons name="logo-whatsapp" size={16} color="#fff" />
                  <Text style={styles.actionText}>WhatsApp Reminder</Text>
                </Pressable>
              ) : null}
            </View>
          </Card>

          <Text style={styles.section}>Payments</Text>
          {(selected.payments || []).length === 0 ? (
            <Text style={styles.empty}>No payments recorded yet.</Text>
          ) : [...(selected.payments || [])].sort((a, b) => (a.date < b.date ? 1 : -1)).map((p) => (
            <View key={p.id} style={styles.timelineRow}>
              <View style={[styles.timelineDot, { backgroundColor: theme.color.success }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.tlTitle}>Payment • {shortDate(p.date)}</Text>
                {p.notes ? <Text style={styles.tlSub}>{p.notes}</Text> : null}
              </View>
              <Text style={[styles.tlAmount, { color: theme.color.success }]}>{currency}{Number(p.amount).toFixed(2)}</Text>
            </View>
          ))}
          <View style={{ height: 60 }} />
        </ScrollView>

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
                <Text style={styles.headerTitle}>Add Debtor</Text>
                <Pressable onPress={() => setShowAdd(false)}><Ionicons name="close" size={24} color={theme.color.onSurface} /></Pressable>
              </View>
              <Text style={styles.label}>Name *</Text>
              <TextInput value={addName} onChangeText={setAddName} placeholder="Full name" placeholderTextColor={theme.color.muted} style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Phone</Text>
              <TextInput value={addPhone} onChangeText={setAddPhone} placeholder="+123****7890" placeholderTextColor={theme.color.muted} keyboardType="phone-pad" style={styles.input} />
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
    actionBtn: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: 12, borderRadius: theme.radius.md },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 13 },
    section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
    empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.lg },
    timelineRow: { flexDirection: "row", alignItems: "center", backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginBottom: theme.spacing.sm, gap: theme.spacing.md },
    timelineDot: { width: 10, height: 10, borderRadius: 5 },
    tlTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    tlSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    tlAmount: { fontSize: 14, fontWeight: "700" },
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
