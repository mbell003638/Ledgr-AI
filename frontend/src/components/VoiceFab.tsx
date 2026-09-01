import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Modal, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";
import { api, getAIConfig } from "@/src/api";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { resolveVoicePartyCommand } from "@/src/accountingV2/voicePartyResolution";
import { buildVoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";
import { BlurView } from "expo-blur";
import { fmt } from "@/src/theme";
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withSequence, Easing, SlideInDown } from "react-native-reanimated";
import { localTodayIso } from "@/src/utils/dateValidation";
import { captureVoiceRecording, cancelVoiceRecorder, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { getDeviceSpeechStatus, startDeviceSpeechRecognition } from "@/src/utils/deviceSpeechRecognizer";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

export default function VoiceFab() {
  const theme = useTheme();
  const { motionEnabled } = useAnimations();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<any>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [validatedAction, setValidatedAction] = useState<AssistantProposalValidationResult | null>(null);
  const deviceStopRef = useRef<(() => Promise<void>) | null>(null);
  const transcriptRef = useRef("");

  const pulseScale = useSharedValue(1);

  useEffect(() => () => { void deviceStopRef.current?.(); deviceStopRef.current = null; void cancelVoiceRecorder(recorder); }, [recorder]);

  useEffect(() => {
    if (phase === "recording") {
      if (!motionEnabled) { pulseScale.value = 1; return; }
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
    } else {
      pulseScale.value = withTiming(1);
    }
  }, [motionEnabled, phase, pulseScale]);

  const buildVoiceDraft = async (txt: string) => {
    const parsedCommand = await api.parseCommand(txt);
    const [suppliers, customers, capitalAccounts] = await Promise.all([
      api.listSuppliers(), api.listDebtors(), api.listInvestors(),
    ]);
    const resolution = resolveVoicePartyCommand(parsedCommand, txt, { suppliers, customers, capitalAccounts });
    if (!resolution.ok) throw new Error(resolution.question);
    return buildVoiceTransactionDraft(resolution.command);
  };
  const start = async () => {
    setError(""); setTranscript(""); setParsed(null);
    try {
      const cfg = await getAIConfig();
      const mode = cfg.voiceProvider || "auto";
      if (mode !== "cloud") {
        const status = await getDeviceSpeechStatus();
        if (status.available) {
          transcriptRef.current = "";
          deviceStopRef.current = await startDeviceSpeechRecognition({ onPartial: (text) => { transcriptRef.current = text; setTranscript(text); }, onFinal: (text) => { transcriptRef.current = text; setTranscript(text); }, onError: (speechError) => { setError(speechError.message); setPhase("error"); } });
          setPhase("recording");
          return;
        }
        if (mode === "android-device") throw new Error(status.reason || "Android device speech recognition is unavailable.");
      }
      await startVoiceRecorder(recorder);
      setPhase("recording");
    } catch (e: any) { setError(e.message); setPhase("error"); }
  };

  const stopAndProcess = async () => {
    setPhase("processing");
    try {
      let txt = "";
      if (deviceStopRef.current) { await deviceStopRef.current(); deviceStopRef.current = null; txt = transcriptRef.current.trim(); }
      else { const captured = await captureVoiceRecording(recorder); const t = await api.transcribe(captured.audioBase64, captured.mime, captured.uploadUri); txt = (t.transcript || "").trim(); }
      if (!txt) throw new Error("Nothing was heard. Try again.");
      setTranscript(txt);
      
      const draft = await buildVoiceDraft(txt);
      setParsed(draft.parsed);
      setValidatedAction(draft.validation);
      setPhase("confirm");
    } catch (e: any) {
      setError(e.message || "Voice processing failed");
      setPhase("error");
    }
  };

  const rebuildDraft = async () => {
    const txt = transcript.trim();
    if (!txt) return;
    setError(""); setPhase("processing");
    try {
      const draft = await buildVoiceDraft(txt);
      setParsed(draft.parsed);
      setValidatedAction(draft.validation);
      setPhase("confirm");
    } catch (e: any) {
      setError(e?.message || "Could not update the draft from that transcript.");
      setPhase("error");
    }
  };
  const confirmSave = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      const date = parsed.date || localTodayIso();
      const currency = (await api.getSettings()).currency || "USD";

      if (!validatedAction || !validatedAction.ok) throw new Error("Voice action requires validation before saving.");
      await executeAssistantProposal(validatedAction, { confirmed: true }, async () => {
        if (parsed.intent === "expense") {
          await api.createExpense({ date, amount: parsed.amount, currency, category: parsed.category || "General", notes: parsed.notes || parsed.summary, method: parsed.method || "cash" });
        } else if (parsed.intent === "bill") {
          const list = await api.listSuppliers();
          const match = list.filter((supplier: any) => supplier.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createBill({
            supplierId: match[0].id, date, amount: parsed.amount, currency,
            paymentType: parsed.paymentType === "cash" ? "cash" : "credit",
            notes: parsed.notes || parsed.summary,
          });
        } else if (parsed.intent === "sale") {
          await api.createSale({ date, amount: parsed.amount, currency, notes: parsed.notes || parsed.summary });
        } else if (parsed.intent === "receipt") {
          const mode = parsed.receiptMode || (parsed.customerName ? "against_invoice" : "cash_sale");
          const method = parsed.method || "cash";
          if (!parsed.customerName || mode === "cash_sale") {
            await api.createSale({ date, amount: parsed.amount, currency, notes: parsed.notes || parsed.summary, method });
          } else {
            let debtorId: string | null = null;
            let allocations: { invoiceId: string; amountApplied: number }[] = [];
            const debtors = await api.listDebtors();
            const match = debtors.find((d: any) => d.name.trim().toLowerCase() === parsed.customerName.trim().toLowerCase());
            if (match) debtorId = match.id;
            else throw new Error(`Customer "${parsed.customerName}" was not found. Add the Customer first.`);
            if (mode === "against_invoice") {
              const invs = (await api.listInvoices())
                .filter((i: any) => i.status !== "paid" && (i.clientName || "").toLowerCase().includes(parsed.customerName.toLowerCase()))
                .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
              if (invs[0]) allocations = [{ invoiceId: invs[0].id, amountApplied: parsed.amount }];
            }
            await api.createReceipt({
              mode, date, amount: parsed.amount, method,
              debtorId, clientName: parsed.customerName,
              allocations, notes: parsed.notes || parsed.summary,
            });
          }
        } else if (parsed.intent === "supplier_payment") {
          const list = await api.listSuppliers();
          const match = list.filter((s: any) => s.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
          await api.createPayment({
            date, amount: parsed.amount, currency,
            type: "supplier_payment", supplierId: match[0].id,
            method: parsed.method || "cash", notes: parsed.notes || parsed.summary,
          });
        } else if (parsed.intent === "drawing") {
          const members = await api.listInvestors();
          const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsed.partnerName || "").trim().toLowerCase());
          if (match.length !== 1) throw new Error(`Capital Account "${parsed.partnerName}" was not found uniquely.`);
          await api.drawInvestorFunds(match[0].id, { date, amount: parsed.amount, method: parsed.method || "cash", notes: parsed.notes || parsed.summary });
        } else if (parsed.intent === "inventory") {
          await api.recordV2InventoryCount({ date, value: Number(parsed.amount), notes: parsed.notes || parsed.summary });
        } else {
          throw new Error("Could not determine intent. Please try again.");
        }
      });
      reset();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    setPhase("idle"); setTranscript(""); setParsed(null); setValidatedAction(null); setError("");
  };

  const isModalOpen = phase !== "idle";

  const animatedMicStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  return (
    <>
      <Pressable
        testID="voice-fab"
        onPress={start}
        style={({ pressed }) => [
          styles.fab,
          { backgroundColor: theme.color.brandPrimary },
          pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
        ]}
      >
        <Ionicons name="mic" size={26} color={theme.color.onBrandPrimary} />
      </Pressable>

      <Modal transparent visible={isModalOpen} animationType="fade" onRequestClose={reset}>
        <View style={styles.overlayContainer}>
          <Pressable style={styles.overlayPressable} onPress={reset}>
            <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          </Pressable>

          <Animated.View entering={SlideInDown.duration(300).springify()} style={[styles.popupContainer, { backgroundColor: theme.color.surface }]}>
            {/* Header / Dismiss */}
            <View style={styles.popupHeader}>
              <Text style={[styles.popupTitle, { color: theme.color.onSurface }]}>Voice Assistant</Text>
              <Pressable onPress={reset} style={({pressed}) => [pressed && {opacity: 0.5}]}>
                <Ionicons name="close-circle" size={28} color={theme.color.muted} />
              </Pressable>
            </View>

            {phase === "recording" || phase === "processing" ? (
              <View style={styles.recordingBox}>
                <Text style={[styles.hintText, { color: theme.color.muted }]}>
                  “Paid supplier 1000 USD on July 17”
                </Text>
                <Animated.View style={animatedMicStyle}>
                  <Pressable 
                    onPress={phase === "recording" ? stopAndProcess : undefined} 
                    style={[styles.bigMicBtn, { backgroundColor: phase === "recording" ? theme.color.error : theme.color.surfaceTertiary }]}
                  >
                    {phase === "processing" ? (
                       <ActivityIndicator color={theme.color.onSurface} size="large" />
                    ) : (
                       <Ionicons name="stop" size={44} color="#fff" />
                    )}
                  </Pressable>
                </Animated.View>
                <Text style={[styles.statusLabel, { color: theme.color.brandPrimary }]}>
                  {phase === "recording" ? "Listening... Tap to stop" : "Transcribing AI..."}
                </Text>
              </View>
            ) : phase === "confirm" && parsed ? (
              <View style={[styles.draftBox, { backgroundColor: theme.color.surfaceSecondary }]}>
                {transcript ? (
                  <View style={[styles.transcriptBubble, { backgroundColor: theme.color.surfaceTertiary }]}>
                    <TextInput accessibilityLabel="Editable homepage voice transcript" value={transcript} onChangeText={setTranscript} multiline autoCorrect style={{ fontStyle: "italic", color: theme.color.onSurface }} />
                    <Pressable accessibilityRole="button" accessibilityLabel="Update homepage voice draft" onPress={() => void rebuildDraft()}><Text style={{ color: theme.color.brandPrimary, fontWeight: "700", marginTop: 8 }}>Update draft</Text></Pressable>
                  </View>
                ) : null}

                <Text style={[styles.draftLabel, { color: theme.color.brandPrimary }]}>Draft {parsed.intent?.replace("_", " ")}</Text>
                <Text style={[styles.draftSummary, { color: theme.color.onSurface }]}>{parsed.summary}</Text>
                
                <View style={styles.draftGrid}>
                  {parsed.amount != null && <DKV k="Amount" v={fmt(parsed.amount, "USD")} theme={theme} />}
                  {parsed.date && <DKV k="Date" v={parsed.date} theme={theme} />}
                  {parsed.supplierName && <DKV k="Supplier" v={parsed.supplierName} theme={theme} />}
                  {parsed.customerName && <DKV k="Customer" v={parsed.customerName} theme={theme} />}
                  {parsed.partnerName && <DKV k="Capital Account" v={parsed.partnerName} theme={theme} />}
                  {parsed.paymentType && <DKV k="Type" v={parsed.paymentType} theme={theme} />}
                  {parsed.method && <DKV k="Payment method" v={parsed.method === "upi" ? "mobile / UPI" : parsed.method} theme={theme} />}
                </View>

                <View style={styles.btnRow}>
                  <Pressable onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                    <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Cancel</Text>
                  </Pressable>
                  <Pressable onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary }]}>
                    {saving ? <ActivityIndicator color="#000" /> : <Text style={[styles.actionText, { color: '#000' }]}>Save</Text>}
                  </Pressable>
                </View>
              </View>
            ) : phase === "error" ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={32} color={theme.color.error} />
                {transcript ? <TextInput accessibilityLabel="Editable failed homepage voice transcript" value={transcript} onChangeText={setTranscript} multiline autoCorrect style={[styles.transcriptBubble, { color: theme.color.onSurface, backgroundColor: theme.color.surfaceTertiary }]} /> : null}
                <Text style={styles.errorText}>{error}</Text>
                {transcript ? <Pressable accessibilityRole="button" accessibilityLabel="Update failed homepage voice draft" onPress={() => void rebuildDraft()} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary, marginTop: 12 }]}><Text style={[styles.actionText, { color: theme.color.brandPrimary }]}>Update draft</Text></Pressable> : null}
                <Pressable onPress={start} style={[styles.actionBtn, { backgroundColor: theme.color.brandPrimary, marginTop: 16 }]}>
                  <Text style={[styles.actionText, { color: "#000" }]}>Try Again</Text>
                </Pressable>
              </View>
            ) : null}
          </Animated.View>
        </View>
      </Modal>
    </>
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

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 20,
    bottom: 100, // Matching its original location
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
    zIndex: 110,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
  },
  overlayPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  popupContainer: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 500,
    padding: 24,
    paddingBottom: 48,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 24,
  },
  popupHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  popupTitle: {
    fontSize: 20,
    fontWeight: "700",
  },
  recordingBox: {
    alignItems: "center",
    paddingVertical: 24,
  },
  hintText: {
    fontSize: 14,
    marginBottom: 24,
    fontStyle: "italic",
    textAlign: "center",
  },
  bigMicBtn: {
    width: 96,
    height: 96,
    borderRadius: 48,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
  },
  statusLabel: {
    marginTop: 24,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  draftBox: {
    padding: 20,
    borderRadius: 24,
  },
  transcriptBubble: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 16,
  },
  draftLabel: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  draftSummary: {
    fontSize: 18,
    fontWeight: "600",
    marginTop: 8,
    marginBottom: 16,
  },
  draftGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 24,
  },
  btnRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: {
    fontWeight: "600",
    fontSize: 15,
  },
  errorBox: {
    padding: 32,
    backgroundColor: "#FBE8E5",
    borderRadius: 24,
    alignItems: "center",
  },
  errorText: {
    color: "#e3342f",
    fontSize: 16,
    fontWeight: "500",
    marginTop: 16,
    textAlign: "center",
  },
});
