import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, Modal, Platform, ScrollView, ActivityIndicator, KeyboardAvoidingView, type TextInputProps } from "react-native";
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

/**
 * Keep the focus indicator inside the input's own rounded border. Browsers draw
 * their default outline outside the element, where a modal or ScrollView can
 * clip the top/bottom and leave the "half glow" seen in the opening setup.
 */
function OpeningTextInput({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <TextInput
      {...props}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[
        style,
        {
          borderColor: focused ? theme.color.brandPrimary : theme.color.border,
          borderRadius: theme.radius.input,
        },
        Platform.OS === "web"
          ? ({
              outlineStyle: "none",
              outlineWidth: 0,
              outlineColor: "transparent",
              boxShadow: "none",
              boxSizing: "border-box",
            } as any)
          : null,
      ]}
    />
  );
}
export function OpeningBalancesModal({ visible, onClose, onSuccess, mode = "all" }: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [openingCash, setOpeningCash] = useState("");
  const [openingInventory, setOpeningInventory] = useState("");
  const [otherAssets, setOtherAssets] = useState<{ name: string; amount: string }[]>([]);
  const [openingLiabilities, setOpeningLiabilities] = useState<{ name: string; amount: string; type: "creditor" | "other" }[]>([]);
  const [retainedEarnings, setRetainedEarnings] = useState("");
  const [ownerCapital, setOwnerCapital] = useState("");
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
        const [s, opening]: [any, any] = await Promise.all([api.getSettings().catch(() => ({})), api.getV2OpeningBalances().catch(() => null)]);
        const openingData: any = opening || {};
        setOpeningCash(openingData.cash != null ? String(openingData.cash) : (s.openingCash ? String(s.openingCash) : "0"));
        setOpeningInventory(openingData.inventory != null ? String(openingData.inventory) : (s.openingInventory ? String(s.openingInventory) : "0"));
        const savedAssets = Array.isArray(openingData.assetBreakdown) ? openingData.assetBreakdown : [];
        setOtherAssets(savedAssets.length
          ? savedAssets.map((asset: any) => ({ name: String(asset?.name || ""), amount: String(asset?.amount || "") }))
          : (Number(openingData.otherAssets || 0) ? [{ name: "Other asset", amount: String(openingData.otherAssets) }] : []));
        const savedLiabilities = Array.isArray(openingData.liabilityBreakdown) ? openingData.liabilityBreakdown : [];
        setOpeningLiabilities(savedLiabilities.length
          ? savedLiabilities.map((liability: any) => ({
              name: String(liability?.name || ""),
              amount: String(liability?.amount || ""),
              type: liability?.type === "creditor" ? "creditor" : "other",
            }))
          : [
              ...(Number(openingData.accountsPayable || 0) ? [{ name: "Supplier payable", amount: String(openingData.accountsPayable), type: "creditor" as const }] : []),
              ...(Number(openingData.otherLiabilities || 0) ? [{ name: "Other liability", amount: String(openingData.otherLiabilities), type: "other" as const }] : []),
            ]);
        setRetainedEarnings(openingData.retainedEarnings != null ? String(openingData.retainedEarnings) : "0");
        setOwnerCapital(openingData.ownerCapital != null ? String(openingData.ownerCapital) : "0");

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
  const addOtherAsset = () => setOtherAssets((prev) => [...prev, { name: "", amount: "" }]);
  const removeOtherAsset = (index: number) => setOtherAssets((prev) => prev.filter((_, i) => i !== index));
  const updateOtherAsset = (index: number, field: "name" | "amount", value: string) => {
    setOtherAssets((prev) => prev.map((asset, i) => i === index ? { ...asset, [field]: value } : asset));
  };
  const addOpeningLiability = () => setOpeningLiabilities((prev) => [...prev, { name: "", amount: "", type: "creditor" }]);
  const removeOpeningLiability = (index: number) => setOpeningLiabilities((prev) => prev.filter((_, i) => i !== index));
  const updateOpeningLiability = (index: number, field: "name" | "amount" | "type", value: string) => {
    setOpeningLiabilities((prev) => prev.map((liability, i) => i === index ? { ...liability, [field]: value } as typeof liability : liability));
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
    const assetBreakdown = otherAssets
      .map((asset) => ({ name: asset.name.trim(), amount: parseFloat(asset.amount) || 0 }))
      .filter((asset) => asset.name || asset.amount);
    const otherAssetsVal = assetBreakdown.reduce((sum, asset) => sum + asset.amount, 0);
    const liabilityBreakdown = openingLiabilities
      .map((liability) => ({ name: liability.name.trim(), amount: parseFloat(liability.amount) || 0, type: liability.type }))
      .filter((liability) => liability.name || liability.amount);
    const accountsPayableVal = liabilityBreakdown.filter((liability) => liability.type === "creditor").reduce((sum, liability) => sum + liability.amount, 0);
    const otherLiabilitiesVal = liabilityBreakdown.filter((liability) => liability.type === "other").reduce((sum, liability) => sum + liability.amount, 0);
    const retainedEarningsVal = parseFloat(retainedEarnings) || 0;
    const cleanedPreviewMembers = members.map((m) => parseFloat(m.amount) || 0);
    const ownerCapitalVal = isPartnerMode ? cleanedPreviewMembers.reduce((sum, value) => sum + value, 0) : (parseFloat(ownerCapital) || 0);
    const openingAssets = cashVal + invVal + otherAssetsVal;
    const openingCredits = accountsPayableVal + otherLiabilitiesVal + ownerCapitalVal + retainedEarningsVal;
    if (mode === "all" && assetBreakdown.some((asset) => asset.amount > 0 && !asset.name)) {
      setError("Give each other opening asset a name.");
      return;
    }
    if (mode === "all" && liabilityBreakdown.some((liability) => liability.amount > 0 && !liability.name)) {
      setError("Give each opening liability a name.");
      return;
    }
    if (mode === "all" && [cashVal, invVal, ...assetBreakdown.map((asset) => asset.amount), ...liabilityBreakdown.map((liability) => liability.amount), retainedEarningsVal, ownerCapitalVal].some((value) => value < 0)) {
      setError("Opening amounts cannot be negative.");
      return;
    }

    if (mode === "all" && Math.abs(openingAssets - openingCredits) > 0.005) {
      setError(`Opening balances do not balance. Assets: $${openingAssets.toFixed(2)}; liabilities and equity: $${openingCredits.toFixed(2)}.`);
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
        await api.updateV2OpeningBalances({ date: normalizedPeriodStart || undefined, cash: cashVal, inventory: invVal, otherAssets: otherAssetsVal, assetBreakdown, accountsPayable: accountsPayableVal, otherLiabilities: otherLiabilitiesVal, liabilityBreakdown, ownerCapital: ownerCapitalVal, retainedEarnings: retainedEarningsVal, memo: "Opening balances" });
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
      setError(e.message || "Couldn't save opening balances. Check the amounts and period start date, then try again.");
    } finally {
      setSaving(false);
    }
  };

  const isInvestorOnly = mode === "investor";

  return (
    <Modal visible={visible} transparent animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
      <View style={styles.overlay}>
        <View style={styles.modalBox}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{isInvestorOnly ? "Investor Capital & Equity Setup" : "Opening Balances Setup"}</Text>
              <Text style={styles.subtitle}>
                {isInvestorOnly ? "Add or edit investor names, capital contributions & profit share" : "Enter only the balances your business already has"}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={theme.color.onSurface} />
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginVertical: 30 }} color={theme.color.brandPrimary} />
          ) : (
            <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
              {!isInvestorOnly ? (
                <>
                  <Text style={styles.label}>Opening Cash Balance (Optional) ($)</Text>
                  <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
                    value={openingCash}
                    onChangeText={setOpeningCash}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                  />

                  <Text style={[styles.label, { marginTop: 14 }]}>Opening Stock / Inventory (Optional) ($)</Text>
                  <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
                    value={openingInventory}
                    onChangeText={setOpeningInventory}
                    keyboardType="decimal-pad"
                    placeholder="0.00"
                    placeholderTextColor={theme.color.muted}
                    style={styles.input}
                  />
                  <Text style={styles.helper}>Leave stock at zero if your business does not hold inventory.</Text>

                  <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.color.border }}>
                    <Text style={styles.sectionHeader}>Other Opening Assets (Optional)</Text>
                    <Text style={styles.helper}>Add deposits, equipment, property or any other asset you already own. Leave empty if none.</Text>
                    {otherAssets.map((asset, index) => (
                      <View key={index} style={[styles.memberCard, { marginTop: 8 }]}>
                        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                          <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={asset.name} onChangeText={(value) => updateOtherAsset(index, "name", value)} placeholder="Asset name" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1, marginTop: 0 }]} />
                          <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={asset.amount} onChangeText={(value) => updateOtherAsset(index, "amount", value)} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input, { width: 110, marginTop: 0 }]} />
                          <Pressable onPress={() => removeOtherAsset(index)} style={styles.removeBtn}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                        </View>
                      </View>
                    ))}
                    <GlowPressable topHighlight={false} haptic hoverLift={0} hoverScale={1} onPress={addOtherAsset} style={styles.addMemberBtn}>
                      <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                      <Text style={styles.addMemberText}>Add Other Asset</Text>
                    </GlowPressable>
                  </View>

                  <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.color.border }}>
                    <Text style={styles.sectionHeader}>Opening Liabilities (Optional)</Text>
                    <Text style={styles.helper}>Add any amounts your business already owes. Choose Supplier/Creditor for trade payables.</Text>
                    {openingLiabilities.map((liability, index) => (
                      <View key={index} style={[styles.memberCard, { marginTop: 8 }]}>
                        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                          <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={liability.name} onChangeText={(value) => updateOpeningLiability(index, "name", value)} placeholder="Liability name" placeholderTextColor={theme.color.muted} style={[styles.input, { flex: 1, marginTop: 0 }]} />
                          <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={liability.amount} onChangeText={(value) => updateOpeningLiability(index, "amount", value)} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input, { width: 110, marginTop: 0 }]} />
                          <Pressable onPress={() => removeOpeningLiability(index)} style={styles.removeBtn}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                          <Pressable onPress={() => updateOpeningLiability(index, "type", "creditor")} style={[styles.typeBtn, liability.type === "creditor" && styles.typeBtnActive]}><Text style={[styles.typeBtnText, liability.type === "creditor" && styles.typeBtnTextActive]}>Supplier / Creditor</Text></Pressable>
                          <Pressable onPress={() => updateOpeningLiability(index, "type", "other")} style={[styles.typeBtn, liability.type === "other" && styles.typeBtnActive]}><Text style={[styles.typeBtnText, liability.type === "other" && styles.typeBtnTextActive]}>Other Liability</Text></Pressable>
                        </View>
                      </View>
                    ))}
                    <GlowPressable topHighlight={false} haptic hoverLift={0} hoverScale={1} onPress={addOpeningLiability} style={styles.addMemberBtn}>
                      <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                      <Text style={styles.addMemberText}>Add Liability</Text>
                    </GlowPressable>
                  </View>

                  <Text style={[styles.label, { marginTop: 14 }]}>Opening Retained Earnings / Other Equity ($)</Text>
                  <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={retainedEarnings} onChangeText={setRetainedEarnings} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
                  <Text style={styles.helper}>Use this for profit or equity carried forward from before the app period. It is not current-period profit.</Text>

                  {!isPartnerMode ? <>
                    <Text style={[styles.label, { marginTop: 14 }]}>Opening Owner Capital / Equity ($)</Text>
                    <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent" value={ownerCapital} onChangeText={setOwnerCapital} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={styles.input} />
                  </> : null}

                  <Text style={[styles.label, { marginTop: 14 }]}>Period Start Date (YYYY-MM-DD)</Text>
                  <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
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
                      <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
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
                        <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
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
                        <OpeningTextInput selectionColor={theme.color.brandPrimary} cursorColor={theme.color.brandPrimary} underlineColorAndroid="transparent"
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

              {!isInvestorOnly ? <View style={{ marginTop: 14, padding: 10, borderRadius: theme.radius.md, backgroundColor: theme.color.surface, borderWidth: 1, borderColor: Math.abs((parseFloat(openingCash) || 0) + (parseFloat(openingInventory) || 0) + otherAssets.reduce((sum, asset) => sum + (parseFloat(asset.amount) || 0), 0) - (openingLiabilities.reduce((sum, liability) => sum + (parseFloat(liability.amount) || 0), 0) + (isPartnerMode ? members.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0) : (parseFloat(ownerCapital) || 0)) + (parseFloat(retainedEarnings) || 0))) < 0.005 ? theme.color.brandPrimary : theme.color.error }}><Text style={styles.helper}>Assets: ${((parseFloat(openingCash) || 0) + (parseFloat(openingInventory) || 0) + otherAssets.reduce((sum, asset) => sum + (parseFloat(asset.amount) || 0), 0)).toFixed(2)}  |  Liabilities + equity: ${(openingLiabilities.reduce((sum, liability) => sum + (parseFloat(liability.amount) || 0), 0) + (isPartnerMode ? members.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0) : (parseFloat(ownerCapital) || 0)) + (parseFloat(retainedEarnings) || 0)).toFixed(2)}</Text></View> : null}

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
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 16 },
    modalBox: { width: "100%", maxWidth: 440, maxHeight: "88%", backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, padding: 20, borderWidth: 1, borderColor: theme.color.border },
    header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
    title: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface },
    subtitle: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    closeBtn: { padding: 4 },
    label: { fontSize: 12, fontWeight: "700", color: theme.color.onSurface },
    subLabel: { fontSize: 11, fontWeight: "600", color: theme.color.muted },
    helper: { fontSize: 11, color: theme.color.muted, marginTop: 4 },
    sectionHeader: { fontSize: 14, fontWeight: "700", color: theme.color.brandPrimary, marginBottom: 10 },
    input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, paddingHorizontal: 12, paddingVertical: 8, fontSize: 13, color: theme.color.onSurface, ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as any) : {}) },
    typeBtn: { flex: 1, alignItems: "center", paddingVertical: 7, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    typeBtnActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "18" },
    typeBtnText: { fontSize: 11, fontWeight: "600", color: theme.color.muted },
    typeBtnTextActive: { color: theme.color.brandPrimary },
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
