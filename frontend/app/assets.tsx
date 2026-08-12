import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, Alert, InteractionManager } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getDataVersion } from "@/src/utils/dataVersion";
import { fmt } from "@/src/theme";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import { FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { parseMoneyInput } from "@/src/money";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";

type EntryMode = "asset" | "liability";
type BalanceEntry = { id: string; type: EntryMode; date: string; name: string; category: string; amount: number; counterparty: string; notes: string; origin?: "manual" | "opening" };

const today = () => new Date().toISOString().slice(0, 10);
const assetFunding = [
  { id: "cash", label: "Cash" }, { id: "bank", label: "Bank" },
  { id: "capital", label: "Owner Capital" }, { id: "liability", label: "Credit / Loan" },
] as const;
const liabilityRecognition = [
  { id: "expense", label: "Due / accrued expense" }, { id: "creditor", label: "Creditor / supplier due" },
  { id: "asset", label: "Asset acquired on credit" }, { id: "cash", label: "Cash received (loan)" }, { id: "bank", label: "Bank received (loan)" },
] as const;

export default function AssetsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [mode, setMode] = useState<EntryMode>("asset");
  const [entries, setEntries] = useState<BalanceEntry[]>([]);
  const [creditorsTotal, setCreditorsTotal] = useState(0);
  const [otherAssetsTotal, setOtherAssetsTotal] = useState(0);
  const [otherLiabilitiesTotal, setOtherLiabilitiesTotal] = useState(0);
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
  const [recognition, setRecognition] = useState<(typeof liabilityRecognition)[number]["id"]>("expense");
  const [editId, setEditId] = useState<string | null>(null);
  const [opening, setOpening] = useState<any>(null);
  const [openingVisible, setOpeningVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const [settings, rows, dashboard, openingBalances] = await Promise.all([api.getSettings(), api.listManualBalanceTransactions(), api.dashboard(), api.getV2OpeningBalances()]);
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
      setEntries((rows as BalanceEntry[]).map((row) => ({ ...row, origin: "manual" })));
      setCreditorsTotal(Number((dashboard as any)?.accountsPayable || 0));
      setOtherAssetsTotal(Number((dashboard as any)?.otherAssets || 0));
      setOtherLiabilitiesTotal(Number((dashboard as any)?.otherLiabilities || 0));
      setOpening(openingBalances);
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
    setEditId(null); setDate(today()); setName(""); setCategory(""); setAmount(""); setNotes(""); setFunding("cash"); setRecognition("expense"); setError("");
  };

  const edit = (entry: BalanceEntry) => {
    if (entry.origin === "opening") { setOpeningVisible(true); return; }
    setEditId(entry.id); setMode(entry.type); setDate(entry.date); setName(entry.name); setCategory(entry.category || "");
    setAmount(String(entry.amount)); setNotes(entry.notes || ""); setError("");
    if (entry.type === "asset" && assetFunding.some((option) => option.id === entry.counterparty)) setFunding(entry.counterparty as typeof funding);
    if (entry.type === "liability" && liabilityRecognition.some((option) => option.id === entry.counterparty)) setRecognition(entry.counterparty as typeof recognition);
  };

  const save = async () => {
    const value = parseMoneyInput(amount);
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setDate(dateIso); // reflect the canonical form in the field
    if (!name.trim() || !Number.isFinite(value) || value <= 0) { setError("Enter a name and a positive amount."); return; }
    setSaving(true); setError("");
    try {
      if (editId) {
        await api.updateManualBalanceTransaction(editId, mode === "asset"
          ? { date: dateIso, name: name.trim(), category: category.trim() || "Other asset", amount: value, funding, notes: notes.trim() }
          : { date: dateIso, name: name.trim(), category: category.trim() || "Other liability", amount: value, recognition, notes: notes.trim() });
      } else if (mode === "asset") {
        await api.createManualAsset({ date: dateIso, name: name.trim(), category: category.trim() || "Other asset", amount: value, funding, notes: notes.trim() });
      } else {
        await api.createManualLiability({ date: dateIso, name: name.trim(), category: category.trim() || "Other liability", amount: value, recognition, notes: notes.trim() });
      }
      resetForm();
      await load();
    } catch (e: any) { setError(e?.message || "Could not save this transaction."); }
    finally { setSaving(false); }
  };

  const remove = (entry: BalanceEntry) => {
    if (entry.origin === "opening") {
      Alert.alert("Opening balance item", "Opening items are removed from the balanced opening set so the matching accounting side can be reviewed too.", [
        { text: "Cancel", style: "cancel" },
        { text: "Review opening set", onPress: () => setOpeningVisible(true) },
      ]);
      return;
    }
    Alert.alert("Reverse this transaction?", "It will be reversed with an equal and opposite journal entry, preserving the audit trail.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reverse", style: "destructive", onPress: async () => {
        try { await api.deleteManualBalanceTransaction(entry.id); await load(); }
        catch (e: any) { setError(e?.message || "Could not reverse this transaction."); }
      } },
    ]);
  };

  const openingAssetEntries: BalanceEntry[] = (Array.isArray(opening?.assetBreakdown) ? opening.assetBreakdown : []).map((item: any, index: number) => ({
    id: `opening-asset-${index}`, type: "asset", date: opening?.date || "Opening date", name: item?.name || "Other asset",
    category: "Opening balance", amount: Number(item?.amount || 0), counterparty: "capital", notes: "", origin: "opening",
  }));
  const openingCreditorEntries: BalanceEntry[] = (Array.isArray(opening?.liabilityBreakdown) ? opening.liabilityBreakdown : []).filter((item: any) => item?.type === "creditor").map((item: any, index: number) => ({
    id: `opening-creditor-${index}`, type: "liability", date: opening?.date || "Opening date", name: item?.name || "Supplier payable",
    category: "Opening balance", amount: Number(item?.amount || 0), counterparty: "creditor", notes: "", origin: "opening",
  }));
  const openingLiabilityEntries: BalanceEntry[] = (Array.isArray(opening?.liabilityBreakdown) ? opening.liabilityBreakdown : []).filter((item: any) => item?.type !== "creditor").map((item: any, index: number) => ({
    id: `opening-liability-${index}`, type: "liability", date: opening?.date || "Opening date", name: item?.name || "Other liability",
    category: "Opening balance", amount: Number(item?.amount || 0), counterparty: "expense", notes: "", origin: "opening",
  }));
  const assetEntries = [...openingAssetEntries, ...entries.filter((entry) => entry.type === "asset")];
  const creditorEntries = [...openingCreditorEntries, ...entries.filter((entry) => entry.type === "liability" && entry.counterparty === "creditor")];
  const liabilityEntries = [...openingLiabilityEntries, ...entries.filter((entry) => entry.type === "liability" && entry.counterparty !== "creditor")];
  const isAsset = mode === "asset";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Assets & Liabilities" subtitle="Dated balance-sheet transactions" />
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} keyboardShouldPersistTaps="handled">
        <Card style={styles.guidance}>
          <Ionicons name="information-circle-outline" size={19} color={theme.color.brandPrimary} />
          <Text style={styles.guidanceText}>Use this for shop/security deposits, equipment, loans, and accrued costs. Supplier dues are created automatically by Vendor Bills and cleared by Supplier Payments.</Text>
        </Card>

        {opening ? <Card style={styles.openingCard}>
          <View style={styles.openingHeader}>
            <View style={{ flex: 1 }}><Text style={styles.cardTitle}>Opening Assets & Liabilities</Text><Text style={styles.hint}>One balanced opening journal · {opening.date || "opening date"}</Text></View>
            <Pressable testID="edit-opening-balance-set" onPress={() => setOpeningVisible(true)} style={styles.editOpeningBtn}><Ionicons name="pencil-outline" size={16} color={theme.color.brandPrimary} /><Text style={styles.editOpeningText}>Edit</Text></Pressable>
          </View>
          <Text style={styles.openingHelp}>{openingAssetEntries.length} opening asset{openingAssetEntries.length === 1 ? "" : "s"} · {openingCreditorEntries.length + openingLiabilityEntries.length} opening liabilit{openingCreditorEntries.length + openingLiabilityEntries.length === 1 ? "y" : "ies"}. They are listed below with their current balances.</Text>
        </Card> : null}

        <View style={styles.modeRow}>
          <Pressable onPress={() => { if (mode !== "asset") resetForm(); setMode("asset"); setError(""); }} style={[styles.modeBtn, isAsset && styles.modeActive]}><Text style={[styles.modeText, isAsset && styles.modeTextActive]}>Add Asset</Text></Pressable>
          <Pressable onPress={() => { if (mode !== "liability") resetForm(); setMode("liability"); setError(""); }} style={[styles.modeBtn, !isAsset && styles.modeActive]}><Text style={[styles.modeText, !isAsset && styles.modeTextActive]}>Add Liability</Text></Pressable>
        </View>

        <Card>
          <View style={styles.formTitleRow}>
            <View style={styles.formIcon}><Ionicons name={isAsset ? "business-outline" : "document-text-outline"} size={19} color={theme.color.brandPrimary} /></View>
            <View><Text style={styles.cardTitle}>{editId ? `Edit ${isAsset ? "Asset" : "Liability"}` : (isAsset ? "Record an Asset" : "Record a Liability")}</Text><Text style={styles.hint}>{isAsset ? "Debit asset; credit the selected funding source." : "A liability is normally due, not cash received; choose what created the obligation."}</Text></View>
          </View>
          <FormField label="Transaction date" first value={date} onChangeText={setDate} onBlur={() => { if (date.trim()) setDate(normalizeDateInput(date)); }} placeholder="YYYY-MM-DD" />
          <FormField label={isAsset ? "Asset name" : "Liability name"} value={name} onChangeText={setName} placeholder={isAsset ? "e.g. Shop security deposit" : "e.g. Business loan"} />
          <FormField label="Category (optional)" value={category} onChangeText={setCategory} placeholder={isAsset ? "Deposit, equipment, receivable" : "Loan, accrued rent, tax payable"} />
          <FormField label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
          <Text style={styles.labelSpaced}>{isAsset ? "Funded from" : "Liability arose from"}</Text>
          <View style={styles.chips}>
            {(isAsset ? assetFunding : liabilityRecognition).map((option) => {
              const active = isAsset ? funding === option.id : recognition === option.id;
              return <Pressable key={option.id} onPress={() => isAsset ? setFunding(option.id as typeof funding) : setRecognition(option.id as typeof recognition)} style={[styles.chip, active && styles.chipActive]}><Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text></Pressable>;
            })}
          </View>
          <FormField label="Notes (optional)" multiline value={notes} onChangeText={setNotes} placeholder="Reference or explanation" />
          <FormActions primaryLabel={editId ? "Save Correction" : "Post to Accounts"} onPrimary={save} primaryBusy={saving} error={error} />
          {editId ? <Pressable onPress={resetForm} style={{ alignItems: "center", paddingTop: 12 }}><Text style={{ color: theme.color.muted, fontWeight: "600" }}>Cancel editing</Text></Pressable> : null}
        </Card>

        <BalanceList title="Other Assets & Deposits" icon="business-outline" entries={assetEntries} total={otherAssetsTotal} currSym={currSym} styles={styles} onEdit={edit} onDelete={remove} theme={theme} />
        <BalanceList title="Creditors / Supplier Payable" icon="people-outline" entries={creditorEntries} total={creditorsTotal} currSym={currSym} styles={styles} onEdit={edit} onDelete={remove} theme={theme} emptyText="No opening creditor breakdown. Vendor bills remain available from Suppliers." />
        <BalanceList title="Other Liabilities" icon="document-text-outline" entries={liabilityEntries} total={otherLiabilitiesTotal} currSym={currSym} styles={styles} onEdit={edit} onDelete={remove} theme={theme} />
        <View style={{ height: 120 }} />
      </ScrollView>
      <OpeningBalancesModal visible={openingVisible} mode="assets_liabilities" onClose={() => setOpeningVisible(false)} onSuccess={() => { setOpeningVisible(false); setLoading(true); load(); }} />
    </SafeAreaView>
  );
}

function BalanceList({ title, icon, entries, total, currSym, styles, onEdit, onDelete, theme, emptyText = "No posted transactions yet." }: { title: string; icon: any; entries: BalanceEntry[]; total: number; currSym: string; styles: any; onEdit: (entry: BalanceEntry) => void; onDelete: (entry: BalanceEntry) => void; theme: any; emptyText?: string }) {
  return <Card style={styles.listCard}>
    <View style={styles.listTitleRow}><View style={styles.listIcon}><Ionicons name={icon} size={17} color={theme.color.brandPrimary} /></View><Text style={styles.cardTitle}>{title}</Text></View>
    {!entries.length ? <Text style={styles.empty}>{emptyText}</Text> : entries.map((entry) => <View key={entry.id} style={styles.entry}>
      <View style={{ flex: 1 }}><Text style={styles.entryName}>{entry.name}</Text><Text style={styles.entryMeta}>{entry.date}{entry.category ? ` · ${entry.category}` : ""}{entry.notes ? ` · ${entry.notes}` : ""}</Text></View>
      <View style={styles.entryRight}><Text style={styles.entryAmount}>{fmt(entry.amount, currSym)}</Text><View style={{ flexDirection: "row", gap: 12 }}><Pressable onPress={() => onEdit(entry)} hitSlop={10}><Ionicons name="pencil-outline" size={16} color={theme.color.brandPrimary} /></Pressable><Pressable onPress={() => onDelete(entry)} hitSlop={10}><Ionicons name="trash-outline" size={16} color={theme.color.muted} /></Pressable></View></View>
    </View>)}
    <View style={styles.totalRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.total}>{fmt(total, currSym)}</Text></View>
  </Card>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl },
  guidance: { flexDirection: "row", gap: 9, alignItems: "flex-start", marginBottom: theme.spacing.md },
  guidanceText: { flex: 1, color: theme.color.muted, fontSize: 12, lineHeight: 18 },
  openingCard: { marginBottom: theme.spacing.md }, openingHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }, editOpeningBtn: { flexDirection: "row", gap: 5, alignItems: "center", borderWidth: 1, borderColor: theme.color.brandPrimary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 7 }, editOpeningText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "700" }, openingLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: theme.color.border }, openingCredit: { color: theme.color.warning }, openingHelp: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 10 },
  modeRow: { flexDirection: "row", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: 3, marginBottom: theme.spacing.md },
  modeBtn: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: theme.radius.sm }, modeActive: { backgroundColor: theme.color.brandPrimary },
  modeText: { color: theme.color.muted, fontWeight: "700", fontSize: 13 }, modeTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  formTitleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md }, formIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface }, hint: { color: theme.color.muted, fontSize: 11, marginTop: 2 },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  labelSpaced: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface, marginTop: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 }, chip: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 10 }, chipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary }, chipText: { color: theme.color.onSurface, fontSize: 12, fontWeight: "600" }, chipTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  listCard: { marginTop: theme.spacing.md }, listTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: theme.spacing.sm }, listIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  empty: { color: theme.color.muted, fontSize: 12, paddingVertical: theme.spacing.sm }, entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border }, entryName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "700" }, entryMeta: { color: theme.color.muted, fontSize: 11, marginTop: 3 }, entryRight: { alignItems: "flex-end", gap: 7 }, entryAmount: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: theme.spacing.md, marginTop: 2 }, totalLabel: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" }, total: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
}); }
