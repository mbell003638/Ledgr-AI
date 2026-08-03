import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, RefreshControl, Alert, InteractionManager } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getDataVersion } from "@/src/utils/dataVersion";
import { fmt } from "@/src/theme";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";

type EntryMode = "asset" | "liability";
type BalanceEntry = { id: string; type: EntryMode; date: string; name: string; category: string; amount: number; counterparty: string; notes: string };

const today = () => new Date().toISOString().slice(0, 10);
const assetFunding = [
  { id: "cash", label: "Cash" }, { id: "bank", label: "Bank" },
  { id: "capital", label: "Owner Capital" }, { id: "liability", label: "Credit / Loan" },
] as const;
const liabilityRecognition = [
  { id: "cash", label: "Cash received" }, { id: "bank", label: "Bank received" },
  { id: "asset", label: "Asset acquired" }, { id: "expense", label: "Expense accrued" },
] as const;

export default function AssetsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [mode, setMode] = useState<EntryMode>("asset");
  const [entries, setEntries] = useState<BalanceEntry[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(today());
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [funding, setFunding] = useState<(typeof assetFunding)[number]["id"]>("cash");
  const [recognition, setRecognition] = useState<(typeof liabilityRecognition)[number]["id"]>("cash");

  const load = useCallback(async () => {
    try {
      setError("");
      const [settings, rows] = await Promise.all([api.getSettings(), api.listManualBalanceTransactions()]);
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
      setEntries(rows as BalanceEntry[]);
      loadedVersion.current = getDataVersion();
    } catch (e: any) {
      setError(e?.message || "Could not load balance transactions.");
    } finally { setLoading(false); }
  }, []);

  const loadedVersion = React.useRef<number>(-1);
  useFocusEffect(useCallback(() => {
    if (loadedVersion.current === getDataVersion()) return;
    const task = InteractionManager.runAfterInteractions(() => { load(); });
    return () => task.cancel();
  }, [load]));

  const resetForm = () => {
    setDate(today()); setName(""); setCategory(""); setAmount(""); setNotes(""); setFunding("cash"); setRecognition("cash"); setError("");
  };

  const save = async () => {
    const value = Number(amount);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError("Use a valid date in YYYY-MM-DD format."); return; }
    if (!name.trim() || !Number.isFinite(value) || value <= 0) { setError("Enter a name and a positive amount."); return; }
    setSaving(true); setError("");
    try {
      if (mode === "asset") {
        await api.createManualAsset({ date, name: name.trim(), category: category.trim() || "Other asset", amount: value, funding, notes: notes.trim() });
      } else {
        await api.createManualLiability({ date, name: name.trim(), category: category.trim() || "Other liability", amount: value, recognition, notes: notes.trim() });
      }
      resetForm();
      await load();
    } catch (e: any) { setError(e?.message || "Could not save this transaction."); }
    finally { setSaving(false); }
  };

  const remove = (entry: BalanceEntry) => {
    Alert.alert("Reverse this transaction?", "It will be reversed with an equal and opposite journal entry, preserving the audit trail.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reverse", style: "destructive", onPress: async () => {
        try { await api.deleteManualBalanceTransaction(entry.id); await load(); }
        catch (e: any) { setError(e?.message || "Could not reverse this transaction."); }
      } },
    ]);
  };

  const assetEntries = entries.filter((entry) => entry.type === "asset");
  const liabilityEntries = entries.filter((entry) => entry.type === "liability");
  const totalAssets = assetEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const totalLiabilities = liabilityEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const isAsset = mode === "asset";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Assets & Liabilities" subtitle="Dated balance-sheet transactions" />
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} keyboardShouldPersistTaps="handled">
        <Card style={styles.guidance}>
          <Ionicons name="information-circle-outline" size={19} color={theme.color.brandPrimary} />
          <Text style={styles.guidanceText}>Use this for shop/security deposits, equipment, loans, and accrued costs. Supplier dues are created automatically by Vendor Bills and cleared by Supplier Payments.</Text>
        </Card>

        <View style={styles.modeRow}>
          <Pressable onPress={() => { setMode("asset"); setError(""); }} style={[styles.modeBtn, isAsset && styles.modeActive]}><Text style={[styles.modeText, isAsset && styles.modeTextActive]}>Add Asset</Text></Pressable>
          <Pressable onPress={() => { setMode("liability"); setError(""); }} style={[styles.modeBtn, !isAsset && styles.modeActive]}><Text style={[styles.modeText, !isAsset && styles.modeTextActive]}>Add Liability</Text></Pressable>
        </View>

        <Card>
          <View style={styles.formTitleRow}>
            <View style={styles.formIcon}><Ionicons name={isAsset ? "business-outline" : "document-text-outline"} size={19} color={theme.color.brandPrimary} /></View>
            <View><Text style={styles.cardTitle}>{isAsset ? "Record an Asset" : "Record a Liability"}</Text><Text style={styles.hint}>{isAsset ? "Debit asset; credit the selected funding source." : "Credit liability; debit the selected recognition account."}</Text></View>
          </View>
          <Text style={styles.label}>Transaction date</Text>
          <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
          <Text style={styles.label}>{isAsset ? "Asset name" : "Liability name"}</Text>
          <TextInput value={name} onChangeText={setName} placeholder={isAsset ? "e.g. Shop security deposit" : "e.g. Business loan"} placeholderTextColor={theme.color.muted} style={styles.input} />
          <Text style={styles.label}>Category (optional)</Text>
          <TextInput value={category} onChangeText={setCategory} placeholder={isAsset ? "Deposit, equipment, receivable" : "Loan, accrued rent, tax payable"} placeholderTextColor={theme.color.muted} style={styles.input} />
          <Text style={styles.label}>Amount</Text>
          <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
          <Text style={styles.label}>{isAsset ? "Funded from" : "Liability arose from"}</Text>
          <View style={styles.chips}>
            {(isAsset ? assetFunding : liabilityRecognition).map((option) => {
              const active = isAsset ? funding === option.id : recognition === option.id;
              return <Pressable key={option.id} onPress={() => isAsset ? setFunding(option.id as typeof funding) : setRecognition(option.id as typeof recognition)} style={[styles.chip, active && styles.chipActive]}><Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text></Pressable>;
            })}
          </View>
          <Text style={styles.label}>Notes (optional)</Text>
          <TextInput value={notes} onChangeText={setNotes} placeholder="Reference or explanation" placeholderTextColor={theme.color.muted} style={[styles.input, styles.notes]} multiline />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <GlowPressable onPress={save} disabled={saving} haptic topHighlight={false} style={styles.saveBtn}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Post to Accounts</Text>}</GlowPressable>
        </Card>

        <BalanceList title="Other Assets & Deposits" icon="business-outline" entries={assetEntries} total={totalAssets} currSym={currSym} styles={styles} onDelete={remove} theme={theme} />
        <BalanceList title="Other Liabilities" icon="document-text-outline" entries={liabilityEntries} total={totalLiabilities} currSym={currSym} styles={styles} onDelete={remove} theme={theme} />
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function BalanceList({ title, icon, entries, total, currSym, styles, onDelete, theme }: { title: string; icon: any; entries: BalanceEntry[]; total: number; currSym: string; styles: any; onDelete: (entry: BalanceEntry) => void; theme: any }) {
  return <Card style={styles.listCard}>
    <View style={styles.listTitleRow}><View style={styles.listIcon}><Ionicons name={icon} size={17} color={theme.color.brandPrimary} /></View><Text style={styles.cardTitle}>{title}</Text></View>
    {!entries.length ? <Text style={styles.empty}>No posted transactions yet.</Text> : entries.map((entry) => <View key={entry.id} style={styles.entry}>
      <View style={{ flex: 1 }}><Text style={styles.entryName}>{entry.name}</Text><Text style={styles.entryMeta}>{entry.date}{entry.category ? ` · ${entry.category}` : ""}{entry.notes ? ` · ${entry.notes}` : ""}</Text></View>
      <View style={styles.entryRight}><Text style={styles.entryAmount}>{fmt(entry.amount, currSym)}</Text><Pressable onPress={() => onDelete(entry)} hitSlop={10}><Ionicons name="trash-outline" size={16} color={theme.color.muted} /></Pressable></View>
    </View>)}
    <View style={styles.totalRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.total}>{fmt(total, currSym)}</Text></View>
  </Card>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl },
  guidance: { flexDirection: "row", gap: 9, alignItems: "flex-start", marginBottom: theme.spacing.md },
  guidanceText: { flex: 1, color: theme.color.muted, fontSize: 12, lineHeight: 18 },
  modeRow: { flexDirection: "row", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: 3, marginBottom: theme.spacing.md },
  modeBtn: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: theme.radius.sm }, modeActive: { backgroundColor: theme.color.brandPrimary },
  modeText: { color: theme.color.muted, fontWeight: "700", fontSize: 13 }, modeTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  formTitleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md }, formIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface }, hint: { color: theme.color.muted, fontSize: 11, marginTop: 2 },
  label: { fontSize: 12, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.sm },
  input: { marginTop: 5, borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface, backgroundColor: theme.color.surface }, notes: { minHeight: 65, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 }, chip: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 10 }, chipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary }, chipText: { color: theme.color.onSurface, fontSize: 12, fontWeight: "600" }, chipTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  error: { color: theme.color.error, fontSize: 12, marginTop: 10 }, saveBtn: { marginTop: theme.spacing.lg, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, padding: theme.spacing.md, alignItems: "center" }, saveText: { color: theme.color.onBrandPrimary || "#fff", fontSize: 14, fontWeight: "800" },
  listCard: { marginTop: theme.spacing.md }, listTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: theme.spacing.sm }, listIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  empty: { color: theme.color.muted, fontSize: 12, paddingVertical: theme.spacing.sm }, entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border }, entryName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "700" }, entryMeta: { color: theme.color.muted, fontSize: 11, marginTop: 3 }, entryRight: { alignItems: "flex-end", gap: 7 }, entryAmount: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: theme.spacing.md, marginTop: 2 }, totalLabel: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" }, total: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
}); }