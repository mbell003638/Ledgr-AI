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

type CashEntry = { id: string; amount: number; direction: "in" | "out"; date: string; notes?: string };

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

  const load = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([api.listCashEntries(), api.getSettings()]);
      setEntries(list);
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totals = useMemo(() => {
    const ins = entries.filter((e) => e.direction === "in").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const outs = entries.filter((e) => e.direction === "out").reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return { ins, outs, net: ins - outs };
  }, [entries]);

  const resetForm = () => {
    setEditId(null); setDirection("in"); setAmount(""); setDate(todayStr()); setNotes(""); setFormOpen(false);
  };

  const openAdd = () => { resetForm(); setFormOpen(true); };
  const openEdit = (e: CashEntry) => {
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
    // Deleting a cash record is sensitive — gate behind device lock.
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
              title="No cash movements yet"
              hint="Tap + to record a manual cash in or cash out."
            />
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => openEdit(item)} onLongPress={() => remove(item)} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}>
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
            </Pressable>
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
