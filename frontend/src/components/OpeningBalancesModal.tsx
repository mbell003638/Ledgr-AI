import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Modal, Platform, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { isValidDateString, normalizeDateInput } from "@/src/utils/dateValidation";
import { GlowPressable } from "@/src/components/GlowPressable";

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  mode?: "all" | "investor";
}

export function OpeningBalancesModal({ visible, onClose, onSuccess, mode = "all" }: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [openingCash, setOpeningCash] = useState("");
  const [openingInventory, setOpeningInventory] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [isPartnerMode, setIsPartnerMode] = useState(false);
  const [members, setMembers] = useState<{ name: string; amount: string; profitSharePct: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const s: any = await api.getSettings().catch(() => ({}));
        setOpeningCash(s.openingCash ? String(s.openingCash) : "0");
        setOpeningInventory(s.openingInventory ? String(s.openingInventory) : "0");
        setPeriodStart(s.currentPeriodStart && s.currentPeriodStart !== "1970-01-01" ? s.currentPeriodStart : "");
        const partnerActive = s.accountingStyle === "retail_partnership";
        setIsPartnerMode(partnerActive);

        const inv = Array.isArray(s.investors) ? s.investors : [];
        if (inv.length) {
          setMembers(inv.map((m: any) => ({
            name: String(m?.name ?? ""),
            amount: m?.amount != null && m.amount !== 0 ? String(m.amount) : "",
            profitSharePct: m?.profitSharePct != null && m.profitSharePct !== 0 ? String(m.profitSharePct) : "",
          })));
        } else {
          const names = Array.isArray(s.partnerNames) ? s.partnerNames : [];
          setMembers(names.map((n: string) => ({ name: String(n), amount: "", profitSharePct: "" })));
        }
      } catch (e: any) {
        setError(e.message || "Failed to load opening balances");
      } finally {
        setLoading(false);
      }
    })();
  }, [visible]);

  const addMember = () => setMembers((prev) => [...prev, { name: "", amount: "", profitSharePct: "" }]);
  const removeMember = (index: number) => setMembers((prev) => prev.filter((_, i) => i !== index));
  const updateMember = (index: number, field: "name" | "amount" | "profitSharePct", val: string) => {
    setMembers((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: val } : m)));
  };

  const save = async () => {
    // Normalize the manually-typed period start (whitespace, exotic digits,
    // single-digit month/day, DD/MM/YYYY) before validating so a correct date
    // in a different shape is no longer wrongly rejected.
    let normalizedPeriodStart = "";
    if (mode === "all" && periodStart.trim()) {
      normalizedPeriodStart = normalizeDateInput(periodStart);
      if (!isValidDateString(normalizedPeriodStart)) {
        setError(`Couldn't read "${periodStart.trim()}" as a date. Please use YYYY-MM-DD (e.g. 2026-01-01).`);
        return;
      }
      if (normalizedPeriodStart !== periodStart) setPeriodStart(normalizedPeriodStart);
    }
    const cashVal = parseFloat(openingCash) || 0;
    const invVal = parseFloat(openingInventory) || 0;
    if (mode === "all" && (cashVal < 0 || invVal < 0)) {
      setError("Opening amounts cannot be negative.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const cleanedMembers = members
        .map((m) => ({
          name: m.name.trim(),
          amount: m.amount.trim() ? parseFloat(m.amount) : 0,
          profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0,
        }))
        .filter((m) => m.name);

      await api.updateSettings({
        openingCash: cashVal,
        openingInventory: invVal,
        currentPeriodStart: normalizedPeriodStart || "",
        investors: cleanedMembers,
        partnerNames: cleanedMembers.map((m) => m.name),
      });
      // V2 accounting keeps opening balances in the dated double-entry ledger.
      try {
        await api.postV2OpeningBalances({ date: normalizedPeriodStart || undefined, cash: cashVal, inventory: invVal, memo: "Opening balances" });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      if (isPartnerMode) {
        try {
          const config = await api.getV2BookConfig();
          if (!config) throw new Error('No active versioned V2 book');
          await api.updateV2BookConfig({
            style: 'retail_partnership', basis: config.basis, selectedPersonas: config.selectedPersonas, activePersona: config.activePersona,
            retailPartnership: {
              ...config.retailPartnership,
              enabled: true,
              members: cleanedMembers.map((member) => ({ name: member.name, openingContribution: member.amount, profitSharePct: member.profitSharePct })),
            },
          });
        } catch { /* legacy storage remains authoritative when V2 is unavailable */ }
      }

      onClose();
      if (onSuccess) onSuccess();
    } catch (e: any) {
      setError(e.message || "Failed to save balances.");
    } finally {
      setSaving(false);
    }
  };

  const isInvestorOnly = mode === "investor";

  return (
    <Modal visible={visible} transparent animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modalBox}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{isInvestorOnly ? "Investor Capital & Equity Setup" : "Opening Balances Setup"}</Text>
              <Text style={styles.subtitle}>
                {isInvestorOnly ? "Add or edit investor names, capital contributions & profit share" : "Set your starting cash, stock & equity directly"}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={theme.color.onSurface} />
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginVertical: 30 }} color={theme.color.brandPrimary} />
          ) : (
            <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
              {!isInvestorOnly ? (
                <>
                  <Text style={styles.label}>Opening Cash Balance ($)</Text>
                  <TextInput
                    value={openingCash}
                    onChangeText={setOpeningCash}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                  />

                  <Text style={[styles.label, { marginTop: 14 }]}>Opening Stock Value ($)</Text>
                  <TextInput
                    value={openingInventory}
                    onChangeText={setOpeningInventory}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                  />

                  <Text style={[styles.label, { marginTop: 14 }]}>Period Start Date (YYYY-MM-DD)</Text>
                  <TextInput
                    value={periodStart}
                    onChangeText={setPeriodStart}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                    placeholder="e.g. 2026-01-01 (Blank = All history)"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                  />
                  <Text style={styles.helper}>Format: YYYY-MM-DD. 01/06/2026 and 2026-6-1 are also accepted.</Text>
                </>
              ) : null}

              {isPartnerMode ? <View style={!isInvestorOnly ? { marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.color.border } : { marginTop: 4 }}>
                {!isInvestorOnly ? <Text style={styles.sectionHeader}>Investor Capital & Equity Setup</Text> : null}
                {members.length === 0 ? (
                  <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 12 }}>No investors added yet. Tap &quot;+ Add Investor&quot; below.</Text>
                ) : null}
                {members.map((m, i) => (
                  <View key={i} style={styles.memberCard}>
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                      <TextInput
                        value={m.name}
                        onChangeText={(v) => updateMember(i, "name", v)}
                        placeholder="Investor Name"
                        placeholderTextColor={theme.color.muted}
                        style={[styles.input, { flex: 1, marginTop: 0 }]}
                      />
                      <Pressable onPress={() => removeMember(i)} style={styles.removeBtn}>
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                      </Pressable>
                    </View>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>Capital ($)</Text>
                        <TextInput
                          value={m.amount}
                          onChangeText={(v) => updateMember(i, "amount", v)}
                          keyboardType="decimal-pad"
                          placeholder="0.00"
                          placeholderTextColor={theme.color.muted}
                          style={[styles.input, { marginTop: 4 }]}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>Profit Share %</Text>
                        <TextInput
                          value={m.profitSharePct}
                          onChangeText={(v) => updateMember(i, "profitSharePct", v)}
                          keyboardType="decimal-pad"
                          placeholder="50"
                          placeholderTextColor={theme.color.muted}
                          style={[styles.input, { marginTop: 4 }]}
                        />
                      </View>
                    </View>
                  </View>
                ))}
                <GlowPressable topHighlight={false} haptic hoverLift={0} hoverScale={1} onPress={addMember} style={styles.addMemberBtn}>
                  <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                  <Text style={styles.addMemberText}>Add Investor</Text>
                </GlowPressable>
              </View> : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}
            </ScrollView>
          )}

          <View style={styles.footer}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={save} disabled={saving} style={styles.saveBtn}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save Balances</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 16 },
    modalBox: { width: "100%", maxWidth: 440, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, padding: 20, borderWidth: 1, borderColor: theme.color.border },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
    title: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface },
    subtitle: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    closeBtn: { padding: 4 },
    label: { fontSize: 12, fontWeight: "700", color: theme.color.onSurface },
    subLabel: { fontSize: 11, fontWeight: "600", color: theme.color.muted },
    helper: { fontSize: 11, color: theme.color.muted, marginTop: 4 },
    sectionHeader: { fontSize: 14, fontWeight: "700", color: theme.color.brandPrimary, marginBottom: 10 },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, color: theme.color.onSurface },
    memberCard: { backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: 10, borderWidth: 1, borderColor: theme.color.border, marginBottom: 8 },
    removeBtn: { padding: 6 },
    addMemberBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brandPrimary + "40", backgroundColor: theme.color.brandPrimary + "10", marginTop: 4 },
    addMemberText: { fontSize: 13, fontWeight: "700", color: theme.color.brandPrimary },
    error: { color: theme.color.error, textAlign: "center", marginTop: 10, fontSize: 12 },
    footer: { flexDirection: "row", gap: 10, marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.color.border },
    cancelBtn: { flex: 1, paddingVertical: 10, borderRadius: theme.radius.md, backgroundColor: theme.color.surfaceTertiary, alignItems: "center" },
    cancelText: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    saveBtn: { flex: 1.2, paddingVertical: 10, borderRadius: theme.radius.md, backgroundColor: theme.color.brandPrimary, alignItems: "center" },
    saveText: { fontSize: 13, fontWeight: "700", color: "#fff" },
  });
}
