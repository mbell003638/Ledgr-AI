import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView, Platform, KeyboardAvoidingView, Keyboard, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAudioRecorder, RecordingPresets } from "expo-audio";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { executeAssistantProposal, type AssistantProposalValidationResult } from "@/src/accountingV2/aiActions";
import { resolveVoicePartyCommand } from "@/src/accountingV2/voicePartyResolution";
import { buildVoiceTransactionDraft } from "@/src/accountingV2/voiceTransactionDraft";

import { captureVoiceRecording, cancelVoiceRecorder, startVoiceRecorder } from "@/src/utils/voiceRecorder";
import { VoiceOrb } from "@/src/components/VoiceOrb";

import { localTodayIso } from "@/src/utils/dateValidation";

type Phase = "idle" | "recording" | "processing" | "confirm" | "error";

// Source tag prefixed onto notes/memo of records created via voice (fix M-5).
const voiceNote = (note?: string) => `[Voice] ${note || ""}`.trim();

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
  const [validatedAction, setValidatedAction] = useState<AssistantProposalValidationResult | null>(null);


  const buildVoiceDraft = async (txt: string) => {
    const parsedCommand = await api.parseCommand(txt);
    const [suppliers, customers, capitalAccounts] = await Promise.all([
      api.listSuppliers(),
      api.listDebtors(),
      api.listInvestors(),
    ]);
    const resolution = resolveVoicePartyCommand(parsedCommand, txt, { suppliers, customers, capitalAccounts });
    if (!resolution.ok) throw new Error(resolution.question);
    return buildVoiceTransactionDraft(resolution.command);
  };

  const start = async () => {
    setError(""); setTranscript(""); setParsed(null);
    try {
      const config = await api.getAIConfig();
      if (!config.apiKey.trim()) throw new Error("Add an AI API key in Advanced Settings before using voice input.");
      await startVoiceRecorder(recorder);
      setPhase("recording");
    } catch (e: any) { setError(e.message || "Could not start the microphone."); setPhase("error"); }
  };

  const stopAndProcess = async () => {
    setPhase("processing");
    try {
      const captured = await captureVoiceRecording(recorder);
      const t = await api.transcribe(captured.audioBase64, captured.mime);
      const txt = (t.transcript || "").trim();
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
    if (!txt) { setError("Enter or dictate a transaction before rebuilding the draft."); return; }
    setError(""); setPhase("processing");
    try {
      const draft = await buildVoiceDraft(txt);
      setParsed(draft.parsed);
      setValidatedAction(draft.validation);
      setPhase("confirm");
    } catch (e: any) {
      setError(e.message || "Could not rebuild the draft from that transcript.");
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
    void cancelVoiceRecorder(recorder);
    setPhase("idle"); setTranscript(""); setParsed(null); setValidatedAction(null); setError("");
  };

  useEffect(() => () => { void cancelVoiceRecorder(recorder); }, [recorder]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-voice" accessibilityRole="button" accessibilityLabel="Close voice assistant" onPress={() => { void cancelVoiceRecorder(recorder); router.back(); }}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>AI Voice Assistant</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <Card>
          <Text style={styles.title}>Say a transaction</Text>
          <Text style={styles.hint}>
            {'e.g., "We paid supplier 1000 USD on July 17", "Sold 250 today", "Withdrew 500 for owner"'}
          </Text>

          <View style={styles.micArea}>
            {phase === "recording" ? (
              <Pressable testID="btn-stop-voice" accessibilityRole="button" accessibilityLabel="Stop recording and process voice note" onPress={stopAndProcess}>
                <VoiceOrb phase="recording" theme={theme} />
              </Pressable>
            ) : phase === "processing" ? (
              <VoiceOrb phase="processing" theme={theme} />
            ) : (
              <Pressable testID="btn-start-voice" accessibilityRole="button" accessibilityLabel="Start voice recording" accessibilityHint="Records a transaction description for review" onPress={start}>
                <VoiceOrb phase="idle" theme={theme} />
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
              <Text style={styles.transcriptLabel}>Transcript — edit before saving</Text>
              <TextInput accessibilityLabel="Editable voice transcript" testID="voice-transcript-input" value={transcript} onChangeText={setTranscript} multiline autoCorrect onSubmitEditing={Keyboard.dismiss} style={styles.transcriptInput} placeholderTextColor={theme.color.muted} />
              {phase === "confirm" || phase === "error" ? <Pressable testID="btn-rebuild-voice-draft" accessibilityRole="button" accessibilityLabel="Update draft from edited transcript" onPress={() => void rebuildDraft()} style={styles.rebuildBtn}><Text style={styles.rebuildText}>Update draft</Text></Pressable> : null}
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
                {parsed.method && <DKV k="Payment method" v={parsed.method === "upi" ? "mobile / UPI" : parsed.method} theme={theme} />}
              </View>
              {isDestructive ? (
                <View style={styles.destructiveWarn} testID="voice-destructive-warn">
                  <Ionicons name="warning" size={16} color={theme.color.error} />
                  <Text style={styles.destructiveWarnText}>This closes the period permanently — it cannot be undone.</Text>
                </View>
              ) : null}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <Pressable testID="btn-voice-cancel" accessibilityRole="button" accessibilityLabel="Discard draft and try again" onPress={reset} style={[styles.actionBtn, { backgroundColor: theme.color.surfaceTertiary }]}>
                  <Text style={[styles.actionText, { color: theme.color.onSurface }]}>Try Again</Text>
                </Pressable>
                <Pressable testID="btn-voice-confirm" accessibilityRole="button" accessibilityLabel={isDestructive ? "Confirm close books" : "Confirm and save transaction"} accessibilityHint={isDestructive ? "Permanently closes the accounting period" : "Posts the reviewed transaction to the ledger"} onPress={confirmSave} disabled={saving} style={[styles.actionBtn, { backgroundColor: isDestructive ? theme.color.error : theme.color.brandPrimary, flex: 1.4 }]}>
                  {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.actionText}>{isDestructive ? "Close Books" : "Confirm & Save"}</Text>}
                </Pressable>
              </View>
            </View>
            );
          })()}

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={18} color={theme.color.error} />
              <View style={{ flex: 1, gap: 7 }}>
                <Text style={styles.errorText} testID="voice-error">{error}</Text>
                {/API key|Anthropic|Base URL|Advanced Settings/i.test(error) ? <Pressable testID="voice-open-provider-settings" accessibilityRole="button" accessibilityLabel="Open AI provider settings" onPress={() => router.push('/advanced-settings?section=ai-provider' as any)}><Text style={styles.setupLink}>Open AI provider settings</Text></Pressable> : null}
              </View>
            </View>
          ) : null}
        </Card>
        <View style={{ height: 40 }} />
      </ScrollView>
      </KeyboardAvoidingView>
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
  keyboard: { flex: 1 },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  scroll: { padding: theme.spacing.lg },
  title: { fontSize: 18, fontWeight: "700", color: theme.color.onSurface },
  hint: { fontSize: 13, color: theme.color.muted, marginTop: 6 },
  micArea: { alignItems: "center", paddingVertical: theme.spacing.xl, gap: 12 },
  micBtn: { width: 96, height: 96, borderRadius: 48, backgroundColor: theme.color.brandPrimary, justifyContent: "center", alignItems: "center", ...(Platform.OS === "web" ? { boxShadow: "0 6px 24px rgba(0,0,0,0.18)" } : { shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.2, shadowRadius: 12, elevation: 8 }) },
  micRecording: { backgroundColor: theme.color.error },
  micLabel: { color: theme.color.muted, fontSize: 13, fontWeight: "500" },
  transcriptBox: { marginTop: 8, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md },
  transcriptLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
  transcript: { fontSize: 14, color: theme.color.onSurface, marginTop: 4, fontStyle: "italic" },
  transcriptInput: { minHeight: 74, color: theme.color.onSurface, fontSize: 14, lineHeight: 20, marginTop: 6, padding: 10, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, textAlignVertical: "top" },
  rebuildBtn: { alignSelf: "flex-start", marginTop: 9, paddingVertical: 8, paddingHorizontal: 12, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.brandPrimary },
  rebuildText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 12 },
  draft: { marginTop: theme.spacing.md, padding: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.color.brandTertiary },
  draftLabel: { fontSize: 11, color: theme.color.brandPrimary, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  draftSummary: { fontSize: 15, color: theme.color.onSurface, fontWeight: "600", marginTop: 6 },
  draftGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  actionBtn: { flex: 1, padding: 12, borderRadius: theme.radius.md, alignItems: "center", justifyContent: "center" },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: "#FBE8E5", borderRadius: theme.radius.md, marginTop: theme.spacing.md },
  errorText: { color: theme.color.error, fontSize: 13, flex: 1 },
  setupLink: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "800" },
  destructiveWarn: { flexDirection: "row", alignItems: "center", gap: 8, padding: theme.spacing.md, backgroundColor: "#FBE8E5", borderRadius: theme.radius.md, marginTop: theme.spacing.md, borderWidth: 1, borderColor: theme.color.error },
  destructiveWarnText: { color: theme.color.error, fontSize: 13, flex: 1, fontWeight: "600" },
}); }
