import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { FormCard, FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";
import { LocationPicker } from "@/src/components/LocationPicker";
import { isCapabilityEnabled } from "@/src/utils/capabilities";

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
  const [date, setDate] = useState(() => localTodayIso());
  const [history, setHistory] = useState<any[]>([]);
  const [periodPolicy, setPeriodPolicy] = useState<{ mode: "flexible" | "fixed"; startDate?: string; endDate?: string }>({ mode: "flexible" });
  const [settings, setSettings] = useState<any>({});
  const [locationId, setLocationId] = useState("");
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);

  const [openingStock, setOpeningStock] = useState(0);
  const [openingEffectiveDate, setOpeningEffectiveDate] = useState("");
  const [openingVisible, setOpeningVisible] = useState(false);
  const [commissionPct, setCommissionPct] = useState("");
  const [bookCommissionPct, setBookCommissionPct] = useState(0);

  const loadData = async () => {
    try {
      const [v2, config, opening, nextSettings] = await Promise.all([api.v2InventoryOverview(), api.getV2BookConfig().catch(() => null), api.getV2OpeningBalances(), api.getSettings()]);
      setSettings(nextSettings || {});
      const locationEnabled = isCapabilityEnabled(nextSettings, "multi_location");
      const nextLocations = locationEnabled ? await api.listLocations().catch(() => []) : [];
      const normalizedLocations = (Array.isArray(nextLocations) ? nextLocations : []).map((row: any) => ({ id: String(row.id), name: String(row.name) })).filter((row) => row.id);
      setLocations(normalizedLocations);
      const activeLocation = String(nextSettings?.activeLocationId || (normalizedLocations.length === 1 ? normalizedLocations[0]?.id : "") || "");
      setLocationId(activeLocation);
      if (!v2) throw new Error('No active versioned V2 book');
      setExpected(Number(v2.expected || 0));
      setInfo(v2);
      setHistory(Array.isArray(v2.history) ? v2.history : []);
      setPeriodPolicy(config?.periodPolicy || { mode: "flexible" });
      const bookRate = Number(config?.retailPartnership?.commissionPct);
      setBookCommissionPct(Number.isFinite(bookRate) ? bookRate : 0);
      setCommissionPct(Number.isFinite(bookRate) && bookRate > 0 ? String(bookRate) : "");
      setOpeningEffectiveDate(String(opening?.date || v2?.periodStart || ""));
      setOpeningStock(Number(opening?.inventory ?? v2?.openingInventory ?? 0));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    loadData();
  }, []);

  const save = async () => {
    const act = parseFloat(actual);
    if (isNaN(act) || act < 0) { setError("Enter a valid stock value"); return; }
    const locationEnabled = isCapabilityEnabled(settings, "multi_location");
    if (locationEnabled && locations.length > 1 && !locationId) { setError("Choose the shop being counted before saving this audit."); return; }
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setDate(dateIso); // reflect the canonical form in the field
    setSaving(true); setError("");
    try {
      const selectedLocation = locations.find((location) => location.id === locationId);
      const auditNotes = selectedLocation ? `Shop ${selectedLocation.name} physical stock audit${notes.trim() ? ` — ${notes.trim()}` : ""}` : notes;
      await api.recordV2InventoryCount({ date: dateIso, value: act, notes: auditNotes });
      setActual("");
      setNotes("");
      loadData();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const deleteAudit = async (id: string) => {
    try {
      await api.deleteV2InventoryCount(id);
      loadData();
    } catch (e: any) { setError(e.message); }
  };

  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeDate, setCloseDate] = useState(() => localTodayIso());

  const beginClose = () => {
    setCloseDate(periodPolicy.mode === "fixed" && periodPolicy.endDate ? periodPolicy.endDate : (date || localTodayIso()));
    setConfirmClose(true);
    setError("");
  };

  const closePeriod = async () => {
    const act = parseFloat(actual);
    if (isNaN(act) || act < 0) { setError("Enter actual stock first"); return; }
    const pct = commissionPct.trim() === "" ? bookCommissionPct : parseFloat(commissionPct);
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
      await api.updateSettings({ managerCommissionPct: pct });
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
                  <Pressable onPress={() => setOpeningVisible(true)} style={styles.openingValBox}>
                    <Text style={styles.openingValText}>{fmt(openingStock)}</Text>
                    <Ionicons name="pencil" size={14} color={theme.color.brandPrimary} />
                  </Pressable>
                </View>
              </Card>

              {isCapabilityEnabled(settings, "multi_location") ? <Card style={{ marginBottom: theme.spacing.md, borderColor: theme.color.brandPrimary + "66" }}><Text style={styles.label}>Shop being counted</Text><Text style={styles.hint}>Choose the shop for this audit. This screen records the book-level stock value; use Shop close for product-by-product shop variance adjustments.</Text><LocationPicker label="Shop / location" value={locationId} onChange={async (id) => { setLocationId(id); const current = await api.getSettings(); await api.updateSettings({ ...current, activeLocationId: id }); }} />{locations.length > 1 && !locationId ? <Text style={styles.errorText}>Select a shop before saving this audit.</Text> : null}</Card> : null}
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
                  <View style={[styles.varBox, { backgroundColor: variance === 0 ? theme.color.surfaceTertiary : variance > 0 ? theme.color.successBg : theme.color.errorBg }]}>
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
      <OpeningBalancesModal visible={openingVisible} mode="inventory" onClose={() => setOpeningVisible(false)} onSuccess={() => { setOpeningVisible(false); setLoading(true); loadData(); }} />
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
  errorText: { fontSize: 12, color: theme.color.error, marginTop: 8 },
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
