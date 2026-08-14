import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, BackHandler } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { useOnboardingGate } from "@/src/context/OnboardingContext";
import { api } from "@/src/api";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";
import { deviceHasLock } from "@/src/utils/lock";
import { CAPABILITIES, getPersonaCapabilityDefaults } from "@/src/utils/capabilities";

const CURRENCIES = ["USD", "INR", "EUR", "GBP", "AED", "CAD", "AUD", "NGN", "KES", "ZAR", "BDT", "PKR", "PHP", "MXN", "BRL"];
const PERSONA_ICON: Record<string, string> = {
  mobile_invoicing: "document-text-outline", dropshipper: "paper-plane-outline", marketplace_seller: "storefront-outline",
  entrepreneur: "briefcase-outline", startup: "rocket-outline", developer: "code-slash-outline", content_creator: "videocam-outline",
  manufacturer: "construct-outline", import_export: "boat-outline", personal: "person-outline", retail: "storefront-outline",
  wholesale: "cube-outline", salon: "cut-outline", handyman: "hammer-outline", professional_service: "briefcase-outline",
  it_freelancer: "laptop-outline", vendor: "cart-outline", custom: "options-outline",
};

export default function Onboarding() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { markOnboarded } = useOnboardingGate();
  const [step, setStep] = useState(0);
  const [persona, setPersona] = useState<PersonaId | null>(null);
  const [bizName, setBizName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [multiLocation, setMultiLocation] = useState(false);
  const [saving, setSaving] = useState(false);
  const LAST_STEP = 3;
  const selectedPersona = PERSONAS.find((item) => item.id === persona);
  const selectedCapabilities = useMemo(() => {
    const base = persona ? getPersonaCapabilityDefaults({ activePersona: persona, selectedPersonas: [persona] }) : [];
    return multiLocation ? [...new Set([...base, "multi_location" as const])] : base;
  }, [persona, multiLocation]);
  const multiLocationEligible = ["retail", "wholesale", "vendor", "marketplace_seller", "dropshipper"].includes(persona || "");
  const selectedCapabilityLabels = selectedCapabilities
    .map((key) => CAPABILITIES.find((item) => item.key === key)?.label)
    .filter(Boolean)
    .slice(0, 5) as string[];

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setStep((current) => current > 0 ? current - 1 : current);
      return true;
    });
    return () => subscription.remove();
  }, []));

  const finish = async () => {
    const finalPersona = persona || "entrepreneur";
    const finalBizName = bizName.trim() || "My Business";
    setSaving(true);
    try {
      if (lockEnabled && !(await deviceHasLock())) {
        throw new Error("Set up a device PIN, fingerprint, or face unlock before enabling App Lock.");
      }
      const activeBookId = api.activeBookId();
      const v2Personas = [finalPersona];
      if (await api.v2BookVersion(activeBookId) == null) {
        const year = new Date().getFullYear();
        await api.initializeV2Book({
          book: { id: activeBookId, name: finalBizName, style: finalPersona === "manufacturer" ? "retail_partnership" : "standard", basis: "accrual" },
          period: { id: `${activeBookId}:period:${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
          personas: v2Personas,
        });
      }
      await api.updateSettings({
        businessName: finalBizName,
        currency,
        taxLabel: ["dropshipper", "marketplace_seller", "manufacturer", "import_export", "retail", "wholesale", "vendor"].includes(finalPersona) ? "GST" : "VAT",
        taxRate: 0,
        lockEnabled,
        hasOnboarded: true,
        businessType: finalPersona,
        enabledCapabilities: selectedCapabilities,
      });
      markOnboarded();
      router.replace("/(tabs)");
    } catch (e: any) {
      console.warn("onboarding finish error:", e);
      Alert.alert("Onboarding Error", e.message || "Failed to complete onboarding. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.brand}>LEDGR</Text>
          <Text style={styles.kicker}>Set up your focused workspace</Text>
        </View>
        <Text style={styles.stepText}>{step + 1} of {LAST_STEP + 1}</Text>
      </View>
      <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${((step + 1) / (LAST_STEP + 1)) * 100}%` }]} /></View>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <View>
            <Text style={styles.title}>What best describes your work?</Text>
            <Text style={styles.sub}>Choose one primary workspace. You can add more capabilities later without cluttering your Home screen.</Text>
            <View style={styles.personaGrid}>
              {PERSONAS.slice(0, 9).map((item) => {
                const selected = persona === item.id;
                return (
                  <Pressable key={item.id} onPress={() => setPersona(item.id)} style={[styles.personaCard, selected && styles.cardSelected]} accessibilityRole="radio" accessibilityState={{ selected }}>
                    <View style={[styles.iconCircle, selected && styles.iconCircleSelected]}><Ionicons name={(PERSONA_ICON[item.id] || "briefcase-outline") as any} size={23} color={selected ? theme.color.brandPrimary : theme.color.muted} /></View>
                    <Text style={[styles.personaLabel, selected && { color: theme.color.brandPrimary }]}>{item.label}</Text>
                    <Text style={styles.personaDesc} numberOfLines={2}>{item.description}</Text>
                    {selected && <Ionicons name="checkmark-circle" size={20} color={theme.color.brandPrimary} style={styles.check} />}
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.note}>Legacy business types remain available through existing books and settings.</Text>
          </View>
        )}

        {step === 1 && (
          <View>
            <Text style={styles.title}>What should we call your business?</Text>
            <Text style={styles.sub}>This name appears on invoices, reports, and shared documents.</Text>
            <TextInput value={bizName} onChangeText={setBizName} placeholder="e.g. Sharma Electronics" placeholderTextColor={theme.color.muted} style={styles.input} autoFocus accessibilityLabel="Business name" />
            <View style={styles.tipCard}><Ionicons name="sparkles-outline" size={20} color={theme.color.brandPrimary} /><Text style={styles.tipText}>Ledgr will start with a small workspace for {selectedPersona?.label || "your business"}. You can expand it later.</Text></View>
          </View>
        )}

        {step === 2 && (
          <View>
            <Text style={styles.title}>Choose your working currency</Text>
            <Text style={styles.sub}>You can change this later in Business Settings. Existing entries are not silently converted.</Text>
            <View style={styles.currencyGrid}>
              {CURRENCIES.map((value) => <Pressable key={value} onPress={() => setCurrency(value)} style={[styles.currencyButton, currency === value && styles.currencySelected]} accessibilityRole="radio" accessibilityState={{ selected: currency === value }}><Text style={[styles.currencyText, currency === value && { color: theme.color.brandPrimary }]}>{value}</Text></Pressable>)}
            </View>
          </View>
        )}

        {step === 3 && (
          <View>
            <Text style={styles.title}>Your workspace is ready</Text>
            <Text style={styles.sub}>We will start with these capabilities. Nothing else will compete for attention until you enable it.</Text>
            <View style={styles.previewCard}>
              <View style={styles.previewHeader}><View style={styles.iconCircleSelected}><Ionicons name={(PERSONA_ICON[persona || "entrepreneur"] || "briefcase-outline") as any} size={22} color={theme.color.brandPrimary} /></View><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.previewTitle}>{selectedPersona?.label || "Entrepreneur"}</Text><Text style={styles.previewSub}>{bizName.trim() || "My Business"} · {currency}</Text></View></View>
              <Text style={styles.previewKicker}>STARTING CAPABILITIES</Text>
              <View style={styles.chipWrap}>{selectedCapabilityLabels.map((label) => <View key={label} style={styles.capabilityChip}><Text style={styles.capabilityChipText}>{label}</Text></View>)}</View>
              <Text style={styles.previewHint}>Add capabilities anytime from Settings. Your data stays safe when a capability is hidden.</Text>
              <View style={[styles.tipCard, { marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceSecondary }]}><Ionicons name="cloud-offline-outline" size={20} color={theme.color.warning || theme.color.brandPrimary} /><Text style={styles.tipText}>Ledgr stores your books on this device. Android backup is not a substitute for a bookkeeping backup; export a JSON backup from Settings after important work and keep a copy somewhere safe.</Text></View>
            </View>
            {multiLocationEligible ? <View style={styles.lockCard}><View style={{ flex: 1 }}><Text style={styles.lockTitle}>I operate multiple stores or POS points</Text><Text style={styles.lockDesc}>Add locations, open drawers, transfer stock, and compare each shop later.</Text></View><Pressable onPress={() => setMultiLocation((value) => !value)} style={[styles.toggle, multiLocation && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: multiLocation }}><View style={[styles.toggleThumb, multiLocation && styles.toggleThumbOn]} /></Pressable></View> : null}
            <View style={styles.lockCard}><View style={{ flex: 1 }}><Text style={styles.lockTitle}>Protect sensitive actions</Text><Text style={styles.lockDesc}>Use your phone PIN, fingerprint, or face unlock before deleting or resetting data.</Text></View><Pressable onPress={() => setLockEnabled((value) => !value)} style={[styles.toggle, lockEnabled && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: lockEnabled }}><View style={[styles.toggleThumb, lockEnabled && styles.toggleThumbOn]} /></Pressable></View>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {step > 0 ? <Pressable onPress={() => setStep((value) => value - 1)} style={styles.backBtn}><Ionicons name="chevron-back" size={20} color={theme.color.onSurface} /><Text style={styles.backText}>Back</Text></Pressable> : <View />}
        <Pressable onPress={() => { if (step === 0 && !persona) return; if (step < LAST_STEP) setStep((value) => value + 1); else finish(); }} disabled={saving || (step === 0 && !persona)} style={[styles.nextBtn, (saving || (step === 0 && !persona)) && { opacity: 0.5 }]}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.nextText}>{step < LAST_STEP ? "Continue" : "Open my workspace"}</Text>}</Pressable>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    topBar: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg },
    brand: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "900", letterSpacing: 2 },
    kicker: { color: theme.color.muted, fontSize: 12, marginTop: 4 },
    stepText: { color: theme.color.muted, fontSize: 12, fontWeight: "700" },
    progressTrack: { height: 4, backgroundColor: theme.color.border, marginTop: theme.spacing.md },
    progressFill: { height: 4, backgroundColor: theme.color.brandPrimary, borderTopRightRadius: 4, borderBottomRightRadius: 4 },
    content: { padding: theme.spacing.lg, paddingBottom: 30, flexGrow: 1 },
    title: { fontSize: 27, lineHeight: 33, fontWeight: "800", color: theme.color.onSurface, marginTop: theme.spacing.xl },
    sub: { fontSize: 14, lineHeight: 20, color: theme.color.muted, marginTop: 8 },
    personaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: theme.spacing.lg },
    personaCard: { width: "31.8%", minHeight: 148, padding: 11, borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    cardSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12", borderWidth: 1.5 },
    iconCircle: { width: 42, height: 42, borderRadius: 21, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.surface },
    iconCircleSelected: { width: 42, height: 42, borderRadius: 21, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.brandPrimary + "1A" },
    personaLabel: { color: theme.color.onSurface, fontSize: 12, lineHeight: 16, fontWeight: "800", marginTop: 9 },
    personaDesc: { color: theme.color.muted, fontSize: 10, lineHeight: 13, marginTop: 3 },
    check: { position: "absolute", top: 9, right: 9 },
    note: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
    input: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 15, fontSize: 17, color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary, marginTop: theme.spacing.xl },
    tipCard: { flexDirection: "row", gap: 10, padding: 14, marginTop: 16, borderRadius: 16, backgroundColor: theme.color.brandPrimary + "10", borderWidth: 1, borderColor: theme.color.brandPrimary + "30" },
    tipText: { flex: 1, color: theme.color.onSurface, fontSize: 12, lineHeight: 18 },
    currencyGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: theme.spacing.xl },
    currencyButton: { minWidth: 74, paddingHorizontal: 15, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" },
    currencySelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12" },
    currencyText: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
    previewCard: { marginTop: theme.spacing.lg, borderRadius: 20, padding: 17, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border },
    previewHeader: { flexDirection: "row", alignItems: "center" },
    previewTitle: { color: theme.color.onSurface, fontSize: 16, fontWeight: "800" },
    previewSub: { color: theme.color.muted, fontSize: 12, marginTop: 3 },
    previewKicker: { color: theme.color.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1.3, marginTop: 20 },
    chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 10 },
    capabilityChip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20, backgroundColor: theme.color.brandPrimary + "16" },
    capabilityChipText: { color: theme.color.brandPrimary, fontSize: 11, fontWeight: "800" },
    previewHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
    lockCard: { flexDirection: "row", alignItems: "center", gap: 14, padding: 15, marginTop: 14, borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    lockTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
    lockDesc: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    toggle: { width: 50, height: 30, borderRadius: 15, padding: 3, justifyContent: "center", backgroundColor: theme.color.border },
    toggleOn: { backgroundColor: theme.color.brandPrimary },
    toggleThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff" },
    toggleThumbOn: { alignSelf: "flex-end" },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, padding: theme.spacing.lg, borderTopWidth: 1, borderTopColor: theme.color.border },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 3, paddingVertical: 13, paddingHorizontal: 8 },
    backText: { color: theme.color.onSurface, fontWeight: "700" },
    nextBtn: { flex: 1, backgroundColor: theme.color.brandPrimary, padding: 15, borderRadius: 15, alignItems: "center", maxWidth: 280 },
    nextText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  });
}
