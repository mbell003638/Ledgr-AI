import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api, getAIConfig } from "@/src/api";
import { Card } from "@/src/components/UI";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { resolveVoicePartyCommand } from "@/src/accountingV2/voicePartyResolution";
import { buildVoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";

import { captureVoiceRecording, cancelVoiceRecorder, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { getDeviceSpeechStatus, startDeviceSpeechRecognition } from "@/src/utils/deviceSpeechRecognizer";
import { continueVoiceTransaction, interpretVoiceTransaction, type PendingVoiceClarification, type VoiceInterpretationResult } from "@/src/accountingV2/voiceInterpretationRouter";

import { localTodayIso } from "@/src/utils/dateValidation";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

// Source tag prefixed onto notes/memo of records created via voice (fix M-5).
const voiceNote = (note?: string) => `[Voice] ${note || ""}`.trim();

export default function VoiceModal() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ assistantText?: string }>();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [parsed, setParsed] = useState<any>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [validatedAction, setValidatedAction] = useState<AssistantProposalValidationResult | null>(null);
  const [pendingClarification, setPendingClarification] = useState<PendingVoiceClarification | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState("");
  const deviceStopRef = useRef<(() => Promise<void>) | null>(null);
  const transcriptRef = useRef("");
  const buildVoiceDraftRef = useRef<(text: string) => Promise<any>>(async () => { throw new Error("Voice interpretation is not ready."); });

  useEffect(() => () => { void deviceStopRef.current?.(); deviceStopRef.current = null; void cancelVoiceRecorder(recorder); }, [recorder]);

  useEffect(() => {
    const text = typeof params.assistantText === 'string' ? params.assistantText.trim() : '';
    if (text) { setTranscript(text); void buildVoiceDraftRef.current(text).then((draft) => { setParsed(draft.parsed); setValidatedAction(draft.validation); setPhase('confirm'); }).catch((error: any) => { setError(error?.message || 'Could not prepare the Assistant draft.'); setPhase('error'); }); }
  }, [params.assistantText]);


  const draftFromInterpretation = async (interpretation: VoiceInterpretationResult) => {
    if (interpretation.kind === "clarification") {
      setPendingClarification(interpretation);
      throw new Error(interpretation.question);
    }
    if (interpretation.kind === "unsupported") {
      throw new Error(`${interpretation.reason} You can edit the transcript${(await getAIConfig()).interpretationMode === "device-only" ? " or enable Automatic cloud fallback in Settings" : ""}.`);
    }
    const [suppliers, customers, capitalAccounts] = await Promise.all([
      api.listSuppliers(), api.listDebtors(), api.listInvestors(),
    ]);
    const resolution = resolveVoicePartyCommand(interpretation.command, interpretation.transcript, { suppliers, customers, capitalAccounts });
    if (!resolution.ok) {
      setPendingClarification({ kind: "clarification", confidence: "low", command: interpretation.command, field: "intent", question: resolution.question, transcript: interpretation.transcript });
      throw new Error(resolution.question);
    }
    let resolvedCommand = resolution.command;
    if (resolvedCommand.intent === "receipt" && resolvedCommand.receiptMode === "against_invoice" && resolvedCommand.customerName) {
      const customer = customers.find((item: any) => item.name.trim().toLowerCase() === String(resolvedCommand.customerName).trim().toLowerCase());
      const invoices = (await api.listInvoices()).filter((invoice: any) => invoice.status !== "paid" && (invoice.partyId === customer?.id || invoice.debtorId === customer?.id || String(invoice.clientName || "").trim().toLowerCase() === String(resolvedCommand.customerName).trim().toLowerCase())).sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)));
      resolvedCommand = invoices[0] ? { ...resolvedCommand, invoiceId: invoices[0].id } : { ...resolvedCommand, receiptMode: "advance" };
    }
    setPendingClarification(null);
    setFollowUpAnswer("");
    return buildVoiceTransactionDraft(resolvedCommand);
  };
  const buildVoiceDraft = async (txt: string) => {
    setPendingClarification(null);
    setFollowUpAnswer("");
    const [cfg, settings] = await Promise.all([getAIConfig(), api.getSettings()]);
    const interpretation = await interpretVoiceTransaction({
      transcript: txt,
      mode: cfg.interpretationMode || "auto",
      hasCloudAI: Boolean(cfg.apiKey),
      parseCloud: api.parseCommand,
      parserOptions: { defaultCurrency: settings.currency || "USD", requirePaymentMethod: true },
    });
    return draftFromInterpretation(interpretation);
  };
  buildVoiceDraftRef.current = buildVoiceDraft;
  const continueDraft = async () => {
    if (!pendingClarification || !followUpAnswer.trim()) return;
    setError(""); setPhase("processing");
    try {
      const settings = await api.getSettings();
      const interpretation = continueVoiceTransaction(pendingClarification, followUpAnswer, { defaultCurrency: settings.currency || "USD", requirePaymentMethod: true });
      if (interpretation.kind !== "command") {
        if (interpretation.kind === "clarification") setPendingClarification(interpretation);
        throw new Error(interpretation.kind === "clarification" ? interpretation.question : interpretation.reason);
      }
      setTranscript(interpretation.transcript);
      const draft = await draftFromInterpretation(interpretation);
      setParsed(draft.parsed); setValidatedAction(draft.validation); setPhase("confirm");
    } catch (e: any) { setError(e?.message || "Could not continue the draft."); setPhase("error"); }
  };
  const start = async () => {
    setError(""); setTranscript(""); setParsed(null); setPendingClarification(null); setFollowUpAnswer("");
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
      if (parsed.intent === "bill") {
        const list = await api.listSuppliers();
        const match = list.filter((supplier: any) => supplier.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
        await api.createBill({
          supplierId: match[0].id, date, amount: parsed.amount, currency,
          paymentType: parsed.paymentType === "cash" ? "cash" : "credit",
          notes: voiceNote(parsed.notes || parsed.summary),
        });
      } else if (parsed.intent === "sale") {
        await api.createSale({ date, amount: parsed.amount, currency, notes: voiceNote(parsed.notes || parsed.summary) });
      } else if (parsed.intent === "expense") {
        await api.createExpense({
          date, amount: parsed.amount, currency,
          category: parsed.category || "General",
          method: parsed.method || "cash",
          notes: voiceNote(parsed.notes || parsed.summary),
        });
      } else if (parsed.intent === "receipt") {
        const mode = parsed.receiptMode || (parsed.customerName ? "against_invoice" : "cash_sale");
        const method = parsed.method || "cash";
        let debtorId: string | null = null;
        let allocations: { invoiceId: string; amountApplied: number }[] = [];
        if (parsed.customerName) {
          const debtors = await api.listDebtors();
          const match = debtors.find((d: any) => d.name.trim().toLowerCase() === parsed.customerName.trim().toLowerCase());
          if (match) debtorId = match.id;
          else throw new Error(`Customer "${parsed.customerName}" was not found. Add the Customer first.`);
          // Auto-allocate an against_invoice receipt to this customer's oldest unpaid invoice.
          if (mode === "against_invoice") {
            const invs = (await api.listInvoices())
              .filter((i: any) => i.status !== "paid" && (i.partyId === debtorId || i.debtorId === debtorId || (i.clientName && i.clientName.trim().toLowerCase() === parsed.customerName.trim().toLowerCase())))
              .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
            if (invs[0]) allocations = [{ invoiceId: invs[0].id, amountApplied: parsed.amount }];
          }
        }
        await api.createReceipt({
          mode, date, amount: parsed.amount, method,
          debtorId, clientName: parsed.customerName || "",
          allocations, notes: voiceNote(parsed.notes || parsed.summary),
        });
      } else if (parsed.intent === "supplier_payment") {
        const list = await api.listSuppliers();
        const match = list.filter((s: any) => s.name.trim().toLowerCase() === String(parsed.supplierName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Supplier "${parsed.supplierName}" was not found uniquely. Add or choose the exact Supplier first.`);
        await api.createPayment({
          date, amount: parsed.amount, currency,
          type: "supplier_payment", supplierId: match[0].id,
          method: parsed.method || "cash", notes: voiceNote(parsed.notes || parsed.summary),
        });
      } else if (parsed.intent === "drawing") {
        const members = await api.listInvestors();
        const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsed.partnerName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Capital Account "${parsed.partnerName}" was not found uniquely.`);
        await api.drawInvestorFunds(match[0].id, { date, amount: parsed.amount, method: parsed.method || "cash", notes: voiceNote(parsed.notes || parsed.summary) });
      } else if (parsed.intent === "capital") {
        const members = await api.listInvestors();
        const match = members.filter((member: any) => member.name.trim().toLowerCase() === String(parsed.partnerName || "").trim().toLowerCase());
        if (match.length !== 1) throw new Error(`Capital Account "${parsed.partnerName}" was not found uniquely.`);
        await api.depositInvestorCapital(match[0].id, { date, amount: parsed.amount, notes: voiceNote(parsed.notes || parsed.summary) });
      } else if (parsed.intent === "inventory") {
        await api.recordV2InventoryCount({ date, value: Number(parsed.amount), notes: voiceNote(parsed.notes || parsed.summary) });
      } else {
        throw new Error("Could not determine intent. Please try again.");
      }
      });
      router.back();
    } catch (e: any) {
      setError(e.message || "Save failed");
      setPhase("error");
    } finally { setSaving(false); }
  };

  const reset = () => {
    setPhase("idle"); setTranscript(""); setParsed(null); setValidatedAction(null); setError(""); setPendingClarification(null); setFollowUpAnswer("");
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
            {'e.g., "We paid supplier 1000 USD on July 17", "Sold 250 today", "Withdrew 500 for owner"'}
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
                    phase === "error" ? "Edit transcript or try again" :
                      "Tap microphone to start"}
            </Text>
          </View>

          {transcript ? (
            <View style={styles.transcriptBox}>
              <Text style={styles.transcriptLabel}>Transcript</Text>
              <TextInput accessibilityLabel="Editable voice transcript" testID="voice-transcript-input" value={transcript} onChangeText={setTranscript} multiline autoCorrect style={styles.transcript} />
              {phase === "confirm" || phase === "error" ? <Pressable accessibilityRole="button" accessibilityLabel="Update draft from edited transcript" onPress={() => void rebuildDraft()} style={[styles.actionBtn, { marginTop: 10 }]}><Text style={styles.actionText}>Update draft</Text></Pressable> : null}
            </View>
          ) : null}

          {phase === "confirm" && parsed && (() => {
            const isDestructive = validatedAction?.ok === true && validatedAction.action.isDestructive === true;
            return (
            <View style={styles.draft} testID="voice-draft">
              <Text style={styles.draftLabel}>Draft {parsed.intent?.replace("_", " ")}</Text>
              <Text style={styles.draftSummary}>{parsed.summary}</Text>
              <View style={styles.draftGrid}>
                {parsed.amount != null && <DKV k="Amount" v={fmt(parsed.amount, parsed.currency || "USD")} theme={theme} />}
                {parsed.date && <DKV k="Date" v={parsed.date} theme={theme} />}
                {parsed.supplierName && <DKV k="Supplier" v={parsed.supplierName} theme={theme} />}
                {parsed.customerName && <DKV k="Customer" v={parsed.customerName} theme={theme} />}
                {parsed.partnerName && <DKV k="Capital Account" v={parsed.partnerName} theme={theme} />}
                {parsed.paymentType && <DKV k="Type" v={parsed.paymentType} theme={theme} />}
                {parsed.receiptMode && <DKV k="Receipt type" v={parsed.receiptMode === "against_invoice" ? "Against invoice" : parsed.receiptMode === "advance" ? "Customer advance" : "Cash sale"} theme={theme} />}
                {parsed.method && <DKV k="Payment method" v={parsed.method === "upi" ? "mobile / UPI" : parsed.method} theme={theme} />}
              </View>
              {isDestructive ? (
                <View style={styles.destructiveWarn} testID="voice-destructive-warn">
                  <Ionicons name="warning" size={16} color={theme.color.error} />
                  <Text style={styles.destructiveWarnText}>This closes the period permanently — it cannot be undone.</Text>
                </View>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <Pressable testID="btn-voice-cancel" onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                  <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Try Again</Text>
                </Pressable>
                <Pressable testID="btn-voice-confirm" onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: isDestructive ? theme.color.error : theme.color.brandPrimary, flex: 1.4 }]}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>{isDestructive ? "Close Books" : "Confirm & Save"}</Text>}
                </Pressable>
              </View>
            </View>
            );
          })()}

          {error ? (
            <View style={styles.errorBox}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Ionicons name="alert-circle" size={18} color={theme.color.error} /><Text style={styles.errorText} testID="voice-error">{error}</Text></View>
              {pendingClarification ? <><TextInput testID="voice-follow-up-input" accessibilityLabel="Voice follow-up answer" value={followUpAnswer} onChangeText={setFollowUpAnswer} placeholder="Your answer" placeholderTextColor={theme.color.muted} style={[styles.transcript, { backgroundColor: theme.color.surface, borderRadius: theme.radius.sm, padding: theme.spacing.sm }]} /><Pressable testID="btn-voice-follow-up" accessibilityRole="button" onPress={() => void continueDraft()} style={[styles.actionBtn, { marginTop: 8 }]}><Text style={styles.actionText}>Continue draft</Text></Pressable></> : null}
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
  errorBox: { gap: 8, padding: theme.spacing.md, backgroundColor: "#FBE8E5", borderRadius: theme.radius.md, marginTop: theme.spacing.md },
  errorText: { color: theme.color.error, fontSize: 13, flex: 1 },
  destructiveWarn: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: "#FBE8E5", borderRadius: theme.radius.md, marginTop: theme.spacing.md, borderWidth: 1, borderColor: theme.color.error },
  destructiveWarnText: { color: theme.color.error, fontSize: 13, flex: 1, fontWeight: "600" },
}); }
