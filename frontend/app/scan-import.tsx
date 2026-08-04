import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, TextInput, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/db/local";
import { Card } from "@/src/components/UI";
import {
  mapAnalyzedDocument,
  normalizeScanDate,
  isValidScanAmount,
  AMOUNT_BOUNDS_REASON,
  DATE_BOUNDS_REASON,
  type ScanRow,
  type FlaggedScanRow,
} from "@/src/accountingV2/scanImport";
import { normalizeDateInput, isValidDateString } from "@/src/utils/dateValidation";

// Source tag prefixed onto every note/memo this screen writes (same convention
// as [AI] on ask.tsx and [Reconcile] on reconcile.tsx).
const SCAN_TAG = "[Scan]";
const scanNote = (base?: string) => `${SCAN_TAG} ${base || "Imported from document"}`.trim();

// Hard cap on the base64 payload we send to the AI provider (~8MB of base64).
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

type RowStatus = { state: "created" | "failed"; message: string };
type ReviewRow = {
  id: number;
  row: ScanRow;
  checked: boolean;
  importable: boolean;
  infoReason?: string; // set on non-importable info rows (e.g. partner manual step)
  amountText: string;
  stockText: string; // opening-balances row only
  dateText: string;
  partyText: string; // party name / asset name / liability name / partner name
  status?: RowStatus;
};

function rowTitle(row: ScanRow): string {
  switch (row.kind) {
    case "transaction": {
      const labels: Record<string, string> = {
        sale: "Sale", purchase_bill: "Purchase (bill)", receipt_in: "Money received",
        payment_out: "Payment out", expense: "Expense",
      };
      return labels[row.entryType] || row.entryType;
    }
    case "opening_balances": return "Opening balances (cash + stock)";
    case "asset": return "Asset";
    case "liability": return "Liability";
    case "partner": return "Partner capital";
  }
}

export default function ScanImport() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [phase, setPhase] = useState<"pick" | "busy" | "review" | "done">("pick");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const [docType, setDocType] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [flagged, setFlagged] = useState<FlaggedScanRow[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [currencySymbol, setCurrencySymbol] = useState("$");
  const [doneCounts, setDoneCounts] = useState({ created: 0, failed: 0, manual: 0 });

  React.useEffect(() => {
    api.getSettings().then((s: any) => setCurrencySymbol(getCurrencySymbol(s.currency || "USD"))).catch(() => {});
  }, []);

  const friendlyError = (e: any): string => {
    const message = String(e?.message || "Analysis failed");
    if (/api key/i.test(message)) return "No AI key configured. Open Settings → AI Provider and add your API key, then try again.";
    if (/network request failed|failed to fetch|timed out/i.test(message)) return "Could not reach the AI provider — you may be offline. Check your connection and try again.";
    return message;
  };

  const analyze = async (input: { base64?: string; mimeType?: string; text?: string }) => {
    if (input.base64 && input.base64.length > MAX_BASE64_CHARS) {
      setError("That file is too large (over ~8MB). Try a smaller photo, a lower-resolution scan, or paste the text instead.");
      return;
    }
    setError(""); setPhase("busy");
    try {
      const [raw, settings] = await Promise.all([api.analyzeDocument(input), api.getSettings().catch(() => ({}))]);
      const mapped = mapAnalyzedDocument(raw);
      const partnership = (settings as any)?.accountingStyle === "retail_partnership";
      let investors: Array<{ id: string; name: string }> = [];
      if (partnership) { try { investors = await api.listInvestors(); } catch { investors = []; } }
      const reviewRows: ReviewRow[] = mapped.validRows.map((row, index) => {
        let importable = true;
        let infoReason: string | undefined;
        if (row.kind === "partner") {
          const match = investors.find((inv) => inv.name.trim().toLowerCase() === row.name.trim().toLowerCase());
          if (!match) {
            importable = false;
            infoReason = partnership
              ? `Manual step: no investor named "${row.name}" exists yet — add them on the Investors screen, then record their capital there.`
              : `Manual step: partner capital can only be recorded in Partnership Mode. Note ${row.name}'s stake and set it up in Settings.`;
          }
        }
        return {
          id: index,
          row,
          checked: importable,
          importable,
          infoReason,
          amountText: String(row.kind === "transaction" ? row.amount : row.kind === "opening_balances" ? row.openingCash : row.kind === "partner" ? row.capital : row.amount),
          stockText: row.kind === "opening_balances" ? String(row.stockValue) : "",
          dateText: row.kind === "transaction" ? row.date : row.kind === "opening_balances" ? row.asOfDate : row.date,
          partyText: row.kind === "transaction" ? row.partyName : row.kind === "opening_balances" ? "" : row.name,
        };
      });
      setDocType(mapped.docType);
      setSummary(mapped.summary);
      setRows(reviewRows);
      setFlagged(mapped.flaggedRows);
      setPhase("review");
    } catch (e: any) {
      setError(friendlyError(e));
      setPhase("pick");
    }
  };

  const scanCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission denied"); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await analyze({ base64: res.assets[0].base64, mimeType: res.assets[0].mimeType || "image/jpeg" });
  };

  const pickGallery = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError("Gallery permission denied"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    await analyze({ base64: res.assets[0].base64, mimeType: res.assets[0].mimeType || "image/jpeg" });
  };

  const pickPdf = async () => {
    try {
      const DocumentPicker = await import("expo-document-picker");
      const FileSystem = await import("expo-file-system");
      const res = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const file = new FileSystem.File(res.assets[0].uri);
      const b64 = file.base64Sync();
      await analyze({ base64: b64, mimeType: "application/pdf" });
    } catch (e: any) {
      setError(e?.message || "Could not read PDF");
    }
  };

  const analyzeText = async () => {
    const text = pasteText.trim();
    if (!text) { setError("Paste some document text first."); return; }
    await analyze({ text });
  };

  const updateRow = (id: number, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Re-validate an edited row's fields at import time. Returns an error reason
  // or null when safe. All amounts go through the shared AI caps and every date
  // through normalizeDateInput before anything is written.
  const rowProblem = (r: ReviewRow): string | null => {
    const normalized = normalizeDateInput(r.dateText);
    if (!isValidDateString(normalized) || !normalizeScanDate(normalized)) return DATE_BOUNDS_REASON;
    if (r.row.kind === "opening_balances") {
      const cash = Number(r.amountText);
      const stock = Number(r.stockText);
      const okBal = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1_000_000_000;
      if (!okBal(cash) || !okBal(stock)) return AMOUNT_BOUNDS_REASON;
      if (cash === 0 && stock === 0) return "Enter an opening cash or stock value";
      return null;
    }
    if (!isValidScanAmount(Number(r.amountText))) return AMOUNT_BOUNDS_REASON;
    if ((r.row.kind === "asset" || r.row.kind === "liability" || r.row.kind === "partner") && !r.partyText.trim()) return "Name is required";
    return null;
  };

  // Execute ONE confirmed, validated row through the existing api surface.
  const writeRow = async (r: ReviewRow) => {
    const date = normalizeScanDate(normalizeDateInput(r.dateText))!;
    const amount = Number(r.amountText);
    const party = r.partyText.trim();
    const row = r.row;
    if (row.kind === "transaction") {
      const notes = scanNote(row.notes || rowTitle(row));
      switch (row.entryType) {
        case "sale":
          await api.createSale({ amount, date, paymentType: row.method, notes });
          return;
        case "purchase_bill":
          await api.createBill({ supplierName: party || "Unknown supplier", amount, date, paymentType: row.method, notes });
          return;
        case "receipt_in": {
          if (party) {
            const customer = await api.findOrCreateParty(party, "customer");
            if (!customer) throw new Error(`Could not find or create customer "${party}"`);
            await api.createReceipt({ mode: "advance", debtorId: customer.id, clientName: customer.name, amount, date, method: "cash", notes });
          } else {
            await api.createReceipt({ mode: "cash_sale", amount, date, method: "cash", clientName: "", notes });
          }
          return;
        }
        case "payment_out": {
          const supplier = await api.findOrCreateParty(party || "Unknown supplier", "supplier");
          if (!supplier) throw new Error(`Could not find or create supplier "${party}"`);
          await api.createPayment({ date, amount, currency: "USD", type: "supplier_payment", supplierId: supplier.id, method: "cash", notes });
          return;
        }
        case "expense":
          await api.createExpense({ category: "General", amount, date, notes: scanNote(party ? `${party}${row.notes ? " — " + row.notes : ""}` : row.notes) });
          return;
      }
    }
    if (row.kind === "opening_balances") {
      await api.updateV2OpeningBalances({ date, cash: amount, inventory: Number(r.stockText), memo: scanNote("Imported opening balances") });
      return;
    }
    if (row.kind === "asset") {
      await api.createManualAsset({ date, name: party, amount, funding: "capital", notes: scanNote("Imported asset") });
      return;
    }
    if (row.kind === "liability") {
      await api.createManualLiability({ date, name: party, amount, recognition: "asset", notes: scanNote("Imported liability") });
      return;
    }
    if (row.kind === "partner") {
      const investors = await api.listInvestors();
      const match = investors.find((inv) => inv.name.trim().toLowerCase() === party.toLowerCase());
      if (!match) throw new Error(`No investor named "${party}" — add them on the Investors screen first`);
      await api.depositInvestorCapital(match.id, { amount, date, notes: scanNote(`Capital stake for ${match.name}`) });
      return;
    }
  };

  const selected = rows.filter((r) => r.checked && r.importable);

  const runImport = async () => {
    setImporting(true); setError("");
    let created = 0; let failed = 0;
    const next = [...rows];
    for (const r of next) {
      if (!r.checked || !r.importable) continue;
      const problem = rowProblem(r);
      if (problem) { r.status = { state: "failed", message: problem }; failed++; continue; }
      try {
        await writeRow(r);
        r.status = { state: "created", message: "Created" };
        created++;
      } catch (e: any) {
        r.status = { state: "failed", message: e?.message || "Failed" };
        failed++;
      }
      setRows([...next]);
    }
    setRows([...next]);
    setDoneCounts({ created, failed, manual: rows.filter((x) => !x.importable).length });
    setImporting(false);
    setPhase("done");
  };

  const confirmImport = () => {
    if (selected.length === 0) return;
    const total = selected.reduce((sum, r) => sum + (Number(r.amountText) || 0) + (r.row.kind === "opening_balances" ? Number(r.stockText) || 0 : 0), 0);
    Alert.alert(
      `Import ${selected.length} selected?`,
      `${selected.length} entr${selected.length === 1 ? "y" : "ies"} will be written to your books (total value ${fmt(total, currencySymbol)}). Each record is tagged ${SCAN_TAG} so you can find it later.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: `Import ${selected.length}`, isPreferred: true, onPress: runImport },
      ],
    );
  };

  const transactionsRows = rows.filter((r) => r.row.kind === "transaction");
  const setupRows = rows.filter((r) => r.row.kind !== "transaction");

  const renderRow = (r: ReviewRow) => {
    const problem = r.importable ? rowProblem(r) : null;
    const border = !r.importable ? theme.color.muted : problem ? theme.color.error : theme.color.brandPrimary;
    return (
      <View key={r.id} style={[styles.row, { borderLeftColor: border }]} testID={`scan-row-${r.id}`}>
        <View style={styles.rowHeader}>
          <Pressable
            testID={`scan-check-${r.id}`}
            disabled={!r.importable || !!problem || importing || phase === "done"}
            onPress={() => updateRow(r.id, { checked: !r.checked })}
            style={styles.checkWrap}
          >
            <Ionicons
              name={!r.importable ? "information-circle-outline" : problem ? "close-circle" : r.checked ? "checkbox" : "square-outline"}
              size={22}
              color={!r.importable ? theme.color.muted : problem ? theme.color.error : r.checked ? theme.color.brandPrimary : theme.color.muted}
            />
          </Pressable>
          <Text style={styles.rowTitle}>{rowTitle(r.row)}</Text>
          {r.status ? (
            <Text style={[styles.statusText, { color: r.status.state === "created" ? theme.color.success : theme.color.error }]}>
              {r.status.state === "created" ? "✓ Created" : "✗ Failed"}
            </Text>
          ) : null}
        </View>
        {r.infoReason ? <Text style={styles.infoText}>{r.infoReason}</Text> : null}
        {r.importable ? (
          <View style={styles.fieldRow}>
            {r.row.kind !== "opening_balances" ? (
              <View style={{ flex: 1.2 }}>
                <Text style={styles.fieldLabel}>{r.row.kind === "transaction" ? "Party" : "Name"}</Text>
                <TextInput
                  value={r.partyText}
                  editable={!importing && phase !== "done"}
                  onChangeText={(t) => updateRow(r.id, { partyText: t })}
                  placeholder={r.row.kind === "transaction" ? "Optional" : "Name"}
                  placeholderTextColor={theme.color.muted}
                  style={styles.fieldInput}
                />
              </View>
            ) : null}
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>{r.row.kind === "opening_balances" ? "Cash" : "Amount"}</Text>
              <TextInput
                value={r.amountText}
                editable={!importing && phase !== "done"}
                onChangeText={(t) => updateRow(r.id, { amountText: t })}
                keyboardType="decimal-pad"
                placeholderTextColor={theme.color.muted}
                style={styles.fieldInput}
              />
            </View>
            {r.row.kind === "opening_balances" ? (
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Stock</Text>
                <TextInput
                  value={r.stockText}
                  editable={!importing && phase !== "done"}
                  onChangeText={(t) => updateRow(r.id, { stockText: t })}
                  keyboardType="decimal-pad"
                  placeholderTextColor={theme.color.muted}
                  style={styles.fieldInput}
                />
              </View>
            ) : null}
            <View style={{ flex: 1.1 }}>
              <Text style={styles.fieldLabel}>Date</Text>
              <TextInput
                value={r.dateText}
                editable={!importing && phase !== "done"}
                onChangeText={(t) => updateRow(r.id, { dateText: t })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.color.muted}
                style={styles.fieldInput}
              />
            </View>
          </View>
        ) : null}
        {problem ? <Text style={styles.flaggedText}>⚠ {problem}</Text> : null}
        {r.status?.state === "failed" ? <Text style={styles.flaggedText}>⚠ {r.status.message}</Text> : null}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back-scan" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Scan &amp; Import</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        {phase === "pick" && (
          <>
            <Card>
              <Text style={styles.name}>Import any business document</Text>
              <Text style={styles.hint}>
                Photograph or upload a receipt, supplier statement, transaction list, or a closing report from another accounting
                app. AI proposes the entries and opening balances; you review and import only what you want. Nothing is saved
                without your confirmation.
              </Text>
              <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md }}>
                <Pressable testID="btn-scan-doc" onPress={scanCamera} style={[styles.actionBtn, { flex: 1 }]}>
                  <Ionicons name="camera-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>Camera</Text>
                </Pressable>
                <Pressable testID="btn-gallery-doc" onPress={pickGallery} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandSecondary }]}>
                  <Ionicons name="image-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>Gallery</Text>
                </Pressable>
                <Pressable testID="btn-pdf-doc" onPress={pickPdf} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandTertiary || theme.color.brandSecondary }]}>
                  <Ionicons name="document-outline" size={18} color="#fff" />
                  <Text style={styles.actionText}>PDF</Text>
                </Pressable>
              </View>
            </Card>
            <Card style={{ marginTop: theme.spacing.md }}>
              <Text style={styles.section2}>Or paste document text</Text>
              <TextInput
                testID="scan-paste-input"
                value={pasteText}
                onChangeText={setPasteText}
                placeholder="Paste the report / statement text here…"
                placeholderTextColor={theme.color.muted}
                multiline
                style={styles.pasteBox}
              />
              <Pressable testID="btn-analyze-text" onPress={analyzeText} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                <Ionicons name="sparkles-outline" size={18} color="#fff" />
                <Text style={styles.actionText}>Analyze text</Text>
              </Pressable>
            </Card>
          </>
        )}

        {phase === "busy" && (
          <View style={{ alignItems: "center", padding: theme.spacing.xl }}>
            <ActivityIndicator color={theme.color.brandPrimary} size="large" />
            <Text style={styles.hint}>AI is analyzing the document…</Text>
          </View>
        )}

        {error ? <Text style={styles.error} testID="scan-error">{error}</Text> : null}

        {(phase === "review" || phase === "done") && (
          <>
            <Card testID="scan-summary">
              <Text style={styles.section2}>AI read this as: {docType.replace(/_/g, " ")}</Text>
              <Text style={styles.hint}>{summary || "No description provided."}</Text>
            </Card>

            {rows.length === 0 && flagged.length === 0 ? (
              <Card style={{ marginTop: theme.spacing.md }}>
                <Text style={styles.hint} testID="scan-empty">
                  No importable entries were found in this document. Try a clearer photo, or paste the text instead.
                </Text>
                <Pressable onPress={() => { setPhase("pick"); setError(""); }} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                  <Text style={styles.actionText}>Try another document</Text>
                </Pressable>
              </Card>
            ) : null}

            {transactionsRows.length > 0 ? (
              <>
                <Text style={styles.section}>Transactions ({transactionsRows.length})</Text>
                {transactionsRows.map(renderRow)}
              </>
            ) : null}

            {setupRows.length > 0 ? (
              <>
                <Text style={styles.section}>Book setup ({setupRows.length})</Text>
                {setupRows.map(renderRow)}
              </>
            ) : null}

            {flagged.length > 0 ? (
              <>
                <Text style={styles.section}>Flagged — cannot be imported ({flagged.length})</Text>
                {flagged.map((f, i) => (
                  <View key={i} style={[styles.row, { borderLeftColor: theme.color.error }]} testID={`scan-flagged-${i}`}>
                    <View style={styles.rowHeader}>
                      <Ionicons name="close-circle" size={20} color={theme.color.error} />
                      <Text style={styles.rowTitle}>{f.label}</Text>
                    </View>
                    <Text style={styles.flaggedText}>⚠ {f.reason}</Text>
                  </View>
                ))}
              </>
            ) : null}

            {phase === "done" ? (
              <Card style={{ marginTop: theme.spacing.lg }} testID="scan-done-card">
                <Text style={styles.section2}>Import finished</Text>
                <Text style={styles.hint}>
                  {doneCounts.created} created · {doneCounts.failed} failed
                  {doneCounts.manual > 0 ? ` · ${doneCounts.manual} manual step${doneCounts.manual === 1 ? "" : "s"} (see info rows above)` : ""}
                </Text>
                <Pressable testID="btn-scan-done" onPress={() => router.back()} style={[styles.actionBtn, { marginTop: theme.spacing.md }]}>
                  <Text style={styles.actionText}>Done</Text>
                </Pressable>
              </Card>
            ) : rows.length > 0 ? (
              <Pressable
                testID="btn-import-selected"
                onPress={confirmImport}
                disabled={importing || selected.length === 0}
                style={[styles.actionBtn, { marginTop: theme.spacing.lg }, (importing || selected.length === 0) && { opacity: 0.5 }]}
              >
                {importing ? <ActivityIndicator color="#fff" /> : <Ionicons name="cloud-upload-outline" size={18} color="#fff" />}
                <Text style={styles.actionText}>{importing ? "Importing…" : `Import ${selected.length} selected`}</Text>
              </Pressable>
            ) : null}
          </>
        )}
        {Platform.OS === "web" ? <View style={{ height: 24 }} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    name: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface },
    hint: { fontSize: 13, color: theme.color.muted, marginTop: 6, lineHeight: 18 },
    actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
    section2: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    pasteBox: {
      marginTop: theme.spacing.md, minHeight: 110, textAlignVertical: "top",
      borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.md,
      padding: theme.spacing.md, color: theme.color.onSurface, fontSize: 13, backgroundColor: theme.color.surface,
    },
    row: {
      backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md,
      borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
      borderLeftWidth: 4, marginBottom: theme.spacing.sm,
    },
    rowHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    checkWrap: { padding: 2 },
    rowTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface, flex: 1 },
    statusText: { fontSize: 12, fontWeight: "700" },
    infoText: { fontSize: 12, color: theme.color.muted, marginTop: 6, lineHeight: 17 },
    fieldRow: { flexDirection: "row", gap: 8, marginTop: theme.spacing.sm },
    fieldLabel: { fontSize: 11, fontWeight: "600", color: theme.color.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 },
    fieldInput: {
      borderWidth: 1, borderColor: theme.color.border, borderRadius: theme.radius.sm,
      paddingHorizontal: 8, paddingVertical: 6, fontSize: 13, color: theme.color.onSurface,
      backgroundColor: theme.color.surface,
    },
    flaggedText: { color: theme.color.error, fontSize: 11, marginTop: 6, fontWeight: "600" },
  });
}
