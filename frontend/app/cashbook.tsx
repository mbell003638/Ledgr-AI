import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, TextInput, Alert, KeyboardAvoidingView, Platform, InteractionManager } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { getDataVersion } from "@/src/utils/dataVersion";
import { confirmAction } from "@/src/utils/alerts";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/utils/currency";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { parseMoneyInput } from "@/src/money";
import { collapseLedgerRows, describeSourceNavigation, formatEditedStamp, type DisplayLedgerRow, type LedgerRow } from "@/src/utils/ledgerDisplay";
import { GlowPressable } from "@/src/components/GlowPressable";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";

type CashEntry = LedgerRow;

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function CashBookScreen() {
  const theme = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [entries, setEntries] = useState<CashEntry[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // inline form state
  const [editId, setEditId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayStr());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  // Cash In "Type": general manual entry vs investor capital deposit (partnership mode).
  const [partnerMode, setPartnerMode] = useState(false);
  const [inKind, setInKind] = useState<"general" | "capital">("general");
  const [investors, setInvestors] = useState<{ id: string; name: string }[] | null>(null);
  const [investorId, setInvestorId] = useState<string | null>(null);
  const [loadingInvestors, setLoadingInvestors] = useState(false);

  const [openingCash, setOpeningCash] = useState(0);
  const [openingVisible, setOpeningVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, settings, opening, config] = await Promise.all([api.listCashEntries(), api.getSettings(), api.getV2OpeningBalances(), api.getV2BookConfig().catch(() => null)]);
      setEntries(list);
      setOpeningCash(Number(opening?.cash || 0));
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
      setPartnerMode(config?.style === "retail_partnership");
      setInvestors(null); // refetched on demand so new investors show up
      loadedVersion.current = getDataVersion();
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  const loadedVersion = React.useRef<number>(-1);
  useFocusEffect(useCallback(() => {
    if (loadedVersion.current === getDataVersion()) return;
    const task = InteractionManager.runAfterInteractions(() => { load(); });
    return () => task.cancel();
  }, [load]));

  // Collapse reverse+repost bookkeeping noise into what the user actually did.
  // The books keep every journal; the screen shows one row per live entry.
  const collapsed = useMemo(() => collapseLedgerRows(entries), [entries]);
  const totals = useMemo(() => {
    const { ins, outs } = collapsed.totals;
    // The Opening Cash tile mirrors the opening-balance journal net, so the
    // header adds it once — internal adjustment pairs no longer inflate In/Out.
    const net = openingCash + ins - outs;
    return { ins, outs, net, opening: openingCash };
  }, [collapsed, openingCash]);

  const resetForm = () => {
    setEditId(null); setDirection("in"); setAmount(""); setDate(todayStr()); setNotes(""); setFormOpen(false);
    setInKind("general"); setInvestorId(null);
  };

  const selectCapitalKind = async () => {
    setInKind("capital");
    if (investors === null && !loadingInvestors) {
      setLoadingInvestors(true);
      try { setInvestors((await api.listInvestors()).map((x: any) => ({ id: x.id, name: x.name }))); }
      catch { setInvestors([]); }
      finally { setLoadingInvestors(false); }
    }
  };

  const openAdd = () => { resetForm(); setFormOpen(true); };
  const openEdit = (e: DisplayLedgerRow) => {
    if (e.editable === false || e.origin === "v2") {
      // Opening-balance rows edit right here via the Opening Cash tile.
      if (String(e.sourceType || "").startsWith("opening_balance")) {
        setOpeningVisible(true);
        return;
      }
      if (e.sourceType === "capital_injection" && e.memberId) {
        router.push({ pathname: "/investor/[id]", params: { id: e.memberId } } as any);
        return;
      }
      // Everything else routes to the screen that owns the source document.
      const nav = describeSourceNavigation(e.sourceType, e.sourceId);
      if (nav) {
        Alert.alert(
          "Posted transaction",
          `This entry comes from a ${nav.label.toLowerCase()}. Open it to edit?`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open", onPress: () => router.push(nav.params ? ({ pathname: nav.pathname, params: nav.params } as any) : (nav.pathname as any)) },
          ]
        );
      } else {
        router.push('/daybook' as any);
      }
      return;
    }
    setEditId(e.id); setDirection(e.direction); setAmount(String(e.amount)); setDate(e.date); setNotes(e.notes || ""); setFormOpen(true);
  };

  const save = async () => {
    const amt = parseMoneyInput(amount);
    if (!amt || amt <= 0) { Alert.alert("Invalid", "Enter a valid amount greater than zero."); return; }
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { Alert.alert("Invalid", `Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setDate(dateIso); // reflect the canonical form in the field
    if (!editId && direction === "in" && inKind === "capital" && partnerMode && !investorId) {
      Alert.alert("Pick an investor", "Select which investor this capital deposit belongs to.");
      return;
    }
    setSaving(true);
    try {
      const payload = { amount: amt, direction, date: dateIso, notes: notes.trim() };
      if (editId) await api.updateCashEntry(editId, payload);
      else if (direction === "in" && inKind === "capital" && partnerMode && investorId) {
        // Investor capital goes through the SAME posting path as the investor
        // detail screen's Deposit Capital button (Dr Cash / Cr Member Capital,
        // memo "Capital deposit — <name>") — never a plain cash entry, so the
        // member's stake updates correctly.
        await api.depositInvestorCapital(investorId, payload);
      }
      else await api.createCashEntry(payload);
      resetForm();
      load();
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to save");
    } finally { setSaving(false); }
  };

  const remove = async (e: CashEntry) => {
    const ok = await requireAuth("Authenticate to delete this cash entry");
    if (!ok) return;
    confirmAction(
      "Delete entry?",
      "This cash movement will be removed.",
      async () => {
        try { await api.deleteCashEntry(e.id); load(); }
        catch (err: any) { Alert.alert("Error", err.message || "Failed"); }
      },
      "Delete"
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader 
        title="Cash Book" 
        subtitle={`Net ${fmt(totals.net, currSym)} • In ${fmt(totals.ins, currSym)} • Out ${fmt(totals.outs, currSym)}`}
        rightAction={
          <Pressable testID="btn-add-cash" onPress={openAdd} style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}>
            <Ionicons name="add" size={22} color="#fff" />
          </Pressable>
        }
      />

      {/* Opening Cash Card */}
      <View style={styles.openingCard}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
          <View style={styles.openingBadge}>
            <Ionicons name="wallet-outline" size={18} color={theme.color.brandPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.openingTitle}>Opening Cash Balance</Text>
            <Text style={styles.openingSub}>Initial cash on hand at start of period</Text>
          </View>
        </View>
        <Pressable onPress={() => setOpeningVisible(true)} style={styles.openingValBox}>
          <Text style={styles.openingValText}>{fmt(openingCash, currSym)}</Text>
          <Ionicons name="pencil" size={14} color={theme.color.brandPrimary} />
        </Pressable>
      </View>

      {formOpen && (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={styles.form}>
            <View style={styles.segRow}>
              <Pressable onPress={() => setDirection("in")} style={[styles.segBtn, direction === "in" && styles.segBtnInActive]}>
                <Ionicons name="arrow-down-circle-outline" size={16} color={direction === "in" ? "#fff" : theme.color.success} />
                <Text style={[styles.segText, direction === "in" && { color: "#fff" }]}>Cash In</Text>
              </Pressable>
              <Pressable onPress={() => { setDirection("out"); setInKind("general"); setInvestorId(null); }} style={[styles.segBtn, direction === "out" && styles.segBtnOutActive]}>
                <Ionicons name="arrow-up-circle-outline" size={16} color={direction === "out" ? "#fff" : theme.color.warning} />
                <Text style={[styles.segText, direction === "out" && { color: "#fff" }]}>Cash Out</Text>
              </Pressable>
            </View>
            {/* General cash posts to income/expense; investor capital posts to equity. */}
            {!editId && direction === "in" && partnerMode ? (
              <View style={{ gap: 6 }}>
                <View style={styles.chipRow}>
                  <Text style={styles.chipLabel}>Type</Text>
                  <Pressable testID="chip-cashin-general" onPress={() => { setInKind("general"); setInvestorId(null); }} style={[styles.chip, inKind === "general" && styles.chipOn]}>
                    <Text style={[styles.chipText, inKind === "general" && styles.chipTextOn]}>General</Text>
                  </Pressable>
                  <Pressable testID="chip-cashin-capital" onPress={selectCapitalKind} style={[styles.chip, inKind === "capital" && styles.chipOn]}>
                    <Text style={[styles.chipText, inKind === "capital" && styles.chipTextOn]}>Add Capital</Text>
                  </Pressable>
                </View>
                {inKind === "capital" ? (
                  loadingInvestors ? <ActivityIndicator size="small" color={theme.color.brandPrimary} />
                  : investors && investors.length ? (
                    <View style={styles.chipRow}>
                      {investors.map((inv) => (
                        <Pressable key={inv.id} testID={`chip-investor-${inv.id}`} onPress={() => setInvestorId(inv.id)} style={[styles.chip, investorId === inv.id && styles.chipOn]}>
                          <Text style={[styles.chipText, investorId === inv.id && styles.chipTextOn]}>{inv.name}</Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : <Text style={styles.chipHint}>No capital accounts yet — add one in Accounts first.</Text>
                ) : null}
              </View>
            ) : null}
            {inKind === "general" ? (
              <Text style={styles.accountingHint}>
                {direction === "in" ? "General Cash In is recorded as income and increases profit." : "General Cash Out is recorded as an expense and reduces profit."}
              </Text>
            ) : null}
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount" placeholderTextColor={theme.color.muted} style={styles.input} />
            <TextInput value={date} onChangeText={setDate} onBlur={() => { if (date.trim()) setDate(normalizeDateInput(date)); }} autoCapitalize="none" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
            <TextInput value={notes} onChangeText={setNotes} placeholder="Notes (e.g. counter sale, petty cash)" placeholderTextColor={theme.color.muted} style={styles.input} />
            <View style={styles.formBtns}>
              <Pressable onPress={resetForm} style={[styles.formBtn, styles.cancelBtn]}><Text style={styles.cancelText}>Cancel</Text></Pressable>
              <Pressable onPress={save} disabled={saving} style={[styles.formBtn, styles.saveBtn]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update" : "Add"}</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
      <OpeningBalancesModal visible={openingVisible} mode="cash" onClose={() => setOpeningVisible(false)} onSuccess={() => { setOpeningVisible(false); setLoading(true); load(); }} />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={collapsed.rows}
          keyExtractor={(i, index) => `${i.id}:${index}`}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="cash-outline" size={40} color={theme.color.muted} />}
              title="No manual cash entries yet"
              hint="Opening cash is active. Tap + to record cash in or out."
            />
          }
          renderItem={({ item }) => (
            <GlowPressable onPress={() => openEdit(item)} onLongPress={item.editable === false ? undefined : () => remove(item)} haptic topHighlight={false} restingBorderColor={theme.color.border} style={styles.card}>
              <View style={[styles.dirBadge, { backgroundColor: item.direction === "in" ? theme.color.success : theme.color.warning }]}>
                <Ionicons name={item.direction === "in" ? "arrow-down" : "arrow-up"} size={16} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{shortDate(item.date)}</Text>
                {item.notes ? <Text style={styles.cardSub}>{item.notes}</Text> : null}
                {item.edited ? <Text style={styles.editedTag}>edited{item.editedAt ? ` ${formatEditedStamp(item.editedAt)}` : ""}</Text> : null}
                {item.adjustmentCount ? <Text style={styles.adjustmentHint}>includes {item.adjustmentCount} adjustment{item.adjustmentCount === 1 ? "" : "s"}</Text> : null}
              </View>
              <Text style={[styles.amount, { color: item.direction === "in" ? theme.color.success : theme.color.warning }]}>
                {item.direction === "in" ? "+" : "−"} {fmt(item.amount, currSym)}
              </Text>
            </GlowPressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: theme.spacing.lg },
  addBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center", marginTop: theme.spacing.md },
  openingCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: theme.spacing.lg, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm, padding: theme.spacing.md, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border },
  openingBadge: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.color.brandPrimary + "18", justifyContent: "center", alignItems: "center" },
  openingTitle: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
  openingSub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  openingValBox: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border },
  openingValText: { fontSize: 14, fontWeight: "700", color: theme.color.brandPrimary },
  openingInput: { width: 90, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13, color: theme.color.onSurface },
  openingDateInput: { width: 112, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: 12, color: theme.color.onSurface },
  openingSaveBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center" },
  form: { marginHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md, padding: theme.spacing.lg, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, gap: 8 },
  segRow: { flexDirection: "row", gap: 8 },
  segBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border },
  segBtnInActive: { backgroundColor: theme.color.success, borderColor: theme.color.success },
  segBtnOutActive: { backgroundColor: theme.color.warning, borderColor: theme.color.warning },
  segText: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  chipRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  chipLabel: { fontSize: 12, fontWeight: "600", color: theme.color.muted, marginRight: 2 },
  chip: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
  chipOn: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  chipText: { fontSize: 12, fontWeight: "600", color: theme.color.onSurface },
  chipTextOn: { color: "#fff" },
  chipHint: { fontSize: 12, color: theme.color.muted },
  accountingHint: { fontSize: 12, color: theme.color.muted, lineHeight: 17 },
  input: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  formBtns: { flexDirection: "row", gap: 8, marginTop: 4 },
  formBtn: { flex: 1, paddingVertical: 12, borderRadius: theme.radius.md, alignItems: "center" },
  cancelBtn: { backgroundColor: theme.color.surfaceTertiary },
  cancelText: { color: theme.color.onSurface, fontWeight: "600" },
  saveBtn: { backgroundColor: theme.color.brandPrimary },
  saveText: { color: "#fff", fontWeight: "700" },
  list: { paddingHorizontal: theme.spacing.lg, paddingBottom: 140, gap: theme.spacing.md },
  card: { flexDirection: "row", backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.color.border, alignItems: "center", gap: theme.spacing.md },
  dirBadge: { width: 32, height: 32, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  cardTitle: { fontSize: 15, fontWeight: "600", color: theme.color.onSurface },
  cardSub: { fontSize: 12, color: theme.color.muted, marginTop: 4 },
  editedTag: { fontSize: 11, color: theme.color.muted, marginTop: 3, fontStyle: "italic" },
  adjustmentHint: { fontSize: 10, color: theme.color.muted, marginTop: 2 },
  amount: { fontSize: 16, fontWeight: "700" },
}); }
