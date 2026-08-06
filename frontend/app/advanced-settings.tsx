import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { useTheme, useThemeMode, useAnimations } from "@/src/context/ThemeContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import { PROVIDERS, type ProviderId } from "@/src/db/ai";
import { ScreenHeader, Card } from "@/src/components/UI";
import { GlowPressable } from "@/src/components/GlowPressable";
import { shareJsonFile, pickJsonFile } from "@/src/utils/share";
import { deviceHasLock, requireAuth } from "@/src/utils/lock";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";

const SectionTitle = ({ title, theme }: any) => (
  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.muted, textTransform: "uppercase", letterSpacing: 1, marginLeft: 12, marginBottom: 8, marginTop: theme.spacing.xl }}>{title}</Text>
);

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: isExpanded ? theme.color.brandPrimary + "0D" : "transparent" }}>
      <GlowPressable
        topHighlight={false}
        haptic
        animateBorder
        restingBorderColor="transparent"
        hoverBorderColor={theme.color.brandPrimary}
        pressScale={0.97}
        hoverScale={1.008}
        hoverLift={-2}
        onPress={() => setExpandedKey(isExpanded ? null : title)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 48,
          paddingVertical: 12,
          paddingHorizontal: 10,
          marginHorizontal: -10,
          borderWidth: 1,
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

const SimpleRow = ({ title, subtitle, onPress, isLast, theme, rightElement }: any) => (
  <GlowPressable
    topHighlight={false}
    animateBorder={false}
    pressScale={0.97}
    hoverScale={1.008}
    haptic
    hoverLift={-2}
    onPress={onPress}
    style={{
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 48,
      paddingVertical: 12,
      paddingHorizontal: 10,
      marginHorizontal: -10,
      borderWidth: 0,
      borderBottomWidth: isLast ? 0 : 1,
      borderBottomColor: theme.color.border,
      borderRadius: 14,
    }}
  >
    <View style={{ flex: 1, paddingRight: 16 }}>
      <Text style={[{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }, rightElement?.titleStyle]}>{title}</Text>
      {subtitle && <Text style={[{ fontSize: 12, color: theme.color.muted, marginTop: 4 }, rightElement?.subtitleStyle]}>{subtitle}</Text>}
    </View>
    {rightElement?.custom || <Ionicons name="chevron-forward" size={20} color={rightElement?.chevronColor || theme.color.muted} />}
  </GlowPressable>
);

export default function AdvancedSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { setAnimationsEnabled } = useAnimations();
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [key, setKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // Members = the owners/investors who put in capital and share profit.
  // Each: { name, amount (investment), profitSharePct (optional) }.
  const [members, setMembers] = useState<{ name: string; amount: string; profitSharePct: string }[]>([]);
  const [lockEnabled, setLockEnabled] = useState(false);
  // Books = separate isolated accounts (e.g. Shop, Technician).
  const [books, setBooks] = useState<{ id: string; name: string; businessType?: string }[]>([]);
  const [activeBook, setActiveBookState] = useState("default");
  const [newBookName, setNewBookName] = useState("");
  const [addingBook, setAddingBook] = useState(false);
  const [newBookPersona, setNewBookPersona] = useState<PersonaId>("custom");
  const [bizSection, setBizSection] = useState<"basic" | "contact" | "banking" | "terms" | "all">("basic");
  const [loading, setLoading] = useState(true);
  const [accountingBasis, setAccountingBasis] = useState<"cash" | "accrual">("cash");
  const [accountingStyle, setAccountingStyle] = useState<"retail_partnership" | "standard">("standard");
  const [selectedPersonas, setSelectedPersonas] = useState<PersonaId[]>(["custom"]);
  const [activePersona, setActivePersona] = useState<PersonaId>("custom");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const updateAccountingStyle = async (style: "retail_partnership" | "standard") => {
    setAccountingStyle(style);
    await api.updateSettings({ accountingStyle: style });
    try {
      const v2 = await api.getV2BookConfig();
      if (v2) {
        await api.updateV2BookConfig({
          style,
          basis: v2.basis,
          selectedPersonas: v2.selectedPersonas,
          activePersona: v2.activePersona,
          retailPartnership: {
            ...v2.retailPartnership,
            enabled: style === "retail_partnership",
          },
        });
      }
    } catch { /* v2 update fallback */ }
  };

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      const cfg = await getAIConfig();
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setBaseUrl(cfg.baseUrl || "");
      setAccountingBasis(s.accountingBasis === "accrual" ? "accrual" : "cash");
      setAccountingStyle(s.accountingStyle === "retail_partnership" ? "retail_partnership" : "standard");
      const configuredPersonas: PersonaId[] = Array.isArray(s.selectedPersonas) && s.selectedPersonas.length ? s.selectedPersonas as PersonaId[] : ["custom"];
      setSelectedPersonas(configuredPersonas);
      setActivePersona((s.activePersona as PersonaId) || configuredPersonas[0]);
      // Members: prefer the structured investors[]; fall back to legacy partnerNames[].
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
      try {
        const v2 = await api.getV2BookConfig();
        if (v2) {
          setAccountingBasis(v2.basis);
          setSelectedPersonas(v2.selectedPersonas);
          setActivePersona(v2.activePersona);
          setMembers(v2.retailPartnership.members.map((m) => ({ name: m.name, amount: m.openingContribution ? String(m.openingContribution) : "", profitSharePct: m.profitSharePct ? String(m.profitSharePct) : "" })));
        }
      } catch { /* legacy settings remain the fallback until V2 is available */ }
      setLockEnabled(!!s.lockEnabled);
      // Load the list of books (accounts) + which one is active.
      try {
        const bks = await api.listBooks();
        setBooks(bks);
        setActiveBookState(api.activeBookId());
      } catch { /* books optional */ }
      if (s.themeMode && (s.themeMode === 'light' || s.themeMode === 'dark' || s.themeMode === 'navy_gold' || s.themeMode === 'amoled_blue' || s.themeMode === 'system')) {
        setMode(s.themeMode);
      }
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

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
      try {
        await api.updateV2BookConfig({
          basis: accountingBasis,
          style: accountingStyle,
          selectedPersonas,
          activePersona,
          retailPartnership: {
            enabled: accountingStyle === "retail_partnership",
            commissionPct: 0,
            inventoryCadence: "irregular",
            members: members.map((m) => ({ name: m.name.trim(), openingContribution: m.amount.trim() ? parseFloat(m.amount) : 0, profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0 })).filter((m) => m.name),
          },
        });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({
        accountingBasis,
        selectedPersonas,
        activePersona,
        accountingStyle,
        // Members → both the structured investors[] AND legacy partnerNames[]
        // (kept in sync so drawings attribution + older code keep working).
        investors: members
          .map((m) => ({
            id: m.name.trim(),
            name: m.name.trim(),
            amount: m.amount.trim() ? parseFloat(m.amount) : 0,
            profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0,
          }))
          .filter((m) => m.name),
        partnerNames: members.map((m) => m.name.trim()).filter(Boolean),
        lockEnabled,
        themeMode: mode,
      });
      setStatus({ ok: true, msg: "Settings saved." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const meta = PROVIDERS.find((p) => p.id === provider)!;
      await setAIConfig({
        provider,
        apiKey: key.trim(),
        model: modelName.trim() || meta.defaultModel,
        baseUrl: baseUrl.trim() || undefined,
      });
      const r = await api.testKey();
      setTestResult({ ok: true, msg: `✓ Connected` });
    } catch (e: any) {
      setTestResult({ ok: false, msg: `✗ ${e.message || "Failed"}` });
    } finally {
      setTesting(false);
    }
  };

  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const doExport = async () => {
    setBusy("export"); setStatus(null);
    try {
      const full: any = await api.exportBackup();
      // [Vault C2] If the legacy mirror diverged from the authoritative V2 ledger,
      // show the discrepancies once before sharing. Export still proceeds after.
      const { warnings, ...data } = full; // warnings are for the UI, not the file
      const warns: string[] = Array.isArray(warnings) ? warnings : [];
      if (warns.length) {
        Alert.alert("Heads up before exporting", warns.join("\n\n"));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      await shareJsonFile(`ledgr-backup-${stamp}.json`, data);
      setStatus({ ok: true, msg: "Backup ready — share via WhatsApp or save." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Export failed" });
    } finally { setBusy(null); }
  };

  const doImport = async () => {
    setBusy("import"); setStatus(null);
    try {
      const picked = await pickJsonFile();
      if (!picked.ok) {
        // Cancel is a silent no-op; an unreadable/corrupted file is surfaced. [M1]
        if (picked.reason === "invalid") {
          setStatus({ ok: false, msg: "Backup file is unreadable or corrupted." });
        }
        setBusy(null); return;
      }
      const data = picked.data;
      if (!data || !data._meta || data._meta.app !== "ledgr") {
        setStatus({ ok: false, msg: "Not a Ledgr backup file." });
        setBusy(null); return;
      }
      const result: any = await api.importBackup({ ...data, mode: "replace" });
      // Surface any restore warnings (e.g. a pre-V2 backup rebuilding the ledger). [C1]
      const warn: string[] = Array.isArray(result?.warnings) ? result.warnings : [];
      if (warn.length) {
        Alert.alert("Restore complete — please review", warn.join("\n\n"));
      }
      setStatus({ ok: true, msg: "Data restored! Restart or pull-to-refresh." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Import failed" });
    } finally { setBusy(null); }
  };

  const doReset = async () => {
    const ok = await requireAuth("Confirm to reset all accounting data");
    if (!ok) {
      setConfirmReset(false);
      return;
    }
    setResetting(true); setStatus(null);
    try {
      await api.clearAccountingData();
      setStatus({ ok: true, msg: "Accounting data cleared. Preferences and AI configuration were preserved." });
      setConfirmReset(false);
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Reset failed" });
    } finally { setResetting(false); }
  };

  const doFactoryReset = async () => {
    const ok = await requireAuth("Confirm full device factory reset");
    if (!ok) { setConfirmFactoryReset(false); return; }
    setResetting(true); setStatus(null);
    try {
      await api.factoryReset();
      // factoryReset wipes the persisted theme/animation prefs, but the live
      // ThemeContext only hydrates on mount — reset it in memory too so the app
      // returns to its pristine system-default look immediately (not the user's
      // old theme lingering until the next cold start).
      setMode('system');
      setAnimationsEnabled(false);
      router.replace('/onboarding' as any);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Factory reset failed" });
    } finally { setResetting(false); setConfirmFactoryReset(false); }
  };
  const updateMember = (i: number, field: "name" | "amount" | "profitSharePct", v: string) =>
    setMembers((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: v } : m)));
  const addMember = () => setMembers((prev) => [...prev, { name: "", amount: "", profitSharePct: "" }]);
  const removeMember = (i: number) => setMembers((prev) => prev.filter((_, idx) => idx !== i));

  const switchBook = async (id: string) => {
    if (id === activeBook) return;
    await api.setActiveBook(id);
    setActiveBookState(id);
    const targetBook = books.find((b) => b.id === id);
    const s = await api.getSettings();
    const bookTheme = s.themeMode || (id === "default" ? "light" : id.charCodeAt(id.length - 1) % 2 === 0 ? "amoled_blue" : "navy_gold");
    setMode(bookTheme as any);
    await api.updateSettings({ themeMode: bookTheme });
    setStatus({ ok: true, msg: `Switched to "${targetBook?.name || "Account"}". Records & theme updated.` });
    await load();
  };
  const addBook = async () => {
    if (!newBookName.trim()) return;
    setAddingBook(true);
    try {
      const meta = await api.createBook(newBookName.trim());
      setNewBookName("");
      const bks = await api.listBooks();
      setBooks(bks);
      const defaultNewTheme = bks.length % 3 === 0 ? "navy_gold" : bks.length % 2 === 0 ? "amoled_blue" : "dark";
      await api.setActiveBook(meta.id);
      setActiveBookState(meta.id);
      setMode(defaultNewTheme as any);
      await api.updateSettings({ themeMode: defaultNewTheme, businessName: meta.name });
      
      try {
        const v2 = await api.getV2BookConfig();
        if (v2) {
          await api.updateV2BookConfig({
            ...v2,
            selectedPersonas: [newBookPersona],
            activePersona: newBookPersona,
          });
        }
      } catch {}

      setStatus({ ok: true, msg: `Created & switched to new account "${meta.name}".` });
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Could not create account" });
    } finally { setAddingBook(false); }
  };
  const removeBook = async (id: string) => {
    const ok = await requireAuth("Confirm to delete this account");
    if (!ok) return;
    try {
      await api.deleteBook(id);
      const bks = await api.listBooks();
      setBooks(bks);
      setActiveBookState(api.activeBookId());
      setStatus({ ok: true, msg: "Account deleted." });
      await load();
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Could not delete account" });
    }
  };

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: theme.spacing.lg, paddingTop: 16 }}>
        <Pressable onPress={() => router.back()} style={{ marginRight: 12 }}>
          <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <ScreenHeader title="Advanced" subtitle="System & Workflows" />
        </View>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            
            <View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>System & Workflows</Text>
              
              <AccordionRow title="Business Accounts (Books)" subtitle="Main Account (Active)" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Switch active business account. Each account has its own isolated ledger, business profile, workflows, and theme.</Text>
                  <View style={{ gap: 8, marginTop: theme.spacing.sm }}>
                    {books.map((b) => {
                      const isActive = b.id === activeBook;
                      return (
                        <Pressable key={b.id} onPress={() => switchBook(b.id)} style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface }, isActive && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "15" }]}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                            <Ionicons name={isActive ? "business" : "business-outline"} size={20} color={isActive ? theme.color.brandPrimary : theme.color.muted} />
                            <Text style={[{ fontSize: 14, fontWeight: "700", color: theme.color.onSurface }, isActive && { color: theme.color.brandPrimary }]}>{b.name}</Text>
                          </View>
                          {isActive ? (
                            <View style={{ backgroundColor: theme.color.brandPrimary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}><Text style={{ fontSize: 11, fontWeight: "700", color: theme.color.onBrandPrimary }}>Active</Text></View>
                          ) : (
                            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.color.brandPrimary }}>Switch</Text>
                          )}
                          {b.id !== "default" && !isActive && (
                            <Pressable onPress={() => removeBook(b.id)} style={{ marginLeft: 12 }}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={{ marginTop: theme.spacing.lg, paddingTop: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.color.border }}>
                    <Text style={[styles.label, { fontSize: 13, marginBottom: theme.spacing.xs }]}>+ Create New Business Account</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
                      {PERSONAS.map(p => (
                        <Pressable key={`new-${p.id}`} onPress={() => setNewBookPersona(p.id)} style={[{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceTertiary }, newBookPersona === p.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                          <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, newBookPersona === p.id && { color: theme.color.brandPrimary }]}>{p.label}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                    <View style={styles.entryRow}>
                      <TextInput value={newBookName} onChangeText={setNewBookName} placeholder="New account name" placeholderTextColor={theme.color.muted} style={[styles.input, styles.entryInput]} />
                      <Pressable onPress={addBook} disabled={addingBook || !newBookName.trim()} style={styles.addBtn}>
                        {addingBook ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.addText}>Add</Text></>}
                      </Pressable>
                    </View>
                  </View>
                </View>
              </AccordionRow>
              <AccordionRow title="Accounting & Workflow" subtitle={accountingStyle === 'retail_partnership' ? "Basis, Style, Investors" : "Basis, Style"} isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.label}>Accounting Basis</Text>
                  <View style={styles.modeRow}>
                    {(["cash", "accrual"] as const).map((b) => (
                      <Pressable key={b} onPress={() => setAccountingBasis(b)} style={[styles.modeBtn, accountingBasis === b && styles.modeBtnActive]}>
                        <Text style={[styles.modeText, accountingBasis === b && styles.modeTextActive]}>{b === "cash" ? "Cash Basis" : "Accrual Basis"}</Text>
                      </Pressable>
                    ))}
                  </View>

                  <Text style={[styles.label, { marginTop: theme.spacing.lg }]}>Accounting Style</Text>
                  <View style={{ gap: 10, marginTop: theme.spacing.sm }}>
                    <Pressable onPress={() => updateAccountingStyle('retail_partnership')} style={[styles.bookRow, accountingStyle === 'retail_partnership' && styles.bookRowActive]}>
                      <Ionicons name={accountingStyle === 'retail_partnership' ? 'radio-button-on' : 'radio-button-off'} size={20} color={accountingStyle === 'retail_partnership' ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}><Text style={styles.bookName}>Equity Split</Text></View>
                    </Pressable>
                    <Pressable onPress={() => updateAccountingStyle('standard')} style={[styles.bookRow, accountingStyle === 'standard' && styles.bookRowActive]}>
                      <Ionicons name={accountingStyle === 'standard' ? 'radio-button-on' : 'radio-button-off'} size={20} color={accountingStyle === 'standard' ? theme.color.brandPrimary : theme.color.muted} />
                      <View style={{ flex: 1 }}><Text style={styles.bookName}>Standard Entity</Text></View>
                    </Pressable>
                  </View>

                  {accountingStyle === 'retail_partnership' ? (
                    <>
                      <Text style={[styles.label, { marginTop: theme.spacing.lg }]}>Investors</Text>
                      {members.map((m, i) => (
                        <View key={`member-${i}`} style={styles.memberCard}>
                          <View style={styles.entryRow}>
                            <TextInput value={m.name} onChangeText={(v) => updateMember(i, "name", v)} placeholder="Name" placeholderTextColor={theme.color.muted} autoCapitalize="words" style={[styles.input, styles.entryInput]} />
                            <Pressable onPress={() => removeMember(i)} style={styles.removeBtn}><Ionicons name="trash-outline" size={18} color={theme.color.error} /></Pressable>
                          </View>
                          <View style={[styles.entryRow, { marginTop: 8 }]}>
                            <View style={{ flex: 1 }}><Text style={styles.subLabel}>Investment (opt)</Text><TextInput value={m.amount} onChangeText={(v) => updateMember(i, "amount", v)} keyboardType="decimal-pad" placeholder="e.g. 5000" placeholderTextColor={theme.color.muted} style={styles.input} /></View>
                            <View style={{ flex: 1 }}><Text style={styles.subLabel}>Profit Share %</Text><TextInput value={m.profitSharePct} onChangeText={(v) => updateMember(i, "profitSharePct", v)} keyboardType="decimal-pad" placeholder="e.g. 50" placeholderTextColor={theme.color.muted} style={styles.input} /></View>
                          </View>
                        </View>
                      ))}
                      <Pressable onPress={addMember} style={styles.addBtn}><Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.addText}>Add Member</Text></Pressable>
                    </>
                  ) : null}
                </View>
              </AccordionRow>
            </View>

            <View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>AI & Integrations</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Configure your AI provider and secure API access.</Text>
              <AccordionRow title="AI Provider" subtitle="Multiple providers" isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.xs }}>
                    <Pressable onPress={() => { setProvider("gemini"); setModelName("gemini-2.0-flash-001"); setBaseUrl(""); setTestResult(null); }} style={[{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, provider === "gemini" && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}><Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, provider === "gemini" && { color: theme.color.brandPrimary }]}>Google Gemini</Text></Pressable>
                    <Pressable onPress={() => { if (provider === "gemini") { setProvider("custom"); setTestResult(null); } }} style={[{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, provider !== "gemini" && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}><Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, provider !== "gemini" && { color: theme.color.brandPrimary }]}>Custom Provider</Text></Pressable>
                  </View>
                  {provider !== "gemini" && (
                    <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                      <Pressable onPress={() => { setProvider("custom"); setTestResult(null); }} style={[{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, (provider === "custom" || provider === "openrouter") && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}><Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, (provider === "custom" || provider === "openrouter") && { color: theme.color.brandPrimary }]}>OpenAI Compatible</Text></Pressable>
                      <Pressable onPress={() => { setProvider("custom_anthropic"); setTestResult(null); }} style={[{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, (provider === "custom_anthropic" || provider === "anthropic") && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}><Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, (provider === "custom_anthropic" || provider === "anthropic") && { color: theme.color.brandPrimary }]}>Anthropic Compatible</Text></Pressable>
                    </View>
                  )}
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>API Key</Text>
                  <TextInput value={key} onChangeText={(v) => { setKey(v); setTestResult(null); }} placeholder="Paste your API key" placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input} />
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Model</Text>
                  <TextInput value={modelName} onChangeText={setModelName} placeholder="model name" placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                  {provider !== "gemini" && (
                    <>
                      <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Base URL</Text>
                      <TextInput value={baseUrl} onChangeText={setBaseUrl} placeholder="https://..." placeholderTextColor={theme.color.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                    </>
                  )}
                  <View style={{ flexDirection: "row", alignItems: "center", marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
                    <Pressable onPress={testKey} disabled={testing || !key} style={({ pressed }) => [styles.secondaryBtn, { alignSelf: 'flex-start', paddingHorizontal: 16 }, (pressed || testing) && { opacity: 0.7 }]}>{testing ? <ActivityIndicator color={theme.color.brandPrimary} /> : <Text style={styles.secondaryText}>Test Connection</Text>}</Pressable>
                    {testResult && <Text style={{ fontSize: 13, fontWeight: "600", color: testResult.ok ? theme.color.brandPrimary : theme.color.error, flexShrink: 1 }}>{testResult.msg}</Text>}
                  </View>
                </View>
              </AccordionRow>
            </View>

            <View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Security & Data</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Protect your sensitive actions and backups.</Text>
              <AccordionRow title="App Lock" subtitle="Fingerprint / PIN" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Use your phone’s fingerprint / face / PIN to protect sensitive actions.</Text>
                  <Pressable onPress={() => setLockEnabled((v) => !v)} style={[styles.lockToggle, lockEnabled && styles.lockToggleOn]}>
                    <Ionicons name={lockEnabled ? "lock-closed" : "lock-open-outline"} size={18} color={lockEnabled ? theme.color.onBrandPrimary : theme.color.onSurface} />
                    <Text style={[styles.lockToggleText, lockEnabled && { color: theme.color.onBrandPrimary }]}>{lockEnabled ? "App Lock ON" : "App Lock OFF"}</Text>
                  </Pressable>
                </View>
              </AccordionRow>
              <AccordionRow title="Backup & Restore" subtitle="Export data to JSON" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <View style={styles.backupRow}>
                    <Pressable onPress={doExport} disabled={busy !== null} style={({ pressed }) => [styles.backupBtn, styles.backupBtnPrimary, (pressed || busy === "export") && { opacity: 0.85 }]}>
                      {busy === "export" ? <ActivityIndicator color="#fff" /> : <><Ionicons name="share-outline" size={18} color="#fff" /><Text style={styles.backupBtnTextPrimary}>Export</Text></>}
                    </Pressable>
                    <Pressable onPress={doImport} disabled={busy !== null} style={({ pressed }) => [styles.backupBtn, styles.backupBtnSecondary, (pressed || busy === "import") && { opacity: 0.85 }]}>
                      {busy === "import" ? <ActivityIndicator color={theme.color.brandPrimary} /> : <><Ionicons name="cloud-upload-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.backupBtnTextSecondary}>Import</Text></>}
                    </Pressable>
                  </View>
                </View>
              </AccordionRow>
              <AccordionRow title="Danger Zone"
                subtitle="Clear accounting data or reset this device" isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
                  <Text style={styles.hint}>Clear accounting data removes books, transactions, parties, inventory and periods while preserving preferences and AI configuration. Factory reset also removes business settings and AI credentials.</Text>
                  {!confirmReset ? (
                    <Pressable onPress={() => setConfirmReset(true)} style={styles.resetInitBtn}><Ionicons name="trash-outline" size={16} color={theme.color.error} /><Text style={styles.resetInitText}>Clear Accounting Data…</Text></Pressable>
                  ) : (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={[styles.hint, { color: theme.color.error, fontWeight: "600" }]}>This cannot be undone. Consider exporting a backup first.</Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                        <Pressable onPress={() => setConfirmReset(false)} style={styles.resetCancelBtn}><Text style={styles.resetCancelText}>Cancel</Text></Pressable>
                        <Pressable onPress={doReset} disabled={resetting} style={styles.resetConfirmBtn}>{resetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.resetConfirmText}>Yes, clear accounting data</Text>}</Pressable>
                      </View>
                    </View>
                  )}
                  {!confirmFactoryReset ? (
                    <Pressable onPress={() => setConfirmFactoryReset(true)} style={[styles.resetInitBtn, { borderColor: theme.color.error + "99" }]}><Ionicons name="warning-outline" size={16} color={theme.color.error} /><Text style={styles.resetInitText}>Factory Reset Device…</Text></Pressable>
                  ) : (
                    <View style={{ marginTop: theme.spacing.md }}>
                      <Text style={[styles.hint, { color: theme.color.error, fontWeight: "600" }]}>This wipes everything — all books & records, business configuration, the saved AI key, and your preferences (theme, animations, dashboard layout) — then returns to onboarding.</Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                        <Pressable onPress={() => setConfirmFactoryReset(false)} style={styles.resetCancelBtn}><Text style={styles.resetCancelText}>Cancel</Text></Pressable>
                        <Pressable onPress={doFactoryReset} disabled={resetting} style={styles.resetConfirmBtn}>{resetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.resetConfirmText}>Yes, factory reset</Text>}</Pressable>
                      </View>
                    </View>
                  )}
                </View>
              </AccordionRow>
            </View>

            {status && (
              <View style={[styles.status, { backgroundColor: status.ok ? theme.color.successBg : theme.color.errorBg }]}>
                <Ionicons name={status.ok ? "checkmark-circle" : "alert-circle"} size={18} color={status.ok ? theme.color.success : theme.color.error} />
                <Text style={[styles.statusText, { color: status.ok ? theme.color.success : theme.color.error }]}>{status.msg}</Text>
              </View>
            )}

            <Pressable testID="btn-save-settings" onPress={save} disabled={saving} style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]}>
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save Settings</Text>}
            </Pressable>
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
    scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: 60 },
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
