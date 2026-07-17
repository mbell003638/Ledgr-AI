import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { api, getGeminiKey, setGeminiKey } from "@/src/api";
import { ScreenHeader, Card } from "@/src/components/UI";
import { shareJsonFile, pickJsonFile } from "@/src/utils/share";

export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const [key, setKey] = useState("");
  const [rate, setRate] = useState("2500");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      const localKey = await getGeminiKey();
      setKey(localKey || s.googleApiKey || "");
      setRate(String(s.fcRate ?? 2500));
    } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await setGeminiKey(key.trim());
      await api.updateSettings({ googleApiKey: key.trim(), fcRate: parseFloat(rate) || 1 });
      setStatus({ ok: true, msg: "Settings saved." });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Failed" });
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await setGeminiKey(key.trim());
      const r = await api.testKey();
      setStatus({ ok: true, msg: `API key works. Reply: ${r.reply}` });
    } catch (e: any) {
      setStatus({ ok: false, msg: e.message || "Test failed" });
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

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Settings" subtitle="Configure AI & currency" />
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Card>
              <Text style={styles.label}>Google Gemini API Key</Text>
              <Text style={styles.hint}>Used for voice parsing, OCR, and transcription. Get one at aistudio.google.com.</Text>
              <TextInput
                testID="input-api-key"
                value={key}
                onChangeText={setKey}
                placeholder="AIza..."
                placeholderTextColor={theme.color.muted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={styles.input}
              />
              <Pressable
                testID="btn-test-key"
                onPress={testKey}
                disabled={testing || !key}
                style={({ pressed }) => [styles.secondaryBtn, (pressed || testing) && { opacity: 0.7 }]}
              >
                {testing ? <ActivityIndicator color={theme.color.brandPrimary} /> :
                  <Text style={styles.secondaryText}>Test API Key</Text>}
              </Pressable>
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
              <Text style={styles.label}>FC Exchange Rate</Text>
              <Text style={styles.hint}>1 USD = X Franc Congolese (CDF)</Text>
              <TextInput
                testID="input-fc-rate"
                value={rate}
                onChangeText={setRate}
                keyboardType="decimal-pad"
                style={styles.input}
                placeholder="2500"
                placeholderTextColor={theme.color.muted}
              />
            </Card>

            {status && (
              <View style={[styles.status, { backgroundColor: status.ok ? "#E7F1EA" : "#FBE8E5" }]}>
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
}); }
