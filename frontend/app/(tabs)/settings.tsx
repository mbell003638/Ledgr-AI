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
  const [partnerNames, setPartnerNames] = useState<string[]>([]);
  const [extraAssets, setExtraAssets] = useState<{ name: string; amount: string }[]>([]);
  const [extraLiabilities, setExtraLiabilities] = useState<{ name: string; amount: string }[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [taxLabel, setTaxLabel] = useState<TaxLabel>("None");
  const [taxLabelCustom, setTaxLabelCustom] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [bizProfile, setBizProfile] = useState({ businessName: "", businessAddress: "", businessPhone: "", businessEmail: "", bankAccount: "", upiId: "", paymentDetails: "" });
  const [logo, setLogo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      const cfg = await getAIConfig();
      setProvider(cfg.provider);
      setKey(cfg.apiKey || "");
      setModelName(cfg.model || "");
      setBaseUrl(cfg.baseUrl || "");
      setCommissionPct(s.managerCommissionPct ? String(s.managerCommissionPct) : "");
      setOpeningCapital(s.openingCapital ? String(s.openingCapital) : "");
      setPartnerNames(Array.isArray(s.partnerNames) ? s.partnerNames : []);
      setExtraAssets(
        (Array.isArray(s.extraAssets) ? s.extraAssets : []).map((a: any) => ({
          name: String(a?.name ?? ""),
          amount: a?.amount != null ? String(a.amount) : "",
        }))
      );
      setExtraLiabilities(
        (Array.isArray(s.extraLiabilities) ? s.extraLiabilities : []).map((l: any) => ({
          name: String(l?.name ?? ""),
          amount: l?.amount != null ? String(l.amount) : "",
        }))
      );
      setCurrency(s.currency || "USD");
      setTaxLabel((s.taxLabel as TaxLabel) || "None");
      setTaxLabelCustom(s.taxLabelCustom || "");
      setTaxRate(s.taxRate ? String(s.taxRate) : "");
      setBizProfile({
        businessName: s.businessName || "",
        businessAddress: s.businessAddress || "",
        businessPhone: s.businessPhone || "",
        businessEmail: s.businessEmail || "",
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
      await api.updateSettings({
        googleApiKey: key.trim(),
        managerCommissionPct: commissionPct.trim() ? parseFloat(commissionPct) : 0,
        openingCapital: openingCapital.trim() ? parseFloat(openingCapital) : 0,
        partnerNames: partnerNames.map((n) => n.trim()).filter(Boolean),
        extraAssets: extraAssets
          .map((a) => ({ name: a.name.trim(), amount: a.amount.trim() ? parseFloat(a.amount) : 0 }))
          .filter((a) => a.name),
        extraLiabilities: extraLiabilities
          .map((l) => ({ name: l.name.trim(), amount: l.amount.trim() ? parseFloat(l.amount) : 0 }))
          .filter((l) => l.name),
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

  const updatePartner = (i: number, v: string) =>
    setPartnerNames((prev) => prev.map((n, idx) => (idx === i ? v : n)));
  const addPartner = () => setPartnerNames((prev) => [...prev, ""]);
  const removePartner = (i: number) => setPartnerNames((prev) => prev.filter((_, idx) => idx !== i));

  const updateAsset = (i: number, field: "name" | "amount", v: string) =>
    setExtraAssets((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: v } : a)));
  const addAsset = () => setExtraAssets((prev) => [...prev, { name: "", amount: "" }]);
  const removeAsset = (i: number) => setExtraAssets((prev) => prev.filter((_, idx) => idx !== i));

  const updateLiability = (i: number, field: "name" | "amount", v: string) =>
    setExtraLiabilities((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: v } : l)));
  const addLiability = () => setExtraLiabilities((prev) => [...prev, { name: "", amount: "" }]);
  const removeLiability = (i: number) => setExtraLiabilities((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Settings" subtitle="Configure AI & backup" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Card>
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
              <Text style={styles.label}>Opening Capital (combined)</Text>
              <Text style={styles.hint}>Total initial investment by all partners (USD).</Text>
              <TextInput
                testID="input-opening-capital"
                value={openingCapital}
                onChangeText={setOpeningCapital}
                keyboardType="decimal-pad"
                style={styles.input}
                placeholder="e.g. 5000"
                placeholderTextColor={theme.color.muted}
              />
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Partners</Text>
              <Text style={styles.hint}>Names used to attribute drawings. Add or remove partners as needed.</Text>
              {partnerNames.map((name, i) => (
                <View key={`partner-${i}`} style={styles.entryRow}>
                  <TextInput
                    testID={`input-partner-${i}`}
                    value={name}
                    onChangeText={(v) => updatePartner(i, v)}
                    placeholder="Partner name"
                    placeholderTextColor={theme.color.muted}
                    autoCapitalize="words"
                    style={[styles.input, styles.entryInput]}
                  />
                  <Pressable
                    testID={`btn-remove-partner-${i}`}
                    onPress={() => removePartner(i)}
                    style={styles.removeBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                  </Pressable>
                </View>
              ))}
              <Pressable testID="btn-add-partner" onPress={addPartner} style={styles.addBtn}>
                <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.addText}>Add Partner</Text>
              </Pressable>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Custom Assets</Text>
              <Text style={styles.hint}>Extra assets to include on the balance sheet (e.g. Van, Equipment).</Text>
              {extraAssets.map((a, i) => (
                <View key={`asset-${i}`} style={styles.entryRow}>
                  <TextInput
                    testID={`input-asset-name-${i}`}
                    value={a.name}
                    onChangeText={(v) => updateAsset(i, "name", v)}
                    placeholder="Name"
                    placeholderTextColor={theme.color.muted}
                    style={[styles.input, styles.entryInput]}
                  />
                  <TextInput
                    testID={`input-asset-amount-${i}`}
                    value={a.amount}
                    onChangeText={(v) => updateAsset(i, "amount", v)}
                    keyboardType="decimal-pad"
                    placeholder="Amount"
                    placeholderTextColor={theme.color.muted}
                    style={[styles.input, styles.entryAmount]}
                  />
                  <Pressable
                    testID={`btn-remove-asset-${i}`}
                    onPress={() => removeAsset(i)}
                    style={styles.removeBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                  </Pressable>
                </View>
              ))}
              <Pressable testID="btn-add-asset" onPress={addAsset} style={styles.addBtn}>
                <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.addText}>Add Asset</Text>
              </Pressable>
            </Card>

            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.label}>Custom Liabilities</Text>
              <Text style={styles.hint}>Extra liabilities to include on the balance sheet (e.g. Loan, Rent due).</Text>
              {extraLiabilities.map((l, i) => (
                <View key={`liability-${i}`} style={styles.entryRow}>
                  <TextInput
                    testID={`input-liability-name-${i}`}
                    value={l.name}
                    onChangeText={(v) => updateLiability(i, "name", v)}
                    placeholder="Name"
                    placeholderTextColor={theme.color.muted}
                    style={[styles.input, styles.entryInput]}
                  />
                  <TextInput
                    testID={`input-liability-amount-${i}`}
                    value={l.amount}
                    onChangeText={(v) => updateLiability(i, "amount", v)}
                    keyboardType="decimal-pad"
                    placeholder="Amount"
                    placeholderTextColor={theme.color.muted}
                    style={[styles.input, styles.entryAmount]}
                  />
                  <Pressable
                    testID={`btn-remove-liability-${i}`}
                    onPress={() => removeLiability(i)}
                    style={styles.removeBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                  </Pressable>
                </View>
              ))}
              <Pressable testID="btn-add-liability" onPress={addLiability} style={styles.addBtn}>
                <Ionicons name="add-outline" size={18} color={theme.color.brandPrimary} />
                <Text style={styles.addText}>Add Liability</Text>
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
                { label: "Bank Account / IBAN / Interac", key: "bankAccount", placeholder: "Acct no, IBAN, or Interac email" },
                { label: "UPI ID", key: "upiId", placeholder: "name@upi" },
                { label: "Other Payment Details / Link", key: "paymentDetails", placeholder: "PayPal, payment link, cheque payable to…" },
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
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {CURRENCIES.map((c) => (
                  <Pressable
                    key={c.code}
                    onPress={() => setCurrency(c.code)}
                    style={[styles.modeBtn, currency === c.code && styles.modeBtnActive, { paddingHorizontal: 10 }]}
                  >
                    <Text style={[styles.modeText, currency === c.code && styles.modeTextActive]}>{c.symbol} {c.code}</Text>
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
