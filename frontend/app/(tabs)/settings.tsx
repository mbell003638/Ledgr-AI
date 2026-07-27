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
  const [currency, setCurrency] = useState("USD");
  const [taxLabel, setTaxLabel] = useState<TaxLabel>("None");
  const [taxLabelCustom, setTaxLabelCustom] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [bizProfile, setBizProfile] = useState({ businessName: "", businessAddress: "", businessPhone: "", businessEmail: "", taxRegNo: "", bankAccount: "", upiId: "", paymentDetails: "" });
  const [logo, setLogo] = useState<string>("");
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
      setTaxLabel((s.taxLabel as TaxLabel) || "None");
      setTaxLabelCustom(s.taxLabelCustom || "");
      setTaxRate(s.taxRate ? String(s.taxRate) : "");
      setBizProfile({
        businessName: s.businessName || "",
        businessAddress: s.businessAddress || "",
        businessPhone: s.businessPhone || "",
        businessEmail: s.businessEmail || "",
        taxRegNo: s.taxRegNo || "",
        bankAccount: s.bankAccount || "",
        upiId: s.upiId || "",
        paymentDetails: s.paymentDetails || "",
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
    setStatus({ ok: true, msg: "Switched account. Reloading…" });
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
      // Immediately switch into the new account so the user can set it up.
      await switchBook(meta.id);
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
              <Text style={styles.label}>Account & Workflows</Text>
              <Text style={styles.hint}>Switch active account or toggle business workflows.</Text>
              
              {/* Active Accounts list */}
              <View style={{ gap: 6, marginTop: theme.spacing.sm }}>
                {books.map((b) => (
                  <Pressable key={b.id} onPress={() => switchBook(b.id)} style={[styles.bookRow, b.id === activeBook && styles.bookRowActive]}>
                    <Ionicons
                      name={b.id === activeBook ? "checkmark-circle" : "ellipse-outline"}
                      size={20}
                      color={b.id === activeBook ? theme.color.brandPrimary : theme.color.muted}
                    />
                    <Text style={[styles.bookName, { flex: 1 }]}>{b.name}</Text>
                    {b.id === activeBook ? (
                      <View style={{ backgroundColor: theme.color.brandPrimary + "20", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 }}>
                        <Text style={{ fontSize: 11, fontWeight: "700", color: theme.color.brandPrimary }}>Active</Text>
                      </View>
                    ) : null}
                    {b.id !== "default" && (
                      <Pressable onPress={() => removeBook(b.id)} style={{ marginLeft: 8 }} testID={`btn-remove-book-${b.id}`}>
                        <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                      </Pressable>
                    )}
                  </Pressable>
                ))}
              </View>

              {/* Compact Workflows chips */}
              <Text style={[styles.label, { marginTop: theme.spacing.md, fontSize: 14 }]}>Enabled Workflows</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.xs }}>
                {PERSONAS.map((p) => {
                  const chosen = selectedPersonas.includes(p.id);
                  const isActive = activePersona === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => {
                        if (chosen && selectedPersonas.length === 1) return;
                        const next = chosen ? selectedPersonas.filter((id) => id !== p.id) : [...selectedPersonas, p.id];
                        setSelectedPersonas(next);
                        if (activePersona === p.id && !next.includes(activePersona)) setActivePersona(next[0]);
                      }}
                      onLongPress={() => setActivePersona(p.id)}
                      style={[{
                        flexDirection: "row", alignItems: "center", gap: 6,
                        paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20,
                        borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary
                      }, chosen && { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary + "15" }]}
                    >
                      <Ionicons name={chosen ? "checkmark-circle" : "ellipse-outline"} size={16} color={chosen ? theme.color.brandPrimary : theme.color.muted} />
                      <Text style={[{ fontSize: 13, fontWeight: "600", color: theme.color.onSurface }, chosen && { color: theme.color.brandPrimary }]}>
                        {p.label}
                      </Text>
                      {isActive && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.color.brandPrimary }} />}
                    </Pressable>
                  );
                })}
              </View>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Accounting Style</Text>
              <Text style={styles.hint}>Choose how profit, partner stakes, and financial reports are computed.</Text>
              <View style={{ gap: 10, marginTop: theme.spacing.sm }}>
                <Pressable
                  onPress={() => updateAccountingStyle('retail_partnership')}
                  style={[styles.bookRow, accountingStyle === 'retail_partnership' && styles.bookRowActive]}
                >
                  <Ionicons
                    name={accountingStyle === 'retail_partnership' ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={accountingStyle === 'retail_partnership' ? theme.color.brandPrimary : theme.color.muted}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bookName}>Partner Equity & Profit-Split Accounting</Text>
                    <Text style={styles.hint}>
                      50/50 Partner Capital Accounts (Amit & Rahim), periodic physical stock audit, shopkeeper salary & commission % on gross profit, and period close balance carry-forward.
                    </Text>
                  </View>
                </Pressable>

                <Pressable
                  onPress={() => updateAccountingStyle('standard')}
                  style={[styles.bookRow, accountingStyle === 'standard' && styles.bookRowActive]}
                >
                  <Ionicons
                    name={accountingStyle === 'standard' ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={accountingStyle === 'standard' ? theme.color.brandPrimary : theme.color.muted}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bookName}>Standard Entity & Single-Owner Accounting</Text>
                    <Text style={styles.hint}>
                      Standard P&L, Balance Sheet, Trial Balance, Accounts Receivable & Payable for general small businesses, freelancers & single owners.
                    </Text>
                  </View>
                </Pressable>
              </View>
            </Card>
            <View style={[styles.entryRow, { marginTop: theme.spacing.md }]}>
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

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>AI Provider</Text>
              <View style={styles.modeRow}>
                {PROVIDERS.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => { setProvider(p.id); setModelName(p.defaultModel); setBaseUrl(p.defaultBaseUrl); setTestResult(null); }}
                    style={[styles.modeBtn, provider === p.id && styles.modeBtnActive]}
                  >
                    <Text style={[styles.modeText, provider === p.id && styles.modeTextActive]} numberOfLines={1}>
                      {p.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[styles.label, { marginTop: theme.spacing.md }]}>API Key</Text>
              <Text style={styles.hint}>{PROVIDERS.find((p) => p.id === provider)?.keyHint ?? ""}</Text>
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
                placeholder={PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? "model name"}
                placeholderTextColor={theme.color.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />

              {provider === "custom" && (
                <>
                  <Text style={[styles.label, { marginTop: theme.spacing.md }]}>Base URL</Text>
                  <Text style={styles.hint}>OpenAI-compatible endpoint (e.g. https://my-server.com/v1)</Text>
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
              <Text style={styles.label}>Appearance</Text>
              <Text style={styles.hint}>Choose light, dark or match system.</Text>
              <View style={styles.modeRow}>
                {(["light", "dark", "system"] as const).map((m) => (
                  <Pressable
                    key={m}
                    testID={`mode-${m}`}
                    onPress={() => setMode(m)}
                    style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
                  >
                    <Ionicons
                      name={m === "light" ? "sunny-outline" : m === "dark" ? "moon-outline" : "phone-portrait-outline"}
                      size={18}
                      color={mode === m ? theme.color.onBrandPrimary : theme.color.onSurface}
                    />
                    <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                      {m.charAt(0).toUpperCase() + m.slice(1)}
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

              <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>Company Logo</Text>
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

              {[
                { label: "Business Name", key: "businessName", placeholder: "e.g. Amit General Store" },
                { label: "Address", key: "businessAddress", placeholder: "Street, City" },
                { label: "Phone", key: "businessPhone", placeholder: "+1 555 000 0000" },
                { label: "Email", key: "businessEmail", placeholder: "you@example.com" },
                { label: "Tax Reg. No (TRN / GSTIN / VAT)", key: "taxRegNo", placeholder: "Shown on invoices" },
                { label: "Bank Account / IBAN / Interac", key: "bankAccount", placeholder: "Acct no, IBAN, or Interac email" },
                { label: "Payment ID / Link", key: "upiId", placeholder: "Interac, UPI ID, PayPal or payment link" },
                { label: "Other Payment Details", key: "paymentDetails", placeholder: "Cheque payable to…, notes, alt. link" },
              ].map(({ label, key, placeholder }) => (
                <View key={key}>
                  <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>{label}</Text>
                  <TextInput
                    value={bizProfile[key as keyof typeof bizProfile]}
                    onChangeText={(v) => setBizProfile((p) => ({ ...p, [key]: v }))}
                    placeholder={placeholder}
                    placeholderTextColor={theme.color.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                </View>
              ))}
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Currency</Text>
              <Text style={styles.hint}>Used across all reports and entries.</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {CURRENCIES.map((c) => (
                  <Pressable
                    key={c.code}
                    onPress={() => setCurrency(c.code)}
                    style={[styles.currencyChip, currency === c.code && styles.currencyChipActive]}
                  >
                    <Text style={[styles.currencyChipText, currency === c.code && styles.currencyChipTextActive]}>{c.symbol} {c.code}</Text>
                  </Pressable>
                ))}
              </View>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Tax Label</Text>
              <Text style={styles.hint}>What tax is called in your country (or None).</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {TAX_LABELS.map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setTaxLabel(t)}
                    style={[styles.modeBtn, taxLabel === t && styles.modeBtnActive]}
                  >
                    <Text style={[styles.modeText, taxLabel === t && styles.modeTextActive]}>{t}</Text>
                  </Pressable>
                ))}
              </View>
              {taxLabel === "Custom" && (
                <TextInput
                  value={taxLabelCustom}
                  onChangeText={setTaxLabelCustom}
                  placeholder="e.g. Service Tax"
                  placeholderTextColor={theme.color.muted}
                  style={[styles.input, { marginTop: 8 }]}
                />
              )}
              {taxLabel !== "None" && (
                <>
                  <Text style={[styles.label, { marginTop: theme.spacing.sm }]}>
                    {taxLabel === "Custom" ? taxLabelCustom || "Tax" : taxLabel} Rate %
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

function makeStyles(theme: any) { return StyleSheet.create({
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
}); }
