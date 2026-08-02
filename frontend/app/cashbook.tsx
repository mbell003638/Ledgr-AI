import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, TextInput, Alert, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { confirmAction } from "@/src/utils/alerts";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { requireAuth } from "@/src/utils/lock";

type CashEntry = { id: string; amount: number; direction: "in" | "out"; date: string; notes?: string; origin?: "manual" | "v2"; editable?: boolean };
import { GlowPressable } from "@/src/components/GlowPressable";

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function CashBookScreen() {
  const theme = useTheme();
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

  const [openingCash, setOpeningCash] = useState(0);
  const [openingDate, setOpeningDate] = useState("");
  const [editingOpening, setEditingOpening] = useState(false);
  const [openingInput, setOpeningInput] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([api.listCashEntries(), api.getSettings()]);
      setEntries(list);
      const op = Number(settings.openingCash || 0);
      setOpeningCash(op);
      setOpeningInput(String(op));
      setOpeningDate(settings.currentPeriodStart && settings.currentPeriodStart !== "1970-01-01" ? String(settings.currentPeriodStart) : todayStr());
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totals = useMemo(() => {
    const ins = entries.filter((e) => e.direction === "in").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const outs = entries.filter((e) => e.direction === "out").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const net = openingCash + ins - outs;
    return { ins, outs, net, opening: openingCash };
  }, [entries, openingCash]);

  const saveOpeningCash = async () => {
    const val = parseFloat(openingInput);
    if (isNaN(val) || val < 0) { Alert.alert("Invalid", "Enter a valid opening cash balance."); return; }
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(openingDate.trim())) { Alert.alert("Invalid", "Use an opening date in YYYY-MM-DD format."); return; }
    try {
      // Post to the authoritative V2 journal before mirroring the value into legacy settings.
      // This prevents the display setting from changing if the accounting period is locked.
      const settings = await api.getSettings();
      try {
        await api.updateV2OpeningBalances({ date: openingDate.trim(), cash: val, inventory: Number(settings.openingInventory || 0), memo: "Opening balances" });
      } catch (e: any) {
        if (!/requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({ openingCash: val, currentPeriodStart: openingDate.trim() });
      setOpeningCash(val);
      setEditingOpening(false);
      load();
    } catch (e: any) { Alert.alert("Error", e.message || "Failed to save"); }
  };

  const resetForm = () => {
    setEditId(null); setDirection("in"); setAmount(""); setDate(todayStr()); setNotes(""); setFormOpen(false);
  };

  const openAdd = () => { resetForm(); setFormOpen(true); };
  const openEdit = (e: CashEntry) => {
    if (e.editable === false || e.origin === "v2") {
      Alert.alert("Posted transaction", "This cash movement comes from another accounting transaction. Edit it from its original screen.");
      return;
    }
    setEditId(e.id); setDirection(e.direction); setAmount(String(e.amount)); setDate(e.date); setNotes(e.notes || ""); setFormOpen(true);
  };

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { Alert.alert("Invalid", "Enter a valid amount greater than zero."); return; }
    if (!date.trim()) { Alert.alert("Invalid", "Enter a date (YYYY-MM-DD)."); return; }
    setSaving(true);
    try {
      const payload = { amount: amt, direction, date: date.trim(), notes: notes.trim() };
      if (editId) await api.updateCashEntry(editId, payload);
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
        {!editingOpening ? (
          <Pressable onPress={() => setEditingOpening(true)} style={styles.openingValBox}>
            <Text style={styles.openingValText}>{fmt(openingCash, currSym)}</Text>
            <Ionicons name="pencil" size={14} color={theme.color.brandPrimary} />
          </Pressable>
        ) : (
          <View style={{ gap: 6, alignItems: "flex-end" }}>
            <TextInput value={openingInput} onChangeText={setOpeningInput} keyboardType="decimal-pad" style={styles.openingInput} autoFocus />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <TextInput value={openingDate} onChangeText={setOpeningDate} autoCapitalize="none" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.openingDateInput} />
              <Pressable onPress={saveOpeningCash} style={styles.openingSaveBtn}><Ionicons name="checkmark" size={16} color="#fff" /></Pressable>
            </View>
          </View>
        )}
      </View>

      {formOpen && (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.form}>
            <View style={styles.segRow}>
              <Pressable onPress={() => setDirection("in")} style={[styles.segBtn, direction === "in" && styles.segBtnInActive]}>
                <Ionicons name="arrow-down-circle-outline" size={16} color={direction === "in" ? "#fff" : theme.color.success} />
                <Text style={[styles.segText, direction === "in" && { color: "#fff" }]}>Cash In</Text>
              </Pressable>
              <Pressable onPress={() => setDirection("out")} style={[styles.segBtn, direction === "out" && styles.segBtnOutActive]}>
                <Ionicons name="arrow-up-circle-outline" size={16} color={direction === "out" ? "#fff" : theme.color.warning} />
                <Text style={[styles.segText, direction === "out" && { color: "#fff" }]}>Cash Out</Text>
              </Pressable>
            </View>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount" placeholderTextColor={theme.color.muted} style={styles.input} />
            <TextInput value={date} onChangeText={setDate} autoCapitalize="none" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.input} />
            <TextInput value={notes} onChangeText={setNotes} placeholder="Notes (e.g. Owner deposit, petty cash)" placeholderTextColor={theme.color.muted} style={styles.input} />
            <View style={styles.formBtns}>
              <Pressable onPress={resetForm} style={[styles.formBtn, styles.cancelBtn]}><Text style={styles.cancelText}>Cancel</Text></Pressable>
              <Pressable onPress={save} disabled={saving} style={[styles.formBtn, styles.saveBtn]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update" : "Add"}</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(i) => i.id}
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
  amount: { fontSize: 16, fontWeight: "700" },
}); }
