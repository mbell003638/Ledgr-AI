import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

export default function VoiceModal() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<any>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await AudioModule.requestRecordingPermissionsAsync();
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch (e) { console.warn(e); }
    })();
  }, []);

  const start = async () => {
    setError(""); setTranscript(""); setParsed(null);
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase("recording");
    } catch (e: any) { setError(e.message); setPhase("error"); }
  };

  const stopAndProcess = async () => {
    setPhase("processing");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("No audio captured");
      const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      // Determine mime
      const mime = Platform.OS === "ios" ? "audio/m4a" : "audio/m4a";
      const t = await api.transcribe(audioBase64, mime);
      const txt = (t.transcript || "").trim();
      if (!txt) throw new Error("Nothing was heard. Try again.");
      setTranscript(txt);
      const p = await api.parseCommand(txt);
      setParsed(p);
      setPhase("confirm");
    } catch (e: any) {
      setError(e.message || "Voice processing failed");
      setPhase("error");
    }
  };

  const confirmSave = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      const rateSettings = await api.getSettings();
      const rate = rateSettings.fcRate || 2500;
      const date = parsed.date || new Date().toISOString().slice(0, 10);
      const currency = parsed.currency || "USD";

      if (parsed.intent === "bill") {
        // find or create supplier
        let sid = "";
        if (parsed.supplierName) {
          const list = await api.listSuppliers();
          const match = list.find((s: any) => s.name.toLowerCase().includes(parsed.supplierName.toLowerCase()));
          if (match) sid = match.id;
          else {
            const created = await api.createSupplier({ name: parsed.supplierName });
            sid = created.id;
          }
        }
        await api.createBill({
          supplierId: sid, date, amount: parsed.amount, currency, rate,
          paymentType: parsed.paymentType === "cash" ? "cash" : "credit",
          notes: parsed.notes || parsed.summary,
        });
      } else if (parsed.intent === "sale") {
        await api.createSale({ date, amount: parsed.amount, currency, rate, notes: parsed.notes || parsed.summary });
      } else if (parsed.intent === "supplier_payment") {
        let sid = "";
        if (parsed.supplierName) {
          const list = await api.listSuppliers();
          const match = list.find((s: any) => s.name.toLowerCase().includes(parsed.supplierName.toLowerCase()));
          if (match) sid = match.id;
          else { const c = await api.createSupplier({ name: parsed.supplierName }); sid = c.id; }
        }
        await api.createPayment({
          date, amount: parsed.amount, currency, rate,
          type: "supplier_payment", supplierId: sid,
          method: "cash", notes: parsed.notes || parsed.summary,
        });
      } else if (parsed.intent === "drawing") {
        await api.createPayment({
          date, amount: parsed.amount, currency, rate,
          type: "drawing", partnerName: parsed.partnerName || parsed.supplierName || "Partner",
          method: "cash", notes: parsed.notes || parsed.summary,
        });
      } else if (parsed.intent === "inventory") {
        const info = await api.expectedInventory();
        await api.createInventory({ date, expectedStock: info.expected, actualStock: parsed.amount, notes: parsed.notes || parsed.summary });
      } else {
        throw new Error("Could not determine intent. Please try again.");
      }
      router.back();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    setPhase("idle"); setTranscript(""); setParsed(null); setError("");
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-voice" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>AI Voice Assistant</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card>
          <Text style={styles.title}>Say a transaction</Text>
          <Text style={styles.hint}>
            {'e.g., "We paid Rahim supplier 1000 USD on July 17", "Sold 250 today", "Withdrew 500 for Amit"'}
          </Text>

          <View style={styles.micArea}>
            {phase === "recording" ? (
              <Pressable testID="btn-stop-voice" onPress={stopAndProcess} style={[styles.micBtn, styles.micRecording]}>
                <Ionicons name="stop" size={40} color="#fff" />
              </Pressable>
            ) : phase === "processing" ? (
              <View style={[styles.micBtn, { backgroundColor: theme.color.brandSecondary }]}>
                <ActivityIndicator color="#fff" size="large" />
              </View>
            ) : (
              <Pressable testID="btn-start-voice" onPress={start} style={styles.micBtn}>
                <Ionicons name="mic" size={40} color="#fff" />
              </Pressable>
            )}
            <Text style={styles.micLabel}>
              {phase === "recording" ? "Listening… tap to stop" :
                phase === "processing" ? "Transcribing…" :
                  phase === "confirm" ? "Review draft below" :
                    phase === "error" ? "Try again" :
                      "Tap microphone to start"}
            </Text>
          </View>

          {transcript ? (
            <View style={styles.transcriptBox}>
              <Text style={styles.transcriptLabel}>Transcript</Text>
              <Text style={styles.transcript} testID="voice-transcript">{transcript}</Text>
            </View>
          ) : null}

          {phase === "confirm" && parsed && (
            <View style={styles.draft} testID="voice-draft">
              <Text style={styles.draftLabel}>Draft {parsed.intent?.replace("_", " ")}</Text>
              <Text style={styles.draftSummary}>{parsed.summary}</Text>
              <View style={styles.draftGrid}>
                {parsed.amount != null && <DKV k="Amount" v={fmt(parsed.amount, parsed.currency || "USD")} theme={theme} />}
                {parsed.date && <DKV k="Date" v={parsed.date} theme={theme} />}
                {parsed.supplierName && <DKV k="Supplier" v={parsed.supplierName} theme={theme} />}
                {parsed.partnerName && <DKV k="Partner" v={parsed.partnerName} theme={theme} />}
                {parsed.paymentType && <DKV k="Type" v={parsed.paymentType} theme={theme} />}
              </View>
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <Pressable testID="btn-voice-cancel" onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                  <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Try Again</Text>
                </Pressable>
                <Pressable testID="btn-voice-confirm" onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary, flex: 1.4 }]}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>Confirm & Save</Text>}
                </Pressable>
              </View>
            </View>
          )}

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color={theme.color.error} />
              <Text style={styles.errorText} testID="voice-error">{error}</Text>
            </View>
          ) : null}
        </Card>
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function DKV({ k, v, theme }: { k: string; v: string; theme: any }) {
  return (
    <View style={{ width: "50%", paddingVertical: 4 }}>
      <Text style={{ fontSize: 11, color: theme.color.muted }}>{k}</Text>
      <Text style={{ fontSize: 14, color: theme.color.onSurface, fontWeight: "600" }}>{v}</Text>
    </View>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  scroll: { padding: theme.spacing.lg },
  title: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface },
  hint: { fontSize: 13, color: theme.color.muted, marginTop: 6 },
  micArea: { alignItems: "center", paddingVertical: theme.spacing.xl, gap: 12 },
  micBtn: { width: 96, height: 96, borderRadius: 48, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 },
  micRecording: { backgroundColor: theme.color.error },
  micLabel: { color: theme.color.muted, fontSize: 13, fontWeight: "500" },
  transcriptBox: { marginTop: 8, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md },
  transcriptLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  transcript: { fontSize: 14, color: theme.color.onSurface, marginTop: 4, fontStyle: "italic" },
  draft: { marginTop: theme.spacing.md, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brandTertiary },
  draftLabel: { fontSize: 11, color: theme.color.brandPrimary, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  draftSummary: { fontSize: 15, color: theme.color.onSurface, fontWeight: "600", marginTop: 6 },
  draftGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  actionBtn: { flex: 1, padding: 12, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: "#FBE8E5", borderRadius: theme.radius.md, marginTop: theme.spacing.md },
  errorText: { color: theme.color.error, fontSize: 13, flex: 1 },
}); }
