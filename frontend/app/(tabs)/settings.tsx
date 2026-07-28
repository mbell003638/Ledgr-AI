import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

const SectionTitle = ({ title, theme }: any) => (
  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.muted, textTransform: "uppercase", letterSpacing: 1, marginLeft: 12, marginBottom: 8, marginTop: theme.spacing.xl }}>{title}</Text>
);

const AccordionRow = ({ title, subtitle, isLast, expandedKey, setExpandedKey, children, theme }: any) => {
  const isExpanded = expandedKey === title;
  return (
    <View style={{ borderBottomWidth: isLast && !isExpanded ? 0 : 1, borderBottomColor: theme.color.border, backgroundColor: isExpanded ? theme.color.brandPrimary + "0D" : "transparent" }}>
      <Pressable onPress={() => setExpandedKey(isExpanded ? null : title)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12 }}>
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }}>{title}</Text>
          {subtitle && <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>{subtitle}</Text>}
        </View>
        <Ionicons name={isExpanded ? "chevron-down" : "chevron-forward"} size={20} color={theme.color.muted} />
      </Pressable>
      {isExpanded && <View style={{ paddingVertical: 16, paddingTop: 4, backgroundColor: "transparent" }}>{children}</View>}
    </View>
  );
};

const SimpleRow = ({ title, subtitle, onPress, isLast, theme, rightElement }: any) => (
  <Pressable onPress={onPress} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: isLast ? 0 : 1, borderBottomColor: theme.color.border }}>
    <View style={{ flex: 1, paddingRight: 16 }}>
      <Text style={[{ fontSize: 15, fontWeight: "500", color: theme.color.onSurface }, rightElement?.titleStyle]}>{title}</Text>
      {subtitle && <Text style={[{ fontSize: 12, color: theme.color.muted, marginTop: 4 }, rightElement?.subtitleStyle]}>{subtitle}</Text>}
    </View>
    {rightElement?.custom || <Ionicons name="chevron-forward" size={20} color={rightElement?.chevronColor || theme.color.muted} />}
  </Pressable>
);

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

  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Settings" subtitle="Main Configuration" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            
            <View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Business Profile</Text>
              <Text style={{ fontSize: 13, color: theme.color.muted, marginBottom: 16, lineHeight: 18 }}>Manage your basic company info and defaults.</Text>
              <AccordionRow title="Company Info & Logo" subtitle="Name, Contact, Tax Reg No" theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View>
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
                      <Pressable key={c.code} onPress={() => setCurrency(c.code)} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14, borderRadius: theme.radius.md, borderWidth: 1, borderColor: currency === c.code ? theme.color.brandPrimary : theme.color.border, backgroundColor: currency === c.code ? theme.color.brandPrimary + "20" : theme.color.surfaceTertiary }}>
                        <Text style={{ color: currency === c.code ? theme.color.brandPrimary : theme.color.onSurface, fontWeight: "600", fontSize: 14 }}>{c.symbol} {c.code}</Text>
                      </Pressable>
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
            </View>

            <View style={{ backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, marginTop: theme.spacing.lg, padding: 20 }}>
              <Text style={{ fontSize: 16, fontWeight: "600", color: theme.color.brandPrimary, marginBottom: 8 }}>Preferences</Text>
              
              <AccordionRow title="App Theme" subtitle={mode === "amoled_blue" ? "AMOLED Blue" : "Navy & Gold"} theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[ { id: "light", label: "Emerald Light", icon: "sunny-outline" }, { id: "dark", label: "Emerald Dark", icon: "moon-outline" }, { id: "navy_gold", label: "Black & Gold", icon: "color-palette-outline" }, { id: "amoled_blue", label: "AMOLED Blue", icon: "flash-outline" }, { id: "system", label: "System", icon: "phone-portrait-outline" } ].map((m) => (
                    <Pressable key={m.id} onPress={async () => { setMode(m.id as any); await api.updateSettings({ themeMode: m.id }); }} style={[{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary }, mode === m.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                      <Ionicons name={m.icon as any} size={16} color={mode === m.id ? theme.color.brandPrimary : theme.color.onSurface} />
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, mode === m.id && { color: theme.color.brandPrimary }]}>{m.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </AccordionRow>
              <AccordionRow title="Invoice PDF Preset" subtitle="Black & Blue" isLast theme={theme} expandedKey={expandedKey} setExpandedKey={setExpandedKey}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {[ { id: "navy_gold", label: "Black & Gold" }, { id: "amoled_blue", label: "Black & Blue" }, { id: "emerald", label: "Classic Emerald" }, { id: "minimal", label: "Clean Minimal" } ].map((t) => (
                    <Pressable key={t.id} onPress={async () => { setInvoiceTheme(t.id); await api.updateSettings({ invoiceTheme: t.id }); }} style={[{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary }, invoiceTheme === t.id && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "20" }]}>
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, invoiceTheme === t.id && { color: theme.color.brandPrimary }]}>{t.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </AccordionRow>
            </View>

            <Pressable onPress={() => router.push("/advanced-settings")} style={{ marginTop: theme.spacing.lg, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceSecondary, padding: 20, paddingBottom: 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 20 }}>
                <View style={{ flex: 1, paddingRight: 16 }}>
                  <Text style={{ fontSize: 15, fontWeight: "500", color: theme.color.brandPrimary }}>Advanced Settings</Text>
                  <Text style={{ fontSize: 12, color: theme.color.muted, marginTop: 4 }}>AI config, Workflows, Opening Balances, Backup...</Text>
                </View>
                <View style={{ backgroundColor: theme.color.brandPrimary + "25", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.color.brandPrimary }}>Open ›</Text>
                </View>
              </View>
            </Pressable>

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
