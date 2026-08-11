import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { FormCard, FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";

export default function InventoryForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [expected, setExpected] = useState(0);
  const [actual, setActual] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<any>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [history, setHistory] = useState<any[]>([]);
  const [usingV2, setUsingV2] = useState(false);
  const [periodPolicy, setPeriodPolicy] = useState<{ mode: "flexible" | "fixed"; startDate?: string; endDate?: string }>({ mode: "flexible" });

  const [openingStock, setOpeningStock] = useState(0);
  const [openingEffectiveDate, setOpeningEffectiveDate] = useState("");
  const [openingDateInput, setOpeningDateInput] = useState("");
  const [editingOpening, setEditingOpening] = useState(false);
  const [openingInput, setOpeningInput] = useState("");
  const [hasV2Opening, setHasV2Opening] = useState(false);
  const [openingVisible, setOpeningVisible] = useState(false);

  const loadData = async () => {
    try {
      const [v2, settings, config, opening] = await Promise.all([api.v2InventoryOverview(), api.getSettings(), api.getV2BookConfig().catch(() => null), api.getV2OpeningBalances()]);
      if (v2) {
        setUsingV2(true);
        setExpected(Number(v2.expected || 0));
        setInfo(v2);
        setHistory(Array.isArray(v2.history) ? v2.history : []);
      } else {
        setUsingV2(false);
        const [legacyExpected, legacyHistory] = await Promise.all([api.expectedInventory(), api.listInventory()]);
        setExpected(legacyExpected.expected);
        setInfo(legacyExpected);
        setHistory(Array.isArray(legacyHistory) ? legacyHistory : []);
      }
      const op = Number(opening?.inventory ?? settings.openingInventory ?? 0);
      setHasV2Opening(Boolean(opening));
      setPeriodPolicy(config?.periodPolicy || { mode: "flexible" });
      setOpeningEffectiveDate(String(opening?.date || settings.currentPeriodStart || ""));
      setOpeningDateInput(opening?.date || (settings.currentPeriodStart && settings.currentPeriodStart !== "1970-01-01" ? String(settings.currentPeriodStart) : new Date().toISOString().slice(0, 10)));
      setOpeningStock(op);
      setOpeningInput(String(op));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    loadData();
  }, []);

  const saveOpeningStock = async () => {
    const val = parseFloat(openingInput);
    if (isNaN(val) || val < 0) { setError("Enter a valid opening stock value"); return; }
    const openingIso = normalizeDateInput(openingDateInput);
    if (!isValidDateString(openingIso)) { setError(`Couldn't read "${openingDateInput.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setOpeningDateInput(openingIso); // reflect the canonical form in the field
    try {
      // Journal first; settings remain a legacy compatibility mirror for the V2 opening source.
      const settings = await api.getSettings();
      try {
        await api.updateV2OpeningBalances({ date: openingIso, cash: Number(settings.openingCash || 0), inventory: val, memo: "Opening balances" });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({ openingInventory: val, currentPeriodStart: openingIso });
      setOpeningStock(val);
      setEditingOpening(false);
      loadData();
    } catch (e: any) { setError(e.message); }
  };

  const save = async () => {
    const act = parseFloat(actual);
    if (isNaN(act) || act < 0) { setError("Enter a valid stock value"); return; }
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setDate(dateIso); // reflect the canonical form in the field
    setSaving(true); setError("");
    try {
      let savedV2 = false;
      try {
        await api.recordV2InventoryCount({ date: dateIso, value: act, notes });
        savedV2 = true;
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      if (!savedV2) await api.createInventory({ date: dateIso, expectedStock: expected, actualStock: act, notes });
      setActual("");
      setNotes("");
      loadData();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const deleteAudit = async (id: string) => {
    try {
      if (usingV2) await api.deleteV2InventoryCount(id);
      else await api.deleteInventory(id);
      loadData();
    } catch (e: any) { setError(e.message); }
  };

  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [commissionPct, setCommissionPct] = useState("");
  const [closeDate, setCloseDate] = useState(new Date().toISOString().slice(0, 10));

  const beginClose = () => {
    setCloseDate(periodPolicy.mode === "fixed" && periodPolicy.endDate ? periodPolicy.endDate : (date || new Date().toISOString().slice(0, 10)));
    setConfirmClose(true);
    setError("");
  };

  const closePeriod = async () => {
    const act = parseFloat(actual);
    if (isNaN(act) || act < 0) { setError("Enter actual stock first"); return; }
    const pct = commissionPct.trim() === "" ? 0 : parseFloat(commissionPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setError("Enter a manager commission percentage from 0 to 100"); return; }
    const closingIso = normalizeDateInput(closeDate);
    if (!isValidDateString(closingIso)) { setError(`Couldn't read "${closeDate.trim()}" as a closing date. Please use YYYY-MM-DD.`); return; }
    if (periodPolicy.mode === "fixed" && periodPolicy.endDate && closingIso !== periodPolicy.endDate) {
      setError(`This fixed period must close on ${periodPolicy.endDate}.`);
      return;
    }
    setCloseDate(closingIso);
    setClosing(true); setError("");
    try {
      await api.closePeriod(act, notes, pct, closingIso);
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setClosing(false); setConfirmClose(false); }
  };

  const variance = actual ? parseFloat(actual) - expected : 0;
  const varColor = variance === 0 ? theme.color.muted : variance > 0 ? theme.color.success : theme.color.error;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-inv" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Stock & Physical Count</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          {loading ? <ActivityIndicator color={theme.color.brandPrimary} /> : (
            <>
              {/* Opening Stock Card */}
              <Card style={{ marginBottom: theme.spacing.md }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                    <View style={styles.openingBadge}>
                      <Ionicons name="cube-outline" size={18} color={theme.color.brandPrimary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>Opening Stock Balance</Text>
                      <Text style={styles.hint}>Initial inventory value at start of period{openingEffectiveDate ? ` · Effective ${openingEffectiveDate}` : ""}</Text>
                    </View>
                  </View>
                  {!editingOpening ? (
                    <Pressable onPress={() => hasV2Opening ? setOpeningVisible(true) : setEditingOpening(true)} style={styles.openingValBox}>
                      <Text style={styles.openingValText}>{fmt(openingStock)}</Text>
                      <Ionicons name="pencil" size={14} color={theme.color.brandPrimary} />
                    </Pressable>
                  ) : (
                    <View style={{ gap: 6, alignItems: "flex-end" }}>
                      <TextInput value={openingInput} onChangeText={setOpeningInput} keyboardType="decimal-pad" style={styles.openingInput} autoFocus />
                      <View style={{ flexDirection: "row", gap: 6 }}>
                        <TextInput value={openingDateInput} onChangeText={setOpeningDateInput} onBlur={() => { if (openingDateInput.trim()) setOpeningDateInput(normalizeDateInput(openingDateInput)); }} autoCapitalize="none" placeholder="YYYY-MM-DD" placeholderTextColor={theme.color.muted} style={styles.openingDateInput} />
                        <Pressable onPress={saveOpeningStock} style={styles.openingSaveBtn}><Ionicons name="checkmark" size={16} color="#fff" /></Pressable>
                      </View>
                    </View>
                  )}
                </View>
              </Card>

              <FormCard>
                <Text style={styles.label}>Live System Stock (USD value)</Text>
                <Text style={styles.expected} testID="inv-expected">{fmt(expected)}</Text>
                {info?.lastAudit ? (
                  <Text style={styles.hint}>Last audit: {info.lastAudit.date} at {fmt(info.lastAudit.actualStock)}. Purchases since: {fmt(info.purchasesSince)}. Sales since: {fmt(info.salesSince)}.</Text>
                ) : (
                  <Text style={styles.hint}>Opening Stock: {fmt(info?.openingInventory)} • Purchases: +{fmt(info?.purchasesSince)} • Sales COGS: -{fmt(info?.salesSince)}</Text>
                )}
                <FormField
                  label="Audit Date (YYYY-MM-DD)"
                  labelStyle={{ marginTop: 16 }}
                  testID="input-inv-date"
                  value={date}
                  onChangeText={setDate}
                  onBlur={() => { if (date.trim()) setDate(normalizeDateInput(date)); }}
                  placeholder="YYYY-MM-DD"
                />
                <FormField
                  label="Physical Stock Count (Shelf Count, USD)"
                  labelStyle={{ marginTop: 14 }}
                  testID="input-actual-stock"
                  value={actual}
                  onChangeText={setActual}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                />

                {actual !== "" && (
                  <View style={[styles.varBox, { backgroundColor: variance === 0 ? theme.color.surfaceTertiary : variance > 0 ? "#E7F1EA" : "#FBE8E5" }]}>
                    <Text style={styles.varLabel}>Variance</Text>
                    <Text style={[styles.varValue, { color: varColor }]} testID="inv-variance">
                      {variance > 0 ? "+" : ""}{fmt(variance)}
                    </Text>
                    <Text style={styles.varHint}>
                      {variance === 0 ? "Perfectly matched" : variance > 0 ? "Overage / gain" : "Shortage detected"}
                    </Text>
                  </View>
                )}

                <FormField
                  label="Notes"
                  multiline
                  testID="input-inv-notes"
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Optional"
                />
              </FormCard>
              <FormActions
                primaryLabel="Save Audit"
                primaryTestID="btn-save-inv"
                onPrimary={save}
                primaryBusy={saving}
                error={error}
              />

              {history.length > 0 && (
                <Card style={{ marginTop: theme.spacing.lg }}>
                  <Text style={[styles.label, { marginBottom: theme.spacing.md }]}>Audit History Logs</Text>
                  {history.map((item) => {
                    const varVal = Number(item.variance || 0);
                    return (
                      <View key={item.id} style={styles.historyRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.historyTitle}>{item.date} · Counted: {fmt(item.actualStock)}</Text>
                          <Text style={styles.historySub}>Expected: {fmt(item.expectedStock)}{item.notes ? ` · ${item.notes}` : ''}</Text>
                        </View>
                        <View style={{ alignItems: "flex-end", gap: 4 }}>
                          <Text style={[styles.historyVariance, { color: varVal === 0 ? theme.color.muted : varVal > 0 ? theme.color.success : theme.color.error }]}>
                            {varVal > 0 ? "+" : ""}{fmt(varVal)}
                          </Text>
                          <Pressable onPress={() => deleteAudit(item.id)}>
                            <Ionicons name="trash-outline" size={16} color={theme.color.muted} />
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </Card>
              )}

              <Card style={{ marginTop: theme.spacing.lg, borderColor: theme.color.brandPrimary, borderWidth: 2 }}>
                <Text style={[styles.label, { color: theme.color.brandPrimary }]}>Close Period</Text>
                <Text style={styles.hint}>
                  Close the current inventory period, calculate COGS and gross profit, then carry the closing inventory into the next period.
                </Text>
                <View style={styles.policyBox} testID="active-period-policy">
                  <Text style={styles.policyTitle}>{periodPolicy.mode === "fixed" ? "Fixed accounting period" : "Flexible accounting period"}</Text>
                  <Text style={styles.hint}>
                    {periodPolicy.mode === "fixed"
                      ? `Configured range: ${periodPolicy.startDate || info?.periodStart || "book start"} to ${periodPolicy.endDate || info?.periodEnd || "configured end"}. This period closes on its end date.`
                      : `Active range: ${info?.periodStart || openingEffectiveDate || "book start"} onward. Close whenever you are ready; the reviewed close date becomes the permanent period end.`}
                  </Text>
                </View>
                {!confirmClose ? (
                  <Pressable
                    testID="btn-close-init"
                    onPress={beginClose}
                    style={[styles.closeInitBtn, { marginTop: theme.spacing.md }]}
                  >
                    <Ionicons name="checkmark-done-outline" size={18} color={theme.color.brandPrimary} />
                    <Text style={styles.closeInitText}>Close & Carry Forward…</Text>
                  </Pressable>
                ) : (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.hint, { color: theme.color.error, fontWeight: "700" }]}>
                      Permanent action: entries through the closing date will be locked and this period cannot be reopened or undone. The next active period begins immediately after this close.
                    </Text>
                    <FormField
                      label={periodPolicy.mode === "fixed" ? "Fixed closing date" : "Close period through (YYYY-MM-DD)"}
                      testID="input-close-date"
                      value={closeDate}
                      onChangeText={setCloseDate}
                      onBlur={() => { if (closeDate.trim()) setCloseDate(normalizeDateInput(closeDate)); }}
                      editable={periodPolicy.mode !== "fixed"}
                      placeholder="YYYY-MM-DD"
                    />
                    <FormField
                      label="Manager Commission % for this period"
                      testID="input-close-commission-pct"
                      value={commissionPct}
                      onChangeText={setCommissionPct}
                      keyboardType="decimal-pad"
                      placeholder="0"
                    />
                    <Text style={styles.hint}>Enter the approved percentage for this period. It is applied only to positive gross profit when the period closes.</Text>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                      <Pressable testID="btn-close-cancel" onPress={() => setConfirmClose(false)} style={styles.closeCancelBtn}>
                        <Text style={styles.closeCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable testID="btn-close-confirm" onPress={closePeriod} disabled={closing} style={styles.closeConfirmBtn}>
                        {closing ? <ActivityIndicator color="#fff" /> : <Text style={styles.closeConfirmText}>Permanently close period</Text>}
                      </Pressable>
                    </View>
                  </View>
                )}
              </Card>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <OpeningBalancesModal visible={openingVisible} mode="all" onClose={() => setOpeningVisible(false)} onSuccess={() => { setOpeningVisible(false); setLoading(true); loadData(); }} />
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
  expected: { fontSize: 28, fontWeight: "700", color: theme.color.brandPrimary, marginTop: 4 },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  varBox: { marginTop: 16, padding: theme.spacing.md, borderRadius: theme.radius.md },
  varLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  varValue: { fontSize: 22, fontWeight: "700", marginTop: 4 },
  varHint: { fontSize: 12, color: theme.color.muted, marginTop: 4 },
  policyBox: { marginTop: 12, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border },
  policyTitle: { fontSize: 13, fontWeight: "700", color: theme.color.onSurface },
  closeInitBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brandPrimary },
  closeInitText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 14 },
  closeCancelBtn: { flex: 1, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  closeCancelText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 13 },
  closeConfirmBtn: { flex: 1.4, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", backgroundColor: theme.color.error },
  closeConfirmText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  openingBadge: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  openingValBox: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border },
  openingValText: { fontSize: 14, fontWeight: "700", color: theme.color.brandPrimary },
  openingInput: { width: 90, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13, color: theme.color.onSurface },
  openingDateInput: { width: 112, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 8, paddingVertical: 5, fontSize: 12, color: theme.color.onSurface },
  openingSaveBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center" },
  historyRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  historyTitle: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  historySub: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
  historyVariance: { fontSize: 13, fontWeight: "700" },
}); }
