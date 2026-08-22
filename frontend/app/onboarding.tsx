import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, BackHandler, Platform, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { useOnboardingGate } from "@/src/context/OnboardingContext";
import { api } from "@/src/api";
import { setRequestedHostingMode } from "@/src/utils/hostingMode";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";
import { deviceHasLock } from "@/src/utils/lock";
import { CAPABILITIES, CORE_CAPABILITIES, METRICS, getPersonaCapabilityDefaults, normalizeCapabilityDependencies, type CapabilityKey, type MetricKey } from "@/src/utils/capabilities";

const CURRENCIES = ["USD", "INR", "EUR", "GBP", "AED", "CAD", "AUD", "NGN", "KES", "ZAR", "BDT", "PKR", "PHP", "MXN", "BRL"];
const RECOMMENDED_PERSONA_IDS: PersonaId[] = ["mobile_invoicing", "dropshipper", "marketplace_seller", "entrepreneur", "startup", "developer", "content_creator", "manufacturer", "import_export", "retail"];

const PERSONA_ICON: Record<string, string> = {
  mobile_invoicing: "document-text-outline", dropshipper: "paper-plane-outline", marketplace_seller: "storefront-outline",
  entrepreneur: "briefcase-outline", startup: "rocket-outline", developer: "code-slash-outline", content_creator: "videocam-outline",
  manufacturer: "construct-outline", import_export: "boat-outline", personal: "person-outline", retail: "storefront-outline",
  wholesale: "cube-outline", salon: "cut-outline", handyman: "hammer-outline", professional_service: "briefcase-outline",
  it_freelancer: "laptop-outline", vendor: "cart-outline", saas: "cloud-outline", ecommerce: "cart-outline", agency: "megaphone-outline", accounting_practice: "calculator-outline", small_business: "business-outline", solo_founder: "person-outline", restaurant: "restaurant-outline", healthcare: "medkit-outline", education: "school-outline", legal: "briefcase-outline", nonprofit: "heart-outline", real_estate: "home-outline", construction: "hammer-outline", agriculture: "leaf-outline", automotive: "car-outline", hospitality: "bed-outline", custom: "options-outline",
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
  const [accountingStyle, setAccountingStyle] = useState<"standard" | "retail_partnership">("standard");
  const [customCapabilities, setCustomCapabilities] = useState<CapabilityKey[] | null>(null);
  const [selectedMetricKeys, setSelectedMetricKeys] = useState<MetricKey[]>([]);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const LAST_STEP = 3;
  const selectedPersona = PERSONAS.find((item) => item.id === persona);
  const personaCapabilities = useMemo(() => persona ? getPersonaCapabilityDefaults({ activePersona: persona, selectedPersonas: [persona] }) : [], [persona]);
  const selectedCapabilities = useMemo(() => {
    const base = normalizeCapabilityDependencies(customCapabilities || personaCapabilities);
    return multiLocation ? normalizeCapabilityDependencies([...base, "multi_location" as const]) : base.filter((key) => key !== "multi_location");
  }, [customCapabilities, multiLocation, personaCapabilities]);
  const recommendedPersonas = PERSONAS.filter((item) => RECOMMENDED_PERSONA_IDS.includes(item.id));
  const otherPersonas = PERSONAS.filter((item) => !RECOMMENDED_PERSONA_IDS.includes(item.id));
  const multiLocationEligible = ["retail", "wholesale", "vendor", "marketplace_seller", "dropshipper"].includes(persona || "");
  const selectedCapabilityLabels = selectedCapabilities
    .map((key) => CAPABILITIES.find((item) => item.key === key)?.label)
    .filter(Boolean) as string[];
  const metricOptions = useMemo(() => {
    const enabled = new Set(selectedCapabilities);
    return METRICS.filter((metric) => metric.requiredCapabilities.every((key) => enabled.has(key)));
  }, [selectedCapabilities]);

  const choosePersona = (nextPersona: PersonaId) => {
    setPersona(nextPersona);
    setCustomCapabilities(null);
    setSelectedMetricKeys([]);
    setShowCustomize(false);
    if (!RECOMMENDED_PERSONA_IDS.includes(nextPersona)) setMultiLocation(false);
  };

  const toggleCapability = (key: CapabilityKey) => {
    if (CORE_CAPABILITIES.includes(key)) return;
    const current = new Set(customCapabilities || personaCapabilities);
    if (current.has(key)) current.delete(key); else current.add(key);
    setCustomCapabilities(normalizeCapabilityDependencies([...current]));
  };

  const toggleMetric = (key: MetricKey) => {
    setSelectedMetricKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setStep((current) => current > 0 ? current - 1 : current);
      return true;
    });
    return () => subscription.remove();
  }, []));

  const toggleLock = async () => {
    if (lockEnabled) {
      setLockEnabled(false);
      return;
    }
    if (Platform.OS === "web") {
      Alert.alert("App Lock is device-only", "Enable App Lock from the Android app after setting a device PIN, fingerprint, or face unlock.");
      return;
    }
    if (!(await deviceHasLock())) {
      Alert.alert("Set up device security first", "Set up a device PIN, fingerprint, or face unlock before enabling App Lock.");
      return;
    }
    setLockEnabled(true);
  };

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
          book: { id: activeBookId, name: finalBizName, style: accountingStyle, basis: "accrual" },
          period: { id: `${activeBookId}:period:${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` },
          personas: v2Personas,
        });
      }
      const currentBookConfig = await api.getV2BookConfig().catch(() => null);
      if (currentBookConfig && currentBookConfig.style !== accountingStyle) {
        await api.updateV2BookConfig({
          style: accountingStyle,
          basis: currentBookConfig.basis,
          periodPolicy: currentBookConfig.periodPolicy,
          selectedPersonas: currentBookConfig.selectedPersonas,
          activePersona: currentBookConfig.activePersona,
          retailPartnership: {
            ...currentBookConfig.retailPartnership,
            enabled: accountingStyle === "retail_partnership",
          },
        });
      }
      await setRequestedHostingMode("local_only");
      await api.updateSettings({
        businessName: finalBizName,
        currency,
        taxLabel: ["dropshipper", "marketplace_seller", "manufacturer", "import_export", "retail", "wholesale", "vendor"].includes(finalPersona) ? "GST" : "VAT",
        taxRate: 0,
        lockEnabled,
        hasOnboarded: true,
        businessType: finalPersona,
        enabledFeatures: null,
        enabledCapabilities: selectedCapabilities,
        workspaceMetricKeys: selectedMetricKeys.filter((key) => metricOptions.some((metric) => metric.key === key)),
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

      <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: theme.spacing.lg }]} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <View>
            <Text style={styles.title}>What best describes your work?</Text>
            <Text style={styles.sub}>Choose one primary workspace. Ledgr will tailor the app, reports, accounts, and workflows around it.</Text>
            <Pressable
              onPress={() => setShowPersonaPicker(true)}
              style={[styles.personaSelector, persona && styles.personaSelectorSelected]}
              accessibilityRole="button"
              accessibilityLabel={selectedPersona ? `Selected workspace: ${selectedPersona.label}` : "Choose a primary workspace"}
              accessibilityHint="Opens the list of business types"
            >
              <View style={[styles.iconCircle, persona && styles.iconCircleSelected]}>
                <Ionicons name={(PERSONA_ICON[persona || "custom"] || "options-outline") as any} size={22} color={persona ? theme.color.brandPrimary : theme.color.muted} />
              </View>
              <View style={styles.personaSelectorCopy}>
                <Text style={styles.selectorKicker}>{persona ? "SELECTED WORKSPACE" : "PRIMARY WORKSPACE"}</Text>
                <Text style={[styles.selectorTitle, persona && { color: theme.color.brandPrimary }]}>{selectedPersona?.label || "Choose a business type"}</Text>
                <Text style={styles.selectorDescription} numberOfLines={2}>{selectedPersona?.description || "Retail, dropshipping, startups, developers, creators, manufacturing, trading, and more."}</Text>
              </View>
              <Ionicons name="chevron-down" size={22} color={theme.color.muted} />
            </Pressable>
            <Text style={styles.note}>This choice controls the starting chart-of-accounts pack, visible workflows, reports, metrics, and Home shortcuts. You can fine-tune capabilities on the next step.</Text>
            <Modal visible={showPersonaPicker} transparent animationType="slide" onRequestClose={() => setShowPersonaPicker(false)}>
              <View style={styles.modalBackdrop}>
                <View style={styles.personaModal}>
                  <View style={styles.modalHeader}>
                    <View>
                      <Text style={styles.title}>Customize your workspace</Text>
                      <Text style={styles.modalSub}>Select the business model that best matches how you earn and spend.</Text>
                    </View>
                    <Pressable onPress={() => setShowPersonaPicker(false)} accessibilityRole="button" accessibilityLabel="Close workspace picker" style={styles.modalClose}><Ionicons name="close" size={22} color={theme.color.onSurface} /></Pressable>
                  </View>
                  <ScrollView contentContainerStyle={styles.personaOptions} keyboardShouldPersistTaps="handled">
                    <Text style={styles.modalGroupLabel}>Recommended workspaces</Text>
                    {recommendedPersonas.map((item) => {
                      const selected = persona === item.id;
                      return <Pressable key={item.id} onPress={() => { choosePersona(item.id); setShowPersonaPicker(false); }} style={[styles.personaOption, selected && styles.personaOptionSelected]} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${item.label}: ${item.description}`}><View style={[styles.optionIcon, selected && styles.iconCircleSelected]}><Ionicons name={(PERSONA_ICON[item.id] || "briefcase-outline") as any} size={20} color={selected ? theme.color.brandPrimary : theme.color.muted} /></View><View style={styles.optionCopy}><Text style={[styles.optionTitle, selected && { color: theme.color.brandPrimary }]}>{item.label}</Text><Text style={styles.optionDescription} numberOfLines={2}>{item.description}</Text></View>{selected ? <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} /> : null}</Pressable>;
                    })}
                    <Text style={styles.modalGroupLabel}>Other business types</Text>
                    {otherPersonas.map((item) => {
                      const selected = persona === item.id;
                      return <Pressable key={item.id} onPress={() => { choosePersona(item.id); setShowPersonaPicker(false); }} style={[styles.personaOption, selected && styles.personaOptionSelected]} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${item.label}: ${item.description}`}><View style={[styles.optionIcon, selected && styles.iconCircleSelected]}><Ionicons name={(PERSONA_ICON[item.id] || "briefcase-outline") as any} size={20} color={selected ? theme.color.brandPrimary : theme.color.muted} /></View><View style={styles.optionCopy}><Text style={[styles.optionTitle, selected && { color: theme.color.brandPrimary }]}>{item.label}</Text><Text style={styles.optionDescription} numberOfLines={2}>{item.description}</Text></View>{selected ? <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} /> : null}</Pressable>;
                    })}
                  </ScrollView>
                </View>
              </View>
            </Modal>
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
              <Text style={styles.previewKicker}>ACCOUNTING MODEL</Text>
              <View style={styles.accountingChoiceRow}>
                <Pressable testID="onboarding-accounting-standard" onPress={() => setAccountingStyle("standard")} accessibilityRole="radio" accessibilityState={{ selected: accountingStyle === "standard" }} style={[styles.accountingChoice, accountingStyle === "standard" && styles.accountingChoiceSelected]}><Text style={[styles.accountingChoiceTitle, accountingStyle === "standard" && { color: theme.color.brandPrimary }]}>Standard entity</Text><Text style={styles.accountingChoiceText}>One business ledger with normal owner equity and liabilities.</Text></Pressable>
                <Pressable testID="onboarding-accounting-equity-split" onPress={() => setAccountingStyle("retail_partnership")} accessibilityRole="radio" accessibilityState={{ selected: accountingStyle === "retail_partnership" }} style={[styles.accountingChoice, accountingStyle === "retail_partnership" && styles.accountingChoiceSelected]}><Text style={[styles.accountingChoiceTitle, accountingStyle === "retail_partnership" && { color: theme.color.brandPrimary }]}>Equity split</Text><Text style={styles.accountingChoiceText}>Track partner capital, ownership shares, drawings, and profit allocation.</Text></Pressable>
              </View>
              <Text style={styles.previewKicker}>STARTING CAPABILITIES</Text>
              <View style={styles.chipWrap}>{selectedCapabilityLabels.slice(0, 6).map((label) => <View key={label} style={styles.capabilityChip}><Text style={styles.capabilityChipText}>{label}</Text></View>)}</View>
              <Text style={styles.previewHint}>{selectedCapabilities.length} workflows are enabled for this workspace. Hidden workflows do not appear on Home but can be restored later.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={showCustomize ? "Hide workspace customization" : "Customize workspace capabilities"} onPress={() => setShowCustomize((value) => !value)} style={styles.customizeButton}><Ionicons name="options-outline" size={17} color={theme.color.brandPrimary} /><Text style={styles.customizeButtonText}>{showCustomize ? "Hide customization" : "Customize workspace"}</Text></Pressable>
              {showCustomize ? <View style={styles.customizePanel}><Text style={styles.customizeTitle}>Choose the workflows you need</Text><Text style={styles.customizeHint}>Core accounting, cash controls, financial reporting, and multi-location are configured in their dedicated choices below.</Text>{CAPABILITIES.filter((item) => !CORE_CAPABILITIES.includes(item.key) && item.key !== "multi_location").map((item) => { const enabled = selectedCapabilities.includes(item.key); return <Pressable key={item.key} onPress={() => toggleCapability(item.key)} accessibilityRole="switch" accessibilityLabel={item.label} accessibilityState={{ checked: enabled }} style={[styles.customizeRow, enabled && styles.customizeRowEnabled]}><View style={{ flex: 1, paddingRight: 10 }}><Text style={styles.customizeRowTitle}>{item.label}</Text><Text style={styles.customizeRowDesc}>{item.description}</Text></View><View style={[styles.toggle, enabled && styles.toggleOn]}><View style={[styles.toggleThumb, enabled && styles.toggleThumbOn]} /></View></Pressable>; })}</View> : null}
              {metricOptions.length ? <View style={styles.metricPanel}><Text style={styles.customizeTitle}>Choose report metrics</Text><Text style={styles.customizeHint}>Select only the metrics you want in Reports. Unselected metrics stay hidden; they never appear on Home.</Text>{metricOptions.map((metric) => { const selected = selectedMetricKeys.includes(metric.key); return <Pressable key={metric.key} onPress={() => toggleMetric(metric.key)} accessibilityRole="checkbox" accessibilityLabel={`Show ${metric.label} in reports`} accessibilityState={{ checked: selected }} style={[styles.metricRow, selected && styles.customizeRowEnabled]}><View style={{ flex: 1, paddingRight: 10 }}><Text style={styles.customizeRowTitle}>{metric.label}</Text><Text style={styles.customizeRowDesc}>{metric.description}</Text></View><Ionicons name={selected ? "checkbox" : "square-outline"} size={22} color={selected ? theme.color.brandPrimary : theme.color.muted} /></Pressable>; })}</View> : null}
              <View style={[styles.tipCard, { marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceSecondary }]}><Ionicons name="cloud-offline-outline" size={20} color={theme.color.warning || theme.color.brandPrimary} /><Text style={styles.tipText}>Ledgr stores your books on this device. Android backup is not a substitute for a bookkeeping backup; export an encrypted backup from Settings after important work and keep a copy somewhere safe.</Text></View>
              <View testID="onboarding-hosting-mode" style={styles.hostingCard}><Text style={styles.hostingTitle}>Local-only mode</Text><Text style={styles.hostingText}>Ledgr works offline on this device by default. You can create an encrypted backup anytime, or enable private sync later when you need your own server for multiple devices.</Text></View>
            </View>
            {multiLocationEligible ? <View style={styles.lockCard}><View style={{ flex: 1 }}><Text style={styles.lockTitle}>I operate multiple stores or POS points</Text><Text style={styles.lockDesc}>Add locations, open drawers, transfer stock, and compare each shop later.</Text></View><Pressable onPress={() => setMultiLocation((value) => !value)} style={[styles.toggle, multiLocation && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: multiLocation }}><View style={[styles.toggleThumb, multiLocation && styles.toggleThumbOn]} /></Pressable></View> : null}
            <View style={styles.lockCard}><View style={{ flex: 1 }}><Text style={styles.lockTitle}>Protect sensitive actions</Text><Text style={styles.lockDesc}>Use your phone PIN, fingerprint, or face unlock before deleting or resetting data.</Text></View><Pressable onPress={toggleLock} style={[styles.toggle, lockEnabled && styles.toggleOn]} accessibilityRole="switch" accessibilityState={{ checked: lockEnabled }} accessibilityLabel="Protect sensitive actions with App Lock"><View style={[styles.toggleThumb, lockEnabled && styles.toggleThumbOn]} /></Pressable></View>
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
    content: { padding: theme.spacing.lg, paddingBottom: 30, flexGrow: 1, width: "100%", maxWidth: 1040, alignSelf: "center" },
    title: { fontSize: 27, lineHeight: 33, fontWeight: "800", color: theme.color.onSurface, marginTop: theme.spacing.xl },
    sub: { fontSize: 14, lineHeight: 20, color: theme.color.muted, marginTop: 8 },
    groupLabel: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "900", textTransform: "uppercase", letterSpacing: 0.8, marginTop: theme.spacing.lg },
    personaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: theme.spacing.lg, justifyContent: "flex-start" },
    personaCard: { minHeight: 154, padding: 13, borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    cardSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12", borderWidth: 1.5 },
    iconCircle: { width: 42, height: 42, borderRadius: 21, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.surface },
    iconCircleSelected: { width: 42, height: 42, borderRadius: 21, justifyContent: "center", alignItems: "center", backgroundColor: theme.color.brandPrimary + "1A" },
    iconCircleCompact: { width: 32, height: 32, borderRadius: 16 },
    personaCardCompact: { minHeight: 132, padding: 9, borderRadius: 14 },
    personaLabel: { color: theme.color.onSurface, fontSize: 13, lineHeight: 17, fontWeight: "800", marginTop: 10 },
    personaLabelCompact: { fontSize: 10.5, lineHeight: 13, marginTop: 7 },
    personaDesc: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 4 },
    personaDescCompact: { fontSize: 9, lineHeight: 11, marginTop: 3 },
    check: { position: "absolute", top: 9, right: 9 },
    note: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
    personaSelector: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: theme.spacing.xl, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    personaSelectorSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "08" },
    personaSelectorCopy: { flex: 1 },
    selectorKicker: { color: theme.color.muted, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
    selectorTitle: { color: theme.color.onSurface, fontSize: 16, lineHeight: 20, fontWeight: "800", marginTop: 3 },
    selectorDescription: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 3 },
    modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.42)" },
    personaModal: { maxHeight: "88%", borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.color.surface, paddingTop: 18, paddingBottom: 10 },
    modalHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: theme.color.border },
    modalTitle: { color: theme.color.onSurface, fontSize: 18, fontWeight: "900" },
    modalSub: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 4, maxWidth: 290 },
    modalClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: theme.color.surfaceSecondary },
    personaOptions: { paddingHorizontal: 14, paddingBottom: 22 },
    modalGroupLabel: { color: theme.color.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1, marginTop: 16, marginBottom: 7, paddingHorizontal: 4, textTransform: "uppercase" },
    personaOption: { flexDirection: "row", alignItems: "center", gap: 11, padding: 11, minHeight: 66, borderRadius: 15, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, marginBottom: 8 },
    personaOptionSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "10" },
    optionIcon: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 17, backgroundColor: theme.color.surface },
    optionCopy: { flex: 1 },
    optionTitle: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" },
    optionDescription: { color: theme.color.muted, fontSize: 10, lineHeight: 13, marginTop: 2 },
    customizeButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, borderWidth: 1, borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "10", marginTop: theme.spacing.md },
    customizeButtonText: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800" },
    customizePanel: { marginTop: theme.spacing.md, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    metricPanel: { marginTop: theme.spacing.md, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.color.brandPrimary + "55", backgroundColor: theme.color.brandPrimary + "08" },
    customizeTitle: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" },
    customizeHint: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 4, marginBottom: 8 },
    customizeRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.color.border },
    customizeRowEnabled: { backgroundColor: theme.color.brandPrimary + "08" },
    metricRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.color.border },
    customizeRowTitle: { color: theme.color.onSurface, fontSize: 12, fontWeight: "800" },
    customizeRowDesc: { color: theme.color.muted, fontSize: 10, lineHeight: 14, marginTop: 2 },
    input: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 15, fontSize: 17, color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary, marginTop: theme.spacing.xl },
    tipCard: { flexDirection: "row", gap: 10, padding: 14, marginTop: 16, borderRadius: 16, backgroundColor: theme.color.brandPrimary + "10", borderWidth: 1, borderColor: theme.color.brandPrimary + "30" },
    tipText: { flex: 1, color: theme.color.onSurface, fontSize: 12, lineHeight: 18 },
    hostingCard: { padding: 14, marginTop: 12, borderRadius: 16, backgroundColor: theme.color.brandPrimary + "0D", borderWidth: 1, borderColor: theme.color.brandPrimary + "35" },
    hostingTitle: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800" },
    hostingText: { color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
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
    accountingChoiceRow: { flexDirection: "row", gap: 8, marginTop: 10 },
    accountingChoice: { flex: 1, minHeight: 104, padding: 11, borderRadius: 14, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface },
    accountingChoiceSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "12" },
    accountingChoiceTitle: { color: theme.color.onSurface, fontSize: 12, fontWeight: "800" },
    accountingChoiceText: { color: theme.color.muted, fontSize: 10, lineHeight: 14, marginTop: 5 },
    previewHint: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 14 },
    lockCard: { flexDirection: "row", alignItems: "center", gap: 14, padding: 15, marginTop: 14, borderRadius: 18, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    lockTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
    lockDesc: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
    toggle: { width: 50, height: 30, borderRadius: 15, padding: 3, justifyContent: "center", backgroundColor: theme.color.border },
    toggleOn: { backgroundColor: theme.color.brandPrimary },
    toggleThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff" },
    toggleThumbOn: { alignSelf: "flex-end" },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: theme.spacing.lg, paddingTop: 12, paddingBottom: 16, borderTopWidth: 1, borderTopColor: theme.color.border, backgroundColor: theme.color.surface },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 3, paddingVertical: 13, paddingHorizontal: 8, minWidth: 76 },
    backText: { color: theme.color.onSurface, fontWeight: "700", fontSize: 14 },
    nextBtn: { flex: 1, backgroundColor: theme.color.brandPrimary, paddingVertical: 15, paddingHorizontal: 20, borderRadius: 15, alignItems: "center", maxWidth: 320, minHeight: 50 },
    nextText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  });
}
