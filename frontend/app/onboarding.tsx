import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";

type BizType = "shop" | "service" | "salon" | "handyman" | "vendor" | "it_consultant" | "freelancer";

const BIZ_TYPES: { key: BizType; label: string; icon: string; desc: string; taxLabel: string }[] = [
  { key: "shop", label: "Shop / Retail", icon: "storefront-outline", desc: "Sells physical goods, tracks inventory", taxLabel: "GST" },
  { key: "service", label: "Service Business", icon: "briefcase-outline", desc: "Consulting, repairs, professional services", taxLabel: "VAT" },
  { key: "it_consultant", label: "IT Consultant", icon: "laptop-outline", desc: "Software, IT services, tech consulting", taxLabel: "VAT" },
  { key: "freelancer", label: "Freelancer", icon: "person-outline", desc: "Design, writing, creative, gig work", taxLabel: "VAT" },
  { key: "salon", label: "Salon / Spa", icon: "cut-outline", desc: "Beauty, hair, wellness services", taxLabel: "VAT" },
  { key: "handyman", label: "Handyman / Contractor", icon: "hammer-outline", desc: "Plumbing, electrical, construction", taxLabel: "VAT" },
  { key: "vendor", label: "Vendor / Trader", icon: "cart-outline", desc: "Market stall, wholesale, distribution", taxLabel: "GST" },
];

const CURRENCIES = ["USD", "INR", "EUR", "GBP", "AED", "CAD", "AUD", "NGN", "KES", "ZAR", "BDT", "PKR", "PHP", "MXN", "BRL"];

export default function Onboarding() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [bizType, setBizType] = useState<BizType | null>(null);
  const [bizName, setBizName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [lockEnabled, setLockEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const LAST_STEP = 3;

  const finish = async () => {
    if (!bizType || !bizName.trim()) return;
    setSaving(true);
    try {
      const preset = BIZ_TYPES.find((b) => b.key === bizType)!;
      await api.updateSettings({
        businessName: bizName.trim(),
        currency,
        taxLabel: preset.taxLabel,
        taxRate: 0,
        lockEnabled,
        hasOnboarded: true,
        businessType: bizType,
      });
      router.replace("/(tabs)");
    } catch (e) { console.warn(e); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      {/* Progress dots */}
      <View style={styles.dots}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.dot, step === i && styles.dotActive]} />
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <View>
            <Text style={styles.title}>What kind of business do you run?</Text>
            <Text style={styles.sub}>We'll set up Ledgr to match your workflow.</Text>
            <View style={{ marginTop: theme.spacing.lg, gap: 10 }}>
              {BIZ_TYPES.map((b) => (
                <Pressable key={b.key} onPress={() => setBizType(b.key)} style={[styles.card, bizType === b.key && styles.cardSelected]}>
                  <Ionicons name={b.icon as any} size={28} color={bizType === b.key ? theme.color.brandPrimary : theme.color.muted} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[styles.cardLabel, bizType === b.key && { color: theme.color.brandPrimary }]}>{b.label}</Text>
                    <Text style={styles.cardDesc}>{b.desc}</Text>
                  </View>
                  {bizType === b.key && <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} />}
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 1 && (
          <View>
            <Text style={styles.title}>What's your business name?</Text>
            <Text style={styles.sub}>This appears on invoices and reports.</Text>
            <TextInput
              value={bizName}
              onChangeText={setBizName}
              placeholder="e.g. Sharma Electronics"
              placeholderTextColor={theme.color.muted}
              style={[styles.input, { marginTop: theme.spacing.xl }]}
              autoFocus
            />
          </View>
        )}

        {step === 2 && (
          <View>
            <Text style={styles.title}>Choose your currency</Text>
            <Text style={styles.sub}>You can change this later in Settings.</Text>
            <View style={{ marginTop: theme.spacing.lg, flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              {CURRENCIES.map((c) => (
                <Pressable key={c} onPress={() => setCurrency(c)} style={[styles.currBtn, currency === c && styles.currBtnSelected]}>
                  <Text style={[styles.currText, currency === c && { color: theme.color.brandPrimary, fontWeight: "700" }]}>{c}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {step === 3 && (
          <View>
            <Text style={styles.title}>Protect your books?</Text>
            <Text style={styles.sub}>
              Use your phone's fingerprint, face or PIN to lock sensitive actions like deleting or
              resetting data. There's no separate password to remember — it uses your device lock.
            </Text>
            <View style={{ marginTop: theme.spacing.xl, gap: 10 }}>
              <Pressable
                onPress={() => setLockEnabled(true)}
                style={[styles.card, lockEnabled && styles.cardSelected]}
              >
                <Ionicons name="lock-closed-outline" size={28} color={lockEnabled ? theme.color.brandPrimary : theme.color.muted} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.cardLabel, lockEnabled && { color: theme.color.brandPrimary }]}>Yes, enable app lock</Text>
                  <Text style={styles.cardDesc}>Ask for fingerprint / face / PIN on sensitive actions</Text>
                </View>
                {lockEnabled && <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} />}
              </Pressable>
              <Pressable
                onPress={() => setLockEnabled(false)}
                style={[styles.card, !lockEnabled && styles.cardSelected]}
              >
                <Ionicons name="lock-open-outline" size={28} color={!lockEnabled ? theme.color.brandPrimary : theme.color.muted} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.cardLabel, !lockEnabled && { color: theme.color.brandPrimary }]}>No, skip for now</Text>
                  <Text style={styles.cardDesc}>You can turn this on later in Settings</Text>
                </View>
                {!lockEnabled && <Ionicons name="checkmark-circle" size={22} color={theme.color.brandPrimary} />}
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {step > 0 && (
          <Pressable onPress={() => setStep((s) => s - 1)} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={theme.color.onSurface} />
            <Text style={{ color: theme.color.onSurface, fontWeight: "600" }}>Back</Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => {
            if (step === 0 && !bizType) return;
            if (step < LAST_STEP) setStep((s) => s + 1);
            else finish();
          }}
          disabled={saving || (step === 0 && !bizType)}
          style={[styles.nextBtn, (saving || (step === 0 && !bizType)) && { opacity: 0.5 }]}
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.nextText}>{step < LAST_STEP ? "Continue" : "Get Started"}</Text>}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    dots: { flexDirection: "row", justifyContent: "center", gap: 8, paddingTop: theme.spacing.lg },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.border },
    dotActive: { backgroundColor: theme.color.brandPrimary, width: 24 },
    title: { fontSize: 24, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.xl },
    sub: { fontSize: 14, color: theme.color.muted, marginTop: 6 },
    card: { flexDirection: "row", alignItems: "center", padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1.5, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    cardSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "10" },
    cardLabel: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    cardDesc: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    input: { borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 16, color: theme.color.onSurface, backgroundColor: theme.color.surfaceSecondary },
    currBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: theme.radius.md, borderWidth: 1.5, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    currBtnSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "10" },
    currText: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    footer: { flexDirection: "row", padding: theme.spacing.lg, gap: 10, borderTopWidth: 1, borderTopColor: theme.color.border },
    backBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: theme.spacing.md, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border },
    nextBtn: { flex: 1, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md, alignItems: "center" },
    nextText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  });
}
