import React, { useEffect, useMemo, useState } from "react";
import { isValidDateString, localTodayIso } from "@/src/utils/dateValidation";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView, FlatList, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { fmt, shortDate } from "@/src/theme";
import { getCurrencySymbol } from "@/src/db/local";
import { TransactionDetail } from "@/src/components/TransactionDetail";
import { printTransaction, shareTransaction } from "@/src/utils/transactionActions";
import { confirmAction } from "@/src/utils/alerts";
import { ActionSheetModal } from "@/src/components/ActionSheetModal";

type Expense = { id: string; date: string; category: string; amount: number; notes?: string };

export default function Expenses() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [selected, setSelected] = useState<Expense | null>(null);
  const [moreModalVisible, setMoreModalVisible] = useState(false);

  const [date, setDate] = useState(localTodayIso());
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const [list, settings] = await Promise.all([api.listExpenses(), api.getSettings()]);
    setExpenses([...list].sort((a: Expense, b: Expense) => b.date.localeCompare(a.date)));
    setCurrencySymbol(getCurrencySymbol(settings.currency));
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    setDate(localTodayIso());
    setCategory(""); setAmount(""); setNotes(""); setError("");
    setEditing("new");
  };

  const openEdit = (e: Expense) => {
    setDate(e.date); setCategory(e.category); setAmount(String(e.amount)); setNotes(e.notes || ""); setError("");
    setEditing(e);
  };

  const save = async () => {
    const amt = parseFloat(amount);
    if (!isValidDateString(date)) { setError("Invalid date format. Please use YYYY-MM-DD."); return; }
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    if (!category.trim()) { setError("Enter a category"); return; }
    setSaving(true); setError("");
    try {
      const payload = { date, category: category.trim(), amount: amt, notes };
      if (editing && editing !== "new") await api.updateExpense((editing as Expense).id, payload);
      else await api.createExpense(payload);
      await load();
      setEditing(null);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editing || editing === "new") return;
    setDeleting(true);
    try { await api.deleteExpense((editing as Expense).id); await load(); setEditing(null); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  const reverseExpense = (expense: Expense) => confirmAction(
    "Reverse / Delete Expense",
    "This creates the appropriate V2 reversal and removes the expense from active records.",
    async () => { await api.deleteExpense(expense.id); setSelected(null); await load(); },
    "Reverse / Delete"
  );
  const documentFor = (expense: Expense) => ({ title: `Expense: ${expense.category}`, subtitle: shortDate(expense.date), rows: [
    ["Amount", fmt(expense.amount, currencySymbol)], ["Notes", expense.notes || "—"],
  ] as Array<[string, unknown]> });

  if (selected) return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}><Pressable onPress={() => setSelected(null)}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable><Text style={styles.headerTitle}>Expense</Text><View style={{ width: 26 }} /></View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }}>
        <TransactionDetail
          title={selected.category}
          subtitle={`${fmt(selected.amount, currencySymbol)} • ${shortDate(selected.date)}`}
          onEdit={() => { setSelected(null); openEdit(selected); }}
          onReversalDelete={() => reverseExpense(selected)}
          onShare={() => shareTransaction(documentFor(selected))}
          onPrint={() => printTransaction(documentFor(selected))}
          onMore={() => setMoreModalVisible(true)}
        ><Text style={{ color: theme.color.muted }}>{selected.notes || "No notes"}</Text></TransactionDetail>
      </ScrollView>
      <ActionSheetModal
        visible={moreModalVisible}
        onClose={() => setMoreModalVisible(false)}
        title={`Expense: ${selected.category}`}
        subtitle={`${fmt(selected.amount, currencySymbol)} • ${shortDate(selected.date)}`}
        actions={[
          {
            id: "share",
            label: "Share Expense Voucher",
            icon: "share-social-outline",
            onPress: () => shareTransaction(documentFor(selected)),
          },
          {
            id: "print",
            label: "Print Voucher",
            icon: "print-outline",
            onPress: () => printTransaction(documentFor(selected)),
          },
          {
            id: "edit",
            label: "Edit Expense",
            icon: "create-outline",
            onPress: () => { setSelected(null); openEdit(selected); },
          },
          {
            id: "delete",
            label: "Delete / Reverse Expense",
            icon: "trash-outline",
            destructive: true,
            onPress: () => reverseExpense(selected),
          },
        ]}
      />
    </SafeAreaView>
  );

  if (editing !== null) {
    const isEdit = editing !== "new";
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable onPress={() => setEditing(null)}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
          <Text style={styles.headerTitle}>{isEdit ? "Edit Expense" : "Add Expense"}</Text>
          <View style={{ width: 26 }} />
        </View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
            <Card>
              <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
              <TextInput value={date} onChangeText={setDate} placeholder="2024-01-01" placeholderTextColor={theme.color.muted} style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Category</Text>
              <TextInput value={category} onChangeText={setCategory} placeholder="Rent / Electricity / Transport / Other" placeholderTextColor={theme.color.muted} style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Amount</Text>
              <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
              <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
              <TextInput value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
            </Card>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{isEdit ? "Update Expense" : "Save Expense"}</Text>}
            </Pressable>
            {isEdit ? (
              <Pressable onPress={remove} disabled={deleting} style={({ pressed }) => [{ padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm }, (pressed || deleting) && { opacity: 0.85 }]}>
                {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 14 }}>Delete Expense</Text>}
              </Pressable>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Expenses</Text>
        <Pressable onPress={openNew}><Ionicons name="add" size={26} color={theme.color.brandPrimary} /></Pressable>
      </View>
      <FlatList
        data={expenses}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: theme.spacing.lg }}
        ListEmptyComponent={<Text style={{ color: theme.color.muted, textAlign: "center", marginTop: 40 }}>No expenses yet</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1, marginBottom: theme.spacing.sm }]}>
            <Card>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "600", color: theme.color.onSurface, fontSize: 14 }}>{item.category}</Text>
                  <Text style={{ color: theme.color.muted, fontSize: 12, marginTop: 2 }}>{shortDate(item.date)}{item.notes ? ` · ${item.notes}` : ""}</Text>
                </View>
                <Text style={{ fontWeight: "700", color: theme.color.error, fontSize: 15 }}>{fmt(item.amount, currencySymbol)}</Text>
              </View>
            </Card>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
