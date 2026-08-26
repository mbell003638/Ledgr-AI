import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Switch, Alert, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";

import * as ImagePicker from "expo-image-picker";

import { useAnimations, useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import { PROVIDERS, type ProviderId } from "@/src/db/ai";
import { CURRENCIES, type TaxLabel } from "@/src/utils/currency";
import { ScreenHeader, Card } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";
import { deviceHasLock } from "@/src/utils/lock";

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: isExpanded ? theme.color.brandPrimary + "0D" : "transparent" }}>
      <GlowPressable
        topHighlight={false}
        haptic
        onPress={() => setExpandedKey(isExpanded ? null : title)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 48,
          paddingVertical: 12,
          paddingHorizontal: 10,
          marginHorizontal: -10,
          borderWidth: 0,
          borderRadius: 14,
        }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </GlowPressable>
      {isExpanded && <View style={{ paddingVertical: 16, paddingTop: 4, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};

export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { animationsEnabled, deviceReduceMotion, setAnimationsEnabled } = useAnimations();
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [key, setKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [taxLabel, setTaxLabel] = useState<TaxLabel>("None");
  const [taxLabelCustom, setTaxLabelCustom] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [invoiceTheme, setInvoiceTheme] = useState("navy_gold");
  const [bizProfile, setBizProfile] = useState({ businessName: "", businessAddress: "", businessPhone: "", businessEmail: "", taxRegNo: "", bankAccount: "", upiId: "", paymentDetails: "", invoiceTerms: "" });
  const [logo, setLogo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      const cfg = await getAIConfig();
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setBaseUrl(cfg.baseUrl || "");
      setLockEnabled(!!s.lockEnabled);
      setCurrency(s.currency || "USD");
      const rawLabel = s.taxLabel || "None";
      if (rawLabel === "None") {
        setTaxLabel("None");
        setTaxLabelCustom("");
      } else if (rawLabel === "Custom") {
        setTaxLabel("Custom");
        setTaxLabelCustom(s.taxLabelCustom || "");
      } else {
        setTaxLabel("Custom");
        setTaxLabelCustom(rawLabel);
      }
      if (s.themeMode && (s.themeMode === 'light' || s.themeMode === 'dark' || s.themeMode === 'navy_gold' || s.themeMode === 'amoled_blue' || s.themeMode === 'system')) {
        setMode(s.themeMode);
      }
      setTaxRate(s.taxRate ? String(s.taxRate) : "");
      setInvoiceTheme(s.invoiceTheme || "navy_gold");
      setBizProfile({
        businessName: s.businessName || "",
        businessAddress: s.businessAddress || "",
        businessPhone: s.businessPhone || "",
        businessEmail: s.businessEmail || "",
        taxRegNo: s.taxRegNo || "",
        bankAccount: s.bankAccount || "",
        upiId: s.upiId || "",
        paymentDetails: s.paymentDetails || "",
        invoiceTerms: s.invoiceTerms || "",
      });
      setLogo(s.logo || "");
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, [setMode]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      if (lockEnabled && !(await deviceHasLock())) {
        throw new Error("Set up a device PIN, fingerprint, or face unlock before enabling App Lock.");
      }
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      await setAIConfig({
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        baseUrl: baseUrl.trim() || undefined,
      });
      await api.updateSettings({
        lockEnabled,
        currency,
        taxLabel,
        taxLabelCustom: taxLabelCustom.trim(),
        taxRate: taxRate.trim() ? parseFloat(taxRate) : 0,
        invoiceTheme,
        themeMode: mode,
        animationsEnabled,
        ...bizProfile,
        logo,
      });
      setStatus({ ok: true, msg: "Settings saved." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setSaving(false);
    }
  };

  // ~150KB cap on the encoded logo — see advanced-settings.tsx / [H4].
  const LOGO_MAX_BYTES = 150 * 1024;
  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setStatus({ ok: false, msg: "Gallery permission denied" }); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1] });
    if (res.canceled || !res.assets[0].base64) return;
    const base64 = res.assets[0].base64;
    const approxBytes = Math.floor((base64.length * 3) / 4);
    if (approxBytes > LOGO_MAX_BYTES) {
      Alert.alert(
        "Logo too large",
        `This image is about ${Math.round(approxBytes / 1024)}KB. Please pick a smaller logo (under ${Math.round(LOGO_MAX_BYTES / 1024)}KB) — a tightly cropped square works best.`,
        [{ text: "Pick another", onPress: () => { void pickLogo(); } }, { text: "Cancel", style: "cancel" }],
      );
      return;
    }
    setLogo(`data:${res.assets[0].mimeType || "image/jpeg"};base64,${base64}`);
  };

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      return () => {
        setExpandedKey(null);
      };
    }, [])
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Settings" subtitle="Main Configuration" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            
            <Card shadowEnabled={false} style={styles.settingsGroup}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Business Profile</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Manage your basic company info and defaults.</Text>
              <AccordionRow title="Company Info & Logo" subtitle="Name, Contact, Tax Reg No" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={[styles.label, { fontSize: 13 }]}>Company Logo</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
                    {logo ? (
                      <Image source={{ uri: logo }} style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: theme.color.surfaceTertiary }} />
                    ) : (
                      <View style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: theme.color.surfaceTertiary, alignItems: "center", justifyContent: "center" }}>
                        <Ionicons name="image-outline" size={24} color={theme.color.muted} />
                      </View>
                    )}
                    <Pressable onPress={pickLogo} style={styles.addBtn}>
                      <Ionicons name="cloud-upload-outline" size={18} color={theme.color.brandPrimary} />
                      <Text style={styles.addText}>{logo ? "Change Logo" : "Upload Logo"}</Text>
                    </Pressable>
                    {logo && (
                      <Pressable onPress={() => setLogo("")} style={styles.addBtn}>
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                        <Text style={[styles.addText, { color: theme.color.error }]}>Remove</Text>
                      </Pressable>
                    )}
                  </View>

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Business Name</Text>
                  <TextInput value={bizProfile.businessName} onChangeText={(v) => setBizProfile((p) => ({ ...p, businessName: v }))} placeholder="e.g. Amit General Store" placeholderTextColor={theme.color.muted} style={styles.input} />
                  
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Address</Text>
                  <TextInput value={bizProfile.businessAddress} onChangeText={(v) => setBizProfile((p) => ({ ...p, businessAddress: v }))} placeholder="Street, City, State, ZIP" placeholderTextColor={theme.color.muted} style={styles.input} />
                  
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Phone</Text>
                  <TextInput value={bizProfile.businessPhone} onChangeText={(v) => setBizProfile((p) => ({ ...p, businessPhone: v }))} placeholder="+1 555 000 0000" placeholderTextColor={theme.color.muted} style={styles.input} />

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Email</Text>
                  <TextInput value={bizProfile.businessEmail} onChangeText={(v) => setBizProfile((p) => ({ ...p, businessEmail: v }))} placeholder="you@example.com" placeholderTextColor={theme.color.muted} style={styles.input} />

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Tax Reg. No (TRN / GSTIN / VAT)</Text>
                  <TextInput value={bizProfile.taxRegNo} onChangeText={(v) => setBizProfile((p) => ({ ...p, taxRegNo: v }))} placeholder="Shown on invoices" placeholderTextColor={theme.color.muted} style={styles.input} />

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Bank Account / IBAN / Interac</Text>
                  <TextInput value={bizProfile.bankAccount} onChangeText={(v) => setBizProfile((p) => ({ ...p, bankAccount: v }))} placeholder="Acct no, IBAN, or Interac email" placeholderTextColor={theme.color.muted} style={styles.input} />

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Payment ID / Link</Text>
                  <TextInput value={bizProfile.upiId} onChangeText={(v) => setBizProfile((p) => ({ ...p, upiId: v }))} placeholder="Interac, UPI ID, PayPal or payment link" placeholderTextColor={theme.color.muted} style={styles.input} />

                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Invoice Terms & Conditions</Text>
                  <TextInput value={bizProfile.invoiceTerms} onChangeText={(v) => setBizProfile((p) => ({ ...p, invoiceTerms: v }))} placeholder="Payment is due within X days..." placeholderTextColor={theme.color.muted} multiline style={[styles.input, { minHeight: 60 }]} />
                </View>
              </AccordionRow>
              <AccordionRow title="Currency & Tax Rates" subtitle="USD, GST/VAT" isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.label}>Currency</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {CURRENCIES.map((c) => (
                      <GlowPressable topHighlight={false} haptic hoverLift={-2} restingBorderColor={currency === c.code ? theme.color.brandPrimary : theme.color.border} key={c.code} onPress={() => setCurrency(c.code)} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: currency === c.code ? theme.color.brandPrimary : theme.color.border, backgroundColor: currency === c.code ? theme.color.brandPrimary + "20" : theme.color.surfaceTertiary }}>
                        <Text style={{ color: currency === c.code ? theme.color.brandPrimary : theme.color.onSurface, fontWeight: "600", fontSize: 14 }}>{c.symbol} {c.code}</Text>
                      </GlowPressable>
                    ))}
                  </View>

                  <Text style={[styles.label, { marginTop: theme.spacing.xl }]}>Tax Settings</Text>
                  <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Tax Label</Text>
                  <TextInput value={taxLabelCustom} onChangeText={(v) => { setTaxLabelCustom(v); setTaxLabel(v.trim() ? "Custom" : "None"); }} placeholder="e.g. GST, VAT (Leave blank for no tax)" placeholderTextColor={theme.color.muted} style={styles.input} />
                  
                  {taxLabelCustom.trim() !== "" && (
                    <>
                      <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>{taxLabelCustom} Rate %</Text>
                      <TextInput value={taxRate} onChangeText={setTaxRate} keyboardType="decimal-pad" placeholder="e.g. 18" placeholderTextColor={theme.color.muted} style={styles.input} />
                    </>
                  )}
                </View>
              </AccordionRow>
            </Card>

            <Card shadowEnabled={false} style={styles.settingsGroup}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Preferences</Text>
              <AccordionRow title="App Theme" subtitle={mode === "amoled_blue" ? "AMOLED Blue" : mode === "navy_gold" ? "AMOLED Black & Gold" : mode === "dark" ? "Emerald Dark" : mode === "light" ? "Emerald Light" : "System Default"} theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[ { id: "light", label: "Emerald Light", icon: "sunny-outline" }, { id: "dark", label: "Emerald Dark", icon: "moon-outline" }, { id: "navy_gold", label: "AMOLED Black & Gold", icon: "color-palette-outline" }, { id: "amoled_blue", label: "AMOLED Blue", icon: "flash-outline" }, { id: "system", label: "System", icon: "phone-portrait-outline" } ].map((m) => (
                    <GlowPressable topHighlight={false} haptic hoverLift={-2} restingBorderColor={mode === m.id ? theme.color.brandPrimary : theme.color.border} key={m.id} onPress={async () => { setMode(m.id as any); await api.updateSettings({ themeMode: m.id }); }} style={[{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary }, mode === m.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                      <Ionicons name={m.icon as any} size={16} color={mode === m.id ? theme.color.brandPrimary : theme.color.onSurface} />
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, mode === m.id && { color: theme.color.brandPrimary }]}>{m.label}</Text>
                    </GlowPressable>
                  ))}
                </View>
              </AccordionRow>
              <AccordionRow title="Invoice PDF Preset" subtitle={invoiceTheme === "navy_gold" ? "Black & Gold" : invoiceTheme === "amoled_blue" ? "Black & Blue" : invoiceTheme === "emerald" ? "Classic Emerald" : "Clean Minimal"} isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[ { id: "navy_gold", label: "Black & Gold" }, { id: "amoled_blue", label: "Black & Blue" }, { id: "emerald", label: "Classic Emerald" }, { id: "minimal", label: "Clean Minimal" } ].map((t) => (
                    <GlowPressable topHighlight={false} haptic hoverLift={-2} restingBorderColor={invoiceTheme === t.id ? theme.color.brandPrimary : theme.color.border} key={t.id} onPress={async () => { setInvoiceTheme(t.id); await api.updateSettings({ invoiceTheme: t.id }); }} style={[{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary }, invoiceTheme === t.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, invoiceTheme === t.id && { color: theme.color.brandPrimary }]}>{t.label}</Text>
                    </GlowPressable>
                  ))}
                </View>
              </AccordionRow>
              <AccordionRow title="Animations & haptics" subtitle={deviceReduceMotion ? "Off - follows device Reduce Motion" : animationsEnabled ? "Enabled - glow, motion and haptics" : "Off - static and silent interface"} isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 }}>
                  <View style={{ flex: 1, paddingRight: 16 }}>
                    <Text style={{ color: theme.color.onSurface, fontSize: 14, fontWeight: "600" }}>Enable interface animations</Text>
                    <Text style={{ color: theme.color.muted, fontSize: 12, marginTop: 4 }}>Controls glow, hover, bounce and drag motion. Defaults off.</Text>
                  </View>
                  <Switch value={animationsEnabled} onValueChange={async (enabled) => { setAnimationsEnabled(enabled); await api.updateSettings({ animationsEnabled: enabled }); }} trackColor={{ false: theme.color.border, true: theme.color.brandPrimary + "88" }} thumbColor={animationsEnabled ? theme.color.brandPrimary : theme.color.muted} />
                </View>
              </AccordionRow>
</Card>

            <GlowPressable topHighlight={false} haptic onPress={() => router.push("/customize-features")} style={{ marginTop: theme.spacing.lg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: animationsEnabled ? theme.color.brandPrimary : theme.color.border, backgroundColor: theme.color.surfaceSecondary, padding: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, paddingRight: 16 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.color.brandPrimary }}>Customize Dashboard & Feature Tabs</Text>
                  <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>Turn accounting tabs ON or OFF to fit your business</Text>
                </View>
                <Ionicons name="options-outline" size={22} color={theme.color.brandPrimary} />
              </View>
            </GlowPressable>

            <GlowPressable topHighlight={false} haptic onPress={() => router.push("/advanced-settings")} style={{ marginTop: theme.spacing.lg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, padding: 20, paddingBottom: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 20 }}>
                <View style={{ flex: 1, paddingRight: 16 }}>
                  <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.brandPrimary }}>Advanced Settings</Text>
                  <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>AI config, Workflows, Opening Balances, Backup...</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.color.brandPrimary} />
              </View>
            </GlowPressable>

            <GlowPressable
              topHighlight={false}
              haptic
              accessibilityRole="button"
              accessibilityLabel="Open Ledgr privacy policy"
              onPress={() => router.push("/privacy-data" as any)}
              style={{ marginTop: theme.spacing.lg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, padding: 20 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1, paddingRight: 16 }}>
                  <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.brandPrimary }}>Privacy & Data</Text>
                  <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>Privacy policy, AI data use and deletion information</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.color.brandPrimary} />
              </View>
            </GlowPressable>
            {status && (
              <View style={[styles.status, { backgroundColor: status.ok ? theme.color.successBg : theme.color.errorBg }]}>
                <Ionicons name={status.ok ? "checkmark-circle" : "alert-circle"} size={18} color={status.ok ? theme.color.success : theme.color.error} />
                <Text style={[styles.statusText, { color: status.ok ? theme.color.success : theme.color.error }]}>{status.msg}</Text>
              </View>
            )}

            <GlowPressable topHighlight={false} prominent haptic testID="btn-save-settings" onPress={save} disabled={saving} style={[styles.primaryBtn, saving && { opacity: 0.85 }]}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save Settings</Text>}
            </GlowPressable>
            <View style={{ height: 120 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    scroll: { paddingHorizontal: 18, paddingBottom: 60 },
    settingsGroup: { marginTop: theme.spacing.lg, padding: 18, borderRadius: theme.radius.card },
    label: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    hint: { fontSize: 12, color: theme.color.muted, marginTop: 4 },
    input: {
      marginTop: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      backgroundColor: theme.color.surface,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
      fontSize: 14,
      color: theme.color.onSurface,
    },
    primaryBtn: {
      backgroundColor: theme.color.brandPrimary,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.md,
      alignItems: "center",
      marginTop: theme.spacing.lg,
    },
    primaryText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    secondaryBtn: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      alignItems: "center",
      borderWidth: 1,
      borderColor: theme.color.brandPrimary,
    },
    secondaryText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 14 },
    status: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      padding: theme.spacing.md,
      borderRadius: theme.radius.md,
      marginTop: theme.spacing.md,
    },
    statusText: { fontSize: 13, fontWeight: "500", flex: 1 },
    modeRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.md },
    modeBtn: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center",
      gap: 6, padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
    },
    modeBtnActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    modeText: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
    modeTextActive: { color: theme.color.onBrandPrimary },
    currencyChip: {
      flexDirection: "row", alignItems: "center", justifyContent: "center",
      paddingVertical: 10, paddingHorizontal: 14, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
      minWidth: 88,
    },
    currencyChipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    currencyChipText: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    currencyChipTextActive: { color: theme.color.onBrandPrimary },
    backupRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.md },
    backupBtn: {
      flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
    },
    backupBtnPrimary: { backgroundColor: theme.color.brandPrimary },
    backupBtnSecondary: { borderWidth: 1, borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceSecondary },
    backupBtnTextPrimary: { color: "#fff", fontWeight: "600", fontSize: 13 },
    backupBtnTextSecondary: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
    resetInitBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.error, marginTop: theme.spacing.md,
    },
    resetInitText: { color: theme.color.error, fontWeight: "600", fontSize: 13 },
    resetCancelBtn: { flex: 1, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    resetCancelText: { color: theme.color.onSurface, fontWeight: "600", fontSize: 13 },
    resetConfirmBtn: { flex: 1.4, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center", backgroundColor: theme.color.error },
    resetConfirmText: { color: "#fff", fontWeight: "700", fontSize: 13 },
    entryRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    entryInput: { flex: 1 },
    entryAmount: { width: 110 },
    memberCard: { borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.spacing.md, marginTop: theme.spacing.md },
    subLabel: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
    lockToggle: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
      marginTop: theme.spacing.md,
    },
    lockToggleOn: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
    lockToggleText: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    bookRow: {
      flexDirection: "row", alignItems: "center", gap: 8,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface,
      marginTop: theme.spacing.sm,
    },
    bookRowActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12" },
    bookName: { flex: 1, fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    removeBtn: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.sm,
      borderRadius: theme.radius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    addBtn: {
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      padding: theme.spacing.md, borderRadius: theme.radius.md,
      borderWidth: 1, borderColor: theme.color.brandPrimary, marginTop: theme.spacing.md,
    },
    addText: { color: theme.color.brandPrimary, fontWeight: "600", fontSize: 13 },
  });
}

