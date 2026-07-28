import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { Image } from "react-native";
import { useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { api, getAIConfig, setAIConfig } from "@/src/api";
import { PROVIDERS, type ProviderId } from "@/src/db/ai";
import { CURRENCIES, TAX_LABELS, type TaxLabel } from "@/src/db/local";
import { ScreenHeader, Card } from "@/src/components/UI";
import { shareJsonFile, pickJsonFile } from "@/src/utils/share";
import { requireAuth } from "@/src/utils/lock";
import { PERSONAS, type PersonaId } from "@/src/accountingV2/config";

export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [key, setKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [commissionPct, setCommissionPct] = useState("");
  const [openingCapital, setOpeningCapital] = useState("");
  const [openingCash, setOpeningCash] = useState("");
  const [openingInventory, setOpeningInventory] = useState("");
  const [periodStart, setPeriodStart] = useState("");
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
  const [showWorkflowEdit, setShowWorkflowEdit] = useState(false);
  const [showAccountingEdit, setShowAccountingEdit] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [currencyDropdownOpen, setCurrencyDropdownOpen] = useState(false);
  const [taxLabel, setTaxLabel] = useState<TaxLabel>("None");
  const [taxLabelCustom, setTaxLabelCustom] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [invoiceTheme, setInvoiceTheme] = useState("navy_gold");
  const [bizProfile, setBizProfile] = useState({ businessName: "", businessAddress: "", businessPhone: "", businessEmail: "", taxRegNo: "", bankAccount: "", upiId: "", paymentDetails: "", invoiceTerms: "" });
  const [logo, setLogo] = useState<string>("");
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
          retailPartnership: v2.retailPartnership,
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
      setCommissionPct(s.managerCommissionPct ? String(s.managerCommissionPct) : "");
      setAccountingBasis(s.accountingBasis === "accrual" ? "accrual" : "cash");
      setAccountingStyle(s.accountingStyle === "retail_partnership" ? "retail_partnership" : "standard");
      const configuredPersonas: PersonaId[] = Array.isArray(s.selectedPersonas) && s.selectedPersonas.length ? s.selectedPersonas as PersonaId[] : ["custom"];
      setSelectedPersonas(configuredPersonas);
      setActivePersona((s.activePersona as PersonaId) || configuredPersonas[0]);
      setOpeningCapital(s.openingCapital ? String(s.openingCapital) : "");
      setOpeningCash(s.openingCash ? String(s.openingCash) : "");
      setOpeningInventory(s.openingInventory ? String(s.openingInventory) : "");
      setPeriodStart(s.currentPeriodStart && s.currentPeriodStart !== "1970-01-01" ? s.currentPeriodStart : "");
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
          setCommissionPct(v2.retailPartnership.commissionPct ? String(v2.retailPartnership.commissionPct) : "");
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
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
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
          style: selectedPersonas.includes("retail") ? "retail_partnership" : "standard",
          selectedPersonas,
          activePersona,
          retailPartnership: {
            enabled: selectedPersonas.includes("retail"),
            commissionPct: commissionPct.trim() ? parseFloat(commissionPct) : 0,
            inventoryCadence: "irregular",
            members: members.map((m) => ({ name: m.name.trim(), openingContribution: m.amount.trim() ? parseFloat(m.amount) : 0, profitSharePct: m.profitSharePct.trim() ? parseFloat(m.profitSharePct) : 0 })).filter((m) => m.name),
          },
        });
      } catch (e: any) {
        if (!/V2 accounting requires SQLite|No active versioned V2 book/i.test(e?.message || "")) throw e;
      }
      await api.updateSettings({
        googleApiKey: key.trim(),
        managerCommissionPct: commissionPct.trim() ? parseFloat(commissionPct) : 0,
        accountingBasis,
        selectedPersonas,
        activePersona,
        accountingStyle: selectedPersonas.includes("retail") ? "retail_partnership" : "standard",
        openingCapital: openingCapital.trim() ? parseFloat(openingCapital) : 0,
        openingCash: openingCash.trim() ? parseFloat(openingCash) : 0,
        openingInventory: openingInventory.trim() ? parseFloat(openingInventory) : 0,
        currentPeriodStart: periodStart.trim() || "1970-01-01",
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
        currency,
        taxLabel,
        taxLabelCustom: taxLabelCustom.trim(),
        taxRate: taxRate.trim() ? parseFloat(taxRate) : 0,
        invoiceTheme,
        themeMode: mode,
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

  const pickLogo = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setStatus({ ok: false, msg: "Gallery permission denied" }); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.4, mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1] });
    if (res.canceled || !res.assets[0].base64) return;
    setLogo(`data:${res.assets[0].mimeType || "image/jpeg"};base64,${res.assets[0].base64}`);
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
      const data = await api.exportBackup();
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
      const data = await pickJsonFile();
      if (!data) { setBusy(null); return; }
      if (!data._meta || data._meta.app !== "ledgr") {
        setStatus({ ok: false, msg: "Not a Ledgr backup file." });
        setBusy(null); return;
      }
      await api.importBackup({ ...data, mode: "replace" });
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
      await api.resetAll();
      setStatus({ ok: true, msg: "All accounting data reset. Gemini key preserved." });
      setConfirmReset(false);
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Reset failed" });
    } finally { setResetting(false); }
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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Settings" subtitle="Configure AI & backup" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Card>
              <Text style={styles.label}>Business Accounts & Multi-Tenant Books</Text>
              <Text style={styles.hint}>Switch active business account. Each account has its own isolated ledger, business profile, workflows, and theme.</Text>

              {/* Active Account Switcher Cards */}
              <View style={{ gap: 8, marginTop: theme.spacing.sm }}>
                {books.map((b) => {
                  const isActive = b.id === activeBook;
                  return (
                    <Pressable
                      key={b.id}
                      onPress={() => switchBook(b.id)}
                      style={[{
                        flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                        padding: 12, borderRadius: theme.radius.md,
                        borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                      }, isActive && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "15" }]}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                        <Ionicons
                          name={isActive ? "business" : "business-outline"}
                          size={20}
                          color={isActive ? theme.color.brandPrimary : theme.color.muted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={[{ fontSize: 14, fontWeight: "700", color: theme.color.onSurface }, isActive && { color: theme.color.brandPrimary }]}>
                            {b.name}
                          </Text>
                        </View>
                      </View>
                      {isActive ? (
                        <View style={{ backgroundColor: theme.color.brandPrimary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 }}>
                          <Text style={{ fontSize: 11, fontWeight: "700", color: theme.color.onBrandPrimary }}>Active Account</Text>
                        </View>
                      ) : (
                        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.color.brandPrimary }}>Switch</Text>
                      )}
                      {b.id !== "default" && !isActive && (
                        <Pressable onPress={() => removeBook(b.id)} style={{ marginLeft: 12 }} testID={`btn-remove-book-${b.id}`}>
                          <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ marginTop: theme.spacing.md, paddingTop: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.color.border }}>
                <Text style={[styles.label, { fontSize: 13, marginBottom: theme.spacing.xs }]}>+ Create New Business Account</Text>
                <Text style={[styles.hint, { marginBottom: theme.spacing.xs }]}>Step 1: Select primary workflow type</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
                  {PERSONAS.map(p => (
                    <Pressable
                      key={`new-${p.id}`}
                      onPress={() => setNewBookPersona(p.id)}
                      style={[{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary }, newBookPersona === p.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                    >
                      <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, newBookPersona === p.id && { color: theme.color.brandPrimary }]}>{p.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Text style={[styles.hint, { marginBottom: theme.spacing.xs, marginTop: 4 }]}>Step 2: Enter business name</Text>
                <View style={styles.entryRow}>
                  <TextInput
                    testID="input-new-book"
                    value={newBookName}
                    onChangeText={setNewBookName}
                    placeholder="New account name (e.g. Technician)"
                    placeholderTextColor={theme.color.muted}
                    style={[styles.input, styles.entryInput]}
                  />
                  <Pressable testID="btn-add-book" onPress={addBook} disabled={addingBook || !newBookName.trim()} style={styles.addBtn}>
                    {addingBook ? <ActivityIndicator color={theme.color.brandPrimary} /> : (
                      <>
                        <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                        <Text style={styles.addText}>Add</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: theme.spacing.xs }}>
                <Ionicons name="business" size={18} color={theme.color.brandPrimary} />
                <Text style={[styles.label, { marginBottom: 0 }]}>Active Business Profile: {books.find(b => b.id === activeBook)?.name || "Main Account"}</Text>
              </View>
              <Text style={styles.hint}>Configure workflows, accounting styles, and aesthetics specifically for this business account.</Text>

              {/* Workflows for Active Account */}
              <View style={{ marginTop: theme.spacing.md, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View>
                  <Text style={[styles.label, { fontSize: 13, marginBottom: 0 }]}>Primary Workflow & Model</Text>
                  <Text style={[styles.hint, { marginTop: 2 }]}>{PERSONAS.find(p => p.id === activePersona)?.label || "Custom Business"}</Text>
                </View>
                <Pressable onPress={() => setShowWorkflowEdit(!showWorkflowEdit)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }}>
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }}>{showWorkflowEdit ? "Close" : "Change"}</Text>
                </Pressable>
              </View>

              {showWorkflowEdit && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.sm, padding: 12, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border }}>
                  {PERSONAS.map((p) => {
                    const chosen = selectedPersonas.includes(p.id);
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => {
                          setSelectedPersonas([p.id]);
                          setActivePersona(p.id);
                        }}
                        style={[{
                          flexDirection: "row", alignItems: "center", gap: 6,
                          paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20,
                          borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface
                        }, chosen && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                      >
                        <Ionicons name={chosen ? "checkmark-circle" : "ellipse-outline"} size={16} color={chosen ? theme.color.brandPrimary : theme.color.muted} />
                        <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, chosen && { color: theme.color.brandPrimary }]}>
                          {p.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {/* Accounting Style for Active Account */}
              <View style={{ marginTop: theme.spacing.lg, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View>
                  <Text style={[styles.label, { fontSize: 13, marginBottom: 0 }]}>Accounting Style</Text>
                  <Text style={[styles.hint, { marginTop: 2 }]}>{accountingStyle === 'retail_partnership' ? 'Partner Equity & Profit-Split' : 'Standard Entity & Single-Owner'}</Text>
                </View>
                <Pressable onPress={() => setShowAccountingEdit(!showAccountingEdit)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.border }}>
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }}>{showAccountingEdit ? "Close" : "Change"}</Text>
                </Pressable>
              </View>

              {showAccountingEdit && (
                <View style={{ gap: 10, marginTop: theme.spacing.sm, padding: 12, backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border }}>
                  <Pressable
                    onPress={() => updateAccountingStyle('retail_partnership')}
                    style={[styles.bookRow, accountingStyle === 'retail_partnership' && styles.bookRowActive, { backgroundColor: theme.color.surface }]}
                  >
                    <Ionicons
                      name={accountingStyle === 'retail_partnership' ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={accountingStyle === 'retail_partnership' ? theme.color.brandPrimary : theme.color.muted}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.bookName}>Partner Equity & Profit-Split Accounting</Text>
                      <Text style={styles.hint}>
                        50/50 Partner Capital Accounts, periodic physical stock audit, shopkeeper salary & commission % on gross profit.
                      </Text>
                    </View>
                  </Pressable>

                  <Pressable
                    onPress={() => updateAccountingStyle('standard')}
                    style={[styles.bookRow, accountingStyle === 'standard' && styles.bookRowActive, { backgroundColor: theme.color.surface }]}
                  >
                    <Ionicons
                      name={accountingStyle === 'standard' ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={accountingStyle === 'standard' ? theme.color.brandPrimary : theme.color.muted}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.bookName}>Standard Entity & Single-Owner Accounting</Text>
                      <Text style={styles.hint}>
                        Standard P&L, Balance Sheet, Trial Balance, Accounts Receivable & Payable for general small businesses.
                      </Text>
                    </View>
                  </Pressable>
                </View>
              )}
            </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>AI Provider</Text>
                <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.xs }}>
                  <Pressable
                    onPress={() => { setProvider("gemini"); setModelName("gemini-2.0-flash-001"); setBaseUrl(""); setTestResult(null); }}
                    style={[{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, provider === "gemini" && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                  >
                    <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, provider === "gemini" && { color: theme.color.brandPrimary }]}>
                      Google Gemini
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      if (provider === "gemini") { setProvider("custom"); setTestResult(null); }
                    }}
                    style={[{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, provider !== "gemini" && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                  >
                    <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, provider !== "gemini" && { color: theme.color.brandPrimary }]}>
                      Custom Provider
                    </Text>
                  </Pressable>
                </View>

                {provider !== "gemini" && (
                  <>
                    <Text style={[styles.label, { marginTop: theme.spacing.md, fontSize: 13 }]}>Protocol / API Format</Text>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.xs }}>
                      <Pressable
                        onPress={() => { setProvider("custom"); setTestResult(null); }}
                        style={[{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, (provider === "custom" || provider === "openrouter") && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                      >
                        <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, (provider === "custom" || provider === "openrouter") && { color: theme.color.brandPrimary }]}>
                          OpenAI Compatible
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => { setProvider("custom_anthropic"); setTestResult(null); }}
                        style={[{ flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, alignItems: "center" }, (provider === "custom_anthropic" || provider === "anthropic") && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                      >
                        <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, (provider === "custom_anthropic" || provider === "anthropic") && { color: theme.color.brandPrimary }]}>
                          Anthropic Compatible
                        </Text>
                      </Pressable>
                    </View>
                  </>
                )}

                <Text style={[styles.label, { marginTop: theme.spacing.md }]}>API Key</Text>
                <Text style={styles.hint}>{PROVIDERS.find((p) => p.id === provider)?.keyHint || "Paste your API key"}</Text>
                <TextInput
                  testID="input-api-key"
                  value={key}
                  onChangeText={(v) => { setKey(v); setTestResult(null); }}
                  placeholder="Paste your API key"
                  placeholderTextColor={theme.color.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  style={styles.input}
                />

                <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Model</Text>
                <TextInput
                  testID="input-api-model"
                  value={modelName}
                  onChangeText={setModelName}
                  placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel || "model name"}
                  placeholderTextColor={theme.color.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />

                {provider !== "gemini" && (
                  <>
                    <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Base URL</Text>
                    <Text style={styles.hint}>Custom API endpoint (e.g. https://my-server.com/v1)</Text>
                    <TextInput
                      testID="input-base-url"
                      value={baseUrl}
                      onChangeText={setBaseUrl}
                      placeholder="https://..."
                      placeholderTextColor={theme.color.muted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.input}
                    />
                  </>
                )}

                <View style={{ flexDirection: "row", alignItems: "center", marginTop: theme.spacing.md, gap: theme.spacing.sm }}>
                  <Pressable
                    testID="btn-test-key"
                    onPress={testKey}
                    disabled={testing || !key}
                    style={({ pressed }) => [styles.secondaryBtn, { flex: 0 }, (pressed || testing) && { opacity: 0.7 }]}
                  >
                    {testing
                      ? <ActivityIndicator color={theme.color.brandPrimary} />
                      : <Text style={styles.secondaryText}>Test Connection</Text>}
                  </Pressable>
                  {testResult && (
                    <Text style={{ fontSize: 13, fontWeight: "600", color: testResult.ok ? theme.color.brandPrimary : theme.color.error, flexShrink: 1 }}>
                      {testResult.msg}
                    </Text>
                  )}
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Backup & Restore</Text>
                <Text style={styles.hint}>Share your data as a JSON file via WhatsApp, then import it on any other device to sync.</Text>
                <View style={styles.backupRow}>
                  <Pressable
                    testID="btn-export"
                    onPress={doExport}
                    disabled={busy !== null}
                    style={({ pressed }) => [styles.backupBtn, styles.backupBtnPrimary, (pressed || busy === "export") && { opacity: 0.85 }]}
                  >
                    {busy === "export" ? <ActivityIndicator color="#fff" /> : (
                      <>
                        <Ionicons name="share-outline" size={18} color="#fff" />
                        <Text style={styles.backupBtnTextPrimary}>Export & Share</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    testID="btn-import"
                    onPress={doImport}
                    disabled={busy !== null}
                    style={({ pressed }) => [styles.backupBtn, styles.backupBtnSecondary, (pressed || busy === "import") && { opacity: 0.85 }]}
                  >
                    {busy === "import" ? <ActivityIndicator color={theme.color.brandPrimary} /> : (
                      <>
                        <Ionicons name="cloud-upload-outline" size={18} color={theme.color.brandPrimary} />
                        <Text style={styles.backupBtnTextSecondary}>Import File</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Appearance & Color Theme</Text>
                <Text style={styles.hint}>Choose your visual theme across all app tabs and generated PDFs.</Text>

                <Text style={[styles.label, { marginTop: theme.spacing.sm, fontSize: 13 }]}>App Interface Theme</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.xs }}>
                  {[
                    { id: "light", label: "Emerald Light", icon: "sunny-outline" },
                    { id: "dark", label: "Emerald Dark", icon: "moon-outline" },
                    { id: "navy_gold", label: "Black & Gold", icon: "color-palette-outline" },
                    { id: "amoled_blue", label: "AMOLED Blue", icon: "flash-outline" },
                    { id: "system", label: "System", icon: "phone-portrait-outline" },
                  ].map((m) => (
                    <Pressable
                      key={m.id}
                      testID={`mode-${m.id}`}
                      onPress={async () => {
                        setMode(m.id as any);
                        await api.updateSettings({ themeMode: m.id });
                      }}
                      style={[{
                        flexDirection: "row", alignItems: "center", gap: 6,
                        paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20,
                        borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                      }, mode === m.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                    >
                      <Ionicons
                        name={m.icon as any}
                        size={16}
                        color={mode === m.id ? theme.color.brandPrimary : theme.color.onSurface}
                      />
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, mode === m.id && { color: theme.color.brandPrimary }]}>
                        {m.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={[styles.label, { marginTop: theme.spacing.md, fontSize: 13 }]}>Invoice PDF Preset</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.xs }}>
                  {[
                    { id: "navy_gold", label: "Black & Gold" },
                    { id: "amoled_blue", label: "Black & Blue" },
                    { id: "emerald", label: "Classic Emerald" },
                    { id: "minimal", label: "Clean Minimal" },
                  ].map((t) => (
                    <Pressable
                      key={t.id}
                      onPress={async () => {
                        setInvoiceTheme(t.id);
                        await api.updateSettings({ invoiceTheme: t.id });
                      }}
                      style={[{
                        paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20,
                        borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                      }, invoiceTheme === t.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                    >
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, invoiceTheme === t.id && { color: theme.color.brandPrimary }]}>
                        {t.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Accounting Basis</Text>
                <Text style={styles.hint}>Cash = revenue counts when money is received (cash sales + receipts). Accrual = revenue counts when billed (cash sales + invoices raised).</Text>
                <View style={styles.modeRow}>
                  {(["cash", "accrual"] as const).map((b) => (
                    <Pressable
                      key={b}
                      testID={`basis-${b}`}
                      onPress={() => setAccountingBasis(b)}
                      style={[styles.modeBtn, accountingBasis === b && styles.modeBtnActive]}
                    >
                      <Text style={[styles.modeText, accountingBasis === b && styles.modeTextActive]}>
                        {b === "cash" ? "Cash Basis" : "Accrual Basis"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Manager Commission %</Text>
                <Text style={styles.hint}>% of Gross Profit paid to the shop manager. Leave blank if none.</Text>
                <TextInput
                  testID="input-commission-pct"
                  value={commissionPct}
                  onChangeText={setCommissionPct}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  placeholder="e.g. 10"
                  placeholderTextColor={theme.color.muted}
                />
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Members</Text>
                <Text style={styles.hint}>
                  The owners/investors in this business. Add each person's name and (optionally) their
                  investment and profit-share %. Leave investment/share blank to keep it simple — if no
                  shares are set, profit is split equally. Drawings are matched to these names.
                </Text>
                {members.map((m, i) => (
                  <View key={`member-${i}`} style={styles.memberCard}>
                    <View style={styles.entryRow}>
                      <TextInput
                        testID={`input-member-name-${i}`}
                        value={m.name}
                        onChangeText={(v) => updateMember(i, "name", v)}
                        placeholder="Name"
                        placeholderTextColor={theme.color.muted}
                        autoCapitalize="words"
                        style={[styles.input, styles.entryInput]}
                      />
                      <Pressable
                        testID={`btn-remove-member-${i}`}
                        onPress={() => removeMember(i)}
                        style={styles.removeBtn}
                      >
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                      </Pressable>
                    </View>
                    <View style={[styles.entryRow, { marginTop: 8 }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>Investment (optional)</Text>
                        <TextInput
                          testID={`input-member-amount-${i}`}
                          value={m.amount}
                          onChangeText={(v) => updateMember(i, "amount", v)}
                          keyboardType="decimal-pad"
                          placeholder="e.g. 5000"
                          placeholderTextColor={theme.color.muted}
                          style={styles.input}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.subLabel}>Profit Share % (optional)</Text>
                        <TextInput
                          testID={`input-member-share-${i}`}
                          value={m.profitSharePct}
                          onChangeText={(v) => updateMember(i, "profitSharePct", v)}
                          keyboardType="decimal-pad"
                          placeholder="e.g. 50"
                          placeholderTextColor={theme.color.muted}
                          style={styles.input}
                        />
                      </View>
                    </View>
                  </View>
                ))}
                <Pressable testID="btn-add-member" onPress={addMember} style={styles.addBtn}>
                  <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                  <Text style={styles.addText}>Add Member</Text>
                </Pressable>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Opening Balances</Text>
                <Text style={styles.hint}>Cash-in-hand and stock value at the start of your books. Used as the base for Cash and Inventory.</Text>
                <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Opening Cash</Text>
                <TextInput
                  testID="input-opening-cash"
                  value={openingCash}
                  onChangeText={setOpeningCash}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  placeholder="e.g. 2000 (cash at home / till)"
                  placeholderTextColor={theme.color.muted}
                />
                <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Opening Inventory Value</Text>
                <TextInput
                  testID="input-opening-inventory"
                  value={openingInventory}
                  onChangeText={setOpeningInventory}
                  keyboardType="decimal-pad"
                  style={styles.input}
                  placeholder="e.g. 15000 (stock on hand)"
                  placeholderTextColor={theme.color.muted}
                />
                <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Current Period Start (YYYY-MM-DD)</Text>
                <Text style={styles.hint}>Reports and the dashboard count entries on/after this date. Leave blank to show ALL entries (recommended if figures look missing).</Text>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  <TextInput
                    testID="input-period-start"
                    value={periodStart}
                    onChangeText={setPeriodStart}
                    autoCapitalize="none"
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Blank = all data"
                    placeholderTextColor={theme.color.muted}
                  />
                  <Pressable testID="btn-clear-period" onPress={() => setPeriodStart("")} style={styles.addBtn}>
                    <Ionicons name="refresh-outline" size={18} color={theme.color.brandPrimary} />
                    <Text style={styles.addText}>Show All</Text>
                  </Pressable>
                </View>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Security — App Lock</Text>
                <Text style={styles.hint}>
                  Use your phone's fingerprint / face / PIN to protect sensitive actions
                  (delete, reset, edit). There's no separate password to remember. If your
                  phone has no lock set up, this has no effect.
                </Text>
                <Pressable
                  testID="btn-toggle-lock"
                  onPress={() => setLockEnabled((v) => !v)}
                  style={[styles.lockToggle, lockEnabled && styles.lockToggleOn]}
                >
                  <Ionicons
                    name={lockEnabled ? "lock-closed" : "lock-open-outline"}
                    size={18}
                    color={lockEnabled ? theme.color.onBrandPrimary : theme.color.onSurface}
                  />
                  <Text style={[styles.lockToggleText, lockEnabled && { color: theme.color.onBrandPrimary }]}>
                    {lockEnabled ? "App Lock ON" : "App Lock OFF"}
                  </Text>
                </Pressable>
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Business Profile</Text>
                <Text style={styles.hint}>Appears on invoices and reports.</Text>

                {/* Sub-menu Tabs */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.sm }}>
                  {[
                    { id: "basic", label: "Basic Info", icon: "business-outline" },
                    { id: "contact", label: "Contact & Tax", icon: "call-outline" },
                    { id: "banking", label: "Payment Info", icon: "card-outline" },
                    { id: "terms", label: "Invoice Terms", icon: "document-text-outline" },
                    { id: "all", label: "Show All", icon: "list-outline" },
                  ].map((tab) => (
                    <Pressable
                      key={tab.id}
                      onPress={() => setBizSection(tab.id as any)}
                      style={[{
                        flexDirection: "row", alignItems: "center", gap: 6,
                        paddingVertical: 6, paddingHorizontal: 10, borderRadius: 16,
                        borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                      }, bizSection === tab.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}
                    >
                      <Ionicons name={tab.icon as any} size={14} color={bizSection === tab.id ? theme.color.brandPrimary : theme.color.muted} />
                      <Text style={[{ fontSize: 12, fontWeight: "600", color: theme.color.onSurface }, bizSection === tab.id && { color: theme.color.brandPrimary }]}>
                        {tab.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {/* Section 1: Basic Info & Logo */}
                {(bizSection === "basic" || bizSection === "all") && (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.label, { fontSize: 13 }]}>Company Logo</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 }}>
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
                      {logo ? (
                        <Pressable onPress={() => setLogo("")} style={styles.addBtn}>
                          <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                          <Text style={[styles.addText, { color: theme.color.error }]}>Remove</Text>
                        </Pressable>
                      ) : null}
                    </View>

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Business Name</Text>
                    <TextInput
                      value={bizProfile.businessName}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, businessName: v }))}
                      placeholder="e.g. Amit General Store"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Address</Text>
                    <TextInput
                      value={bizProfile.businessAddress}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, businessAddress: v }))}
                      placeholder="Street, City, State, ZIP"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />
                  </View>
                )}

                {/* Section 2: Contact & Tax Registration */}
                {(bizSection === "contact" || bizSection === "all") && (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Phone</Text>
                    <TextInput
                      value={bizProfile.businessPhone}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, businessPhone: v }))}
                      placeholder="+1 555 000 0000"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Email</Text>
                    <TextInput
                      value={bizProfile.businessEmail}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, businessEmail: v }))}
                      placeholder="you@example.com"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Tax Reg. No (TRN / GSTIN / VAT)</Text>
                    <TextInput
                      value={bizProfile.taxRegNo}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, taxRegNo: v }))}
                      placeholder="Shown on invoices"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />
                  </View>
                )}

                {/* Section 3: Payment Details */}
                {(bizSection === "banking" || bizSection === "all") && (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Bank Account / IBAN / Interac</Text>
                    <TextInput
                      value={bizProfile.bankAccount}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, bankAccount: v }))}
                      placeholder="Acct no, IBAN, or Interac email"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Payment ID / Link</Text>
                    <TextInput
                      value={bizProfile.upiId}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, upiId: v }))}
                      placeholder="Interac, UPI ID, PayPal or payment link"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />

                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Other Payment Details</Text>
                    <TextInput
                      value={bizProfile.paymentDetails}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, paymentDetails: v }))}
                      placeholder="Cheque payable to…, notes, alt. link"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />
                  </View>
                )}

                {/* Section 4: Invoice Terms */}
                {(bizSection === "terms" || bizSection === "all") && (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Invoice Terms & Conditions</Text>
                    <TextInput
                      value={bizProfile.invoiceTerms}
                      onChangeText={(v) => setBizProfile((p) => ({ ...p, invoiceTerms: v }))}
                      placeholder="Payment is due within X days..."
                      placeholderTextColor={theme.color.muted}
                      multiline
                      style={[styles.input, { minHeight: 60 }]}
                    />
                  </View>
                )}
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Currency</Text>
                <Text style={styles.hint}>Used across all reports and entries.</Text>
                <Pressable
                  onPress={() => setCurrencyDropdownOpen(!currencyDropdownOpen)}
                  style={{
                    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                    backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md,
                    padding: theme.spacing.md, marginTop: 8,
                    borderWidth: 1, borderColor: theme.color.border,
                  }}
                >
                  <Text style={{ color: theme.color.onSurface, fontWeight: "600", fontSize: 15 }}>
                    {CURRENCIES.find(c => c.code === currency)?.symbol || ""} {currency}
                  </Text>
                  <Ionicons name={currencyDropdownOpen ? "chevron-up" : "chevron-down"} size={18} color={theme.color.muted} />
                </Pressable>
                {currencyDropdownOpen && (
                  <View style={{
                    backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md,
                    borderWidth: 1, borderColor: theme.color.border, marginTop: 4, maxHeight: 220,
                  }}>
                    <ScrollView nestedScrollEnabled>
                      {CURRENCIES.map((c) => (
                        <Pressable
                          key={c.code}
                          onPress={() => { setCurrency(c.code); setCurrencyDropdownOpen(false); }}
                          style={{
                            flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14,
                            backgroundColor: currency === c.code ? theme.color.brandTertiary : "transparent",
                            borderBottomWidth: 1, borderBottomColor: theme.color.divider,
                          }}
                        >
                          <Text style={{ color: currency === c.code ? theme.color.brandPrimary : theme.color.onSurface, fontWeight: currency === c.code ? "700" : "500", fontSize: 14, flex: 1 }}>
                            {c.symbol} {c.code} — {c.name}
                          </Text>
                          {currency === c.code && <Ionicons name="checkmark" size={16} color={theme.color.brandPrimary} />}
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </Card>

              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.label}>Tax Settings</Text>
                <Text style={styles.hint}>Enter your tax name and rate (e.g. GST, VAT). Leave label empty to disable tax.</Text>

                <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Tax Label</Text>
                <TextInput
                  value={taxLabelCustom}
                  onChangeText={(v) => {
                    setTaxLabelCustom(v);
                    setTaxLabel(v.trim() ? "Custom" : "None");
                  }}
                  placeholder="e.g. GST, VAT (Leave blank for no tax)"
                  placeholderTextColor={theme.color.muted}
                  style={styles.input}
                />

                {taxLabelCustom.trim() !== "" && (
                  <>
                    <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>
                      {taxLabelCustom} Rate %
                    </Text>
                    <TextInput
                      value={taxRate}
                      onChangeText={setTaxRate}
                      keyboardType="decimal-pad"
                      placeholder="e.g. 18"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />
                  </>
                )}
              </Card>

              <Card style={{ marginTop: theme.spacing.md, borderColor: theme.color.error }}>
                <Text style={[styles.label, { color: theme.color.error }]}>Danger Zone — Reset All Data</Text>
                <Text style={styles.hint}>Wipes all suppliers, bills, sales, payments, inventory, and closed periods. Your Gemini API key is preserved.</Text>
                {!confirmReset ? (
                  <Pressable testID="btn-reset-init" onPress={() => setConfirmReset(true)} style={styles.resetInitBtn}>
                    <Ionicons name="trash-outline" size={16} color={theme.color.error} />
                    <Text style={styles.resetInitText}>Reset All Data…</Text>
                  </Pressable>
                ) : (
                  <View style={{ marginTop: theme.spacing.md }}>
                    <Text style={[styles.hint, { color: theme.color.error, fontWeight: "600" }]}>
                      This cannot be undone. Consider exporting a backup first.
                    </Text>
                    <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.sm }}>
                      <Pressable testID="btn-reset-cancel" onPress={() => setConfirmReset(false)} style={styles.resetCancelBtn}>
                        <Text style={styles.resetCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable testID="btn-reset-confirm" onPress={doReset} disabled={resetting} style={styles.resetConfirmBtn}>
                        {resetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.resetConfirmText}>Yes, delete everything</Text>}
                      </Pressable>
                    </View>
                  </View>
                )}
              </Card>

              {status && (
                <View style={[styles.status, { backgroundColor: status.ok ? theme.color.successBg : theme.color.errorBg }]}>
                  <Ionicons
                    name={status.ok ? "checkmark-circle" : "alert-circle"}
                    size={18}
                    color={status.ok ? theme.color.success : theme.color.error}
                  />
                  <Text style={[styles.statusText, { color: status.ok ? theme.color.success : theme.color.error }]}>{status.msg}</Text>
                </View>
              )}

              <Pressable
                testID="btn-save-settings"
                onPress={save}
                disabled={saving}
                style={({ pressed }) => [styles.primaryBtn, (pressed || saving) && { opacity: 0.85 }]}
              >
                {saving ? <ActivityIndicator color="#fff" /> :
                  <Text style={styles.primaryText}>Save Settings</Text>}
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
