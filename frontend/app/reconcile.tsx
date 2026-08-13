import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Image, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { getCurrencySymbol } from "@/src/utils/currency";
import { Card } from "@/src/components/UI";
import { validateReconcileEntry } from "@/src/accountingV2/aiActions";

export default function Reconcile() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { supplierId, customerId } = useLocalSearchParams<{ supplierId?: string; customerId?: string }>();
  const party: "supplier" | "customer" = customerId ? "customer" : "supplier";
  const partyId = customerId || supplierId;
  const [supplier, setSupplier] = useState<any>(null);
  const [photo, setPhoto] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [currencySymbol, setCurrencySymbol] = useState("$");

  useEffect(() => {
    if (party === "customer" && customerId) {
      api.listDebtors().then((list: any[]) => setSupplier(list.find((d) => d.id === customerId) || null)).catch(() => {});
    } else if (supplierId) {
      api.getSupplier(supplierId).then(setSupplier).catch(() => {});
    }
  }, [supplierId, customerId, party]);

  useEffect(() => {
    api.getSettings().then((s: any) => setCurrencySymbol(getCurrencySymbol(s.currency || "USD"))).catch(() => {});
  }, []);

  const runReconcile = async (base64: string, mime: string) => {
    setBusy(true); setError(""); setResult(null);
    try {
      const r = await api.reconcileStatement(base64, partyId!, mime, party);
      setResult(r);
    } catch (e: any) {
      setError(e.message || "Failed");
    } finally { setBusy(false); }
  };

  const scan = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission denied"); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    setPhoto(res.assets[0].base64!);
    await runReconcile(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };

  const upload = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError("Gallery permission denied"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    setPhoto(res.assets[0].base64!);
    await runReconcile(res.assets[0].base64!, res.assets[0].mimeType || "image/jpeg");
  };

  const uploadPdf = async () => {
    try {
      const DocumentPicker = await import("expo-document-picker");
      const FileSystem = await import("expo-file-system");
      const res = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const uri = res.assets[0].uri;
      const file = new FileSystem.File(uri);
      const b64 = file.base64Sync();
      setPhoto("");
      await runReconcile(b64, "application/pdf");
    } catch (e: any) {
      setError(e.message || "Could not read PDF");
    }
  };

  // Human label for an extracted entry (customer vs supplier semantics differ).
  const entryLabel = (e: any): string => {
    if (party === "customer") return e.type === "payment" ? "Receipt (customer payment)" : "Invoice (owed by customer)";
    return e.type === "payment" ? "Supplier payment" : "Bill (purchase)";
  };

  // Prefix source-tag onto whatever note the entry already carries (fix M-5).
  const reconNote = (base: string) => `[Reconcile] ${base || "From reconciliation"}`;

  // Pure writer for one extracted entry — performs the ledger write ONLY. Callers
  // must have already validated bounds and obtained explicit confirmation.
  const writeEntry = async (e: any) => {
    if (!partyId) throw new Error("Missing party");
    if (party === "customer") {
      // Customer statement: a "bill" line = an invoice they owe; a "payment"
      // line = money they paid (record as an advance receipt).
      if (e.type === "payment") {
        await api.createReceipt({
          mode: "advance", amount: e.amount, date: e.date, method: "cash",
          debtorId: partyId, clientName: supplier?.name || "",
          notes: reconNote(e.description),
        });
      } else {
        await api.createInvoice({
          clientName: supplier?.name || "Customer",
          lines: [{ description: e.description || "From reconciliation", qty: 1, rate: e.amount }],
          taxRate: 0, total: e.amount, date: e.date, notes: reconNote(e.reference),
        });
      }
      return;
    }
    if (e.type === "bill" || !e.type) {
      await api.createBill({
        supplierId: partyId, date: e.date, amount: e.amount, currency: "USD",
        paymentType: "credit", invoiceNo: e.reference || "", notes: reconNote(e.description),
      });
    } else {
      await api.createPayment({
        date: e.date, amount: e.amount, currency: "USD",
        type: "supplier_payment", supplierId: partyId, method: "cash",
        reference: e.reference || "", notes: reconNote(e.description),
      });
    }
  };

  const refresh = async () => {
    if (!partyId) return;
    const r = await api.reconcileStatement(photo, partyId, "image/jpeg", party);
    setResult(r);
  };

  // Single "+ Add": preview type / party / date / formatted amount, Cancel first,
  // Confirm styled default. Invalid rows never reach here (button is disabled).
  const confirmAndImportOne = (e: any) => {
    if (!partyId) return;
    const reason = validateReconcileEntry(e);
    if (reason) { setError(reason); return; }
    const partyName = supplier?.name || (party === "customer" ? "Customer" : "Supplier");
    const preview =
      `Type: ${entryLabel(e)}\n` +
      `Business account: ${partyName}\n` +
      `Date: ${e.date}\n` +
      `Amount: ${fmt(e.amount, currencySymbol)}`;
    Alert.alert(
      "Import this entry?",
      preview,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          isPreferred: true,
          onPress: async () => {
            setError(""); setImporting(true);
            try {
              await writeEntry(e);
              await refresh();
            } catch (err: any) {
              setError(err?.message || "Failed to import entry");
            } finally { setImporting(false); }
          },
        },
      ],
    );
  };

  // "Import all": summary confirm listing count + total of the VALID entries, then
  // sequential writes with per-item error collection. Invalid rows are skipped.
  const confirmAndImportAll = () => {
    if (!partyId) return;
    const all: any[] = result?.missingInLedgr || [];
    const valid = all.filter((e) => validateReconcileEntry(e) === null);
    const skipped = all.length - valid.length;
    if (valid.length === 0) {
      Alert.alert("Nothing to import", skipped > 0 ? `All ${skipped} entr${skipped === 1 ? "y is" : "ies are"} flagged as invalid and cannot be imported.` : "There are no entries to import.");
      return;
    }
    const total = valid.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const lines = valid
      .map((e) => `• ${e.date} — ${fmt(e.amount, currencySymbol)} (${entryLabel(e)})`)
      .join("\n");
    const preview =
      `${valid.length} entr${valid.length === 1 ? "y" : "ies"}, total ${fmt(total, currencySymbol)}` +
      (skipped > 0 ? `\n(${skipped} invalid entr${skipped === 1 ? "y" : "ies"} will be skipped)` : "") +
      `\n\n${lines}`;
    Alert.alert(
      "Import all entries?",
      preview,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: `Import ${valid.length}`,
          isPreferred: true,
          onPress: async () => {
            setError(""); setImporting(true);
            const failures: string[] = [];
            for (const e of valid) {
              try {
                await writeEntry(e);
              } catch (err: any) {
                failures.push(`${e.date} ${fmt(e.amount, currencySymbol)}: ${err?.message || "failed"}`);
              }
            }
            try { await refresh(); } catch { /* refresh best-effort */ }
            setImporting(false);
            if (failures.length) {
              setError(`Imported ${valid.length - failures.length} of ${valid.length}. Failed: ${failures.join("; ")}`);
            }
          },
        },
      ],
    );
  };

  const stmtTotal = result?.extracted?.totalOnStatement;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-back-recon" onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Reconcile Statement</Text>
        <View style={{ width: 26 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: 80 }}>
        <Card>
          <Text style={styles.name} testID="recon-supplier-name">{supplier?.name || "Loading…"}</Text>
          <Text style={styles.hint}>
            Photograph or upload the {party === "customer" ? "customer's" : "supplier's"} statement. AI extracts each line item and compares against your Ledgr records.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginTop: theme.spacing.md }}>
            <Pressable testID="btn-scan-stmt" onPress={scan} disabled={busy} style={[styles.actionBtn, { flex: 1 }]}>
              <Ionicons name="camera-outline" size={18} color="#fff" />
              <Text style={styles.actionText}>Scan</Text>
            </Pressable>
            <Pressable testID="btn-upload-stmt" onPress={upload} disabled={busy} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandSecondary }]}>
              <Ionicons name="image-outline" size={18} color="#fff" />
              <Text style={styles.actionText}>Image</Text>
            </Pressable>
            <Pressable testID="btn-upload-pdf" onPress={uploadPdf} disabled={busy} style={[styles.actionBtn, { flex: 1, backgroundColor: theme.color.brandTertiary || theme.color.brandSecondary }]}>
              <Ionicons name="document-outline" size={18} color="#fff" />
              <Text style={styles.actionText}>PDF</Text>
            </Pressable>
          </View>
          {photo ? <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={styles.preview} /> : null}
        </Card>

        {busy && (
          <View style={{ alignItems: "center", padding: theme.spacing.xl }}>
            <ActivityIndicator color={theme.color.brandPrimary} size="large" />
            <Text style={styles.hint}>AI is reading the statement…</Text>
          </View>
        )}

        {error ? <Text style={styles.error} testID="recon-error">{error}</Text> : null}

        {result && (
          <>
            {stmtTotal ? (
              <Card style={{ marginTop: theme.spacing.md }} testID="recon-summary">
                <Text style={styles.section}>Statement Total</Text>
                <View style={styles.totalRow}>
                  <View style={styles.totalCol}>
                    <Text style={styles.totalLabel}>On statement</Text>
                    <Text style={styles.totalVal}>{fmt(stmtTotal)}</Text>
                  </View>
                  <View style={styles.totalCol}>
                    <Text style={styles.totalLabel}>Your Ledgr</Text>
                    <Text style={styles.totalVal}>{fmt(supplier?.balance ?? 0)}</Text>
                  </View>
                </View>
              </Card>
            ) : null}

            <Text style={styles.section}>Matched ({result.matched.length})</Text>
            {result.matched.length === 0 ? <Text style={styles.empty}>No matches yet.</Text> :
              result.matched.map((m: any, i: number) => (
                <View key={i} style={[styles.row, { borderLeftColor: theme.color.success }]}>
                  <Ionicons name="checkmark-circle" size={18} color={theme.color.success} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.rowTitle}>{shortDate(m.statement.date)} • {fmt(m.statement.amount)}</Text>
                    <Text style={styles.rowSub}>{m.statement.description || m.statement.reference || "—"}</Text>
                  </View>
                </View>
              ))}

            <View style={styles.sectionHeaderRow}>
              <Text style={[styles.section, { marginBottom: 0 }]}>On statement — missing from Ledgr ({result.missingInLedgr.length})</Text>
              {result.missingInLedgr.some((e: any) => validateReconcileEntry(e) === null) ? (
                <Pressable testID="import-all" onPress={confirmAndImportAll} disabled={importing} style={[styles.importAllBtn, importing && { opacity: 0.5 }]}>
                  <Ionicons name="cloud-upload-outline" size={14} color="#fff" />
                  <Text style={styles.importAllText}>Import all</Text>
                </Pressable>
              ) : null}
            </View>
            {result.missingInLedgr.length === 0 ? <Text style={styles.empty}>Nothing missing.</Text> :
              result.missingInLedgr.map((e: any, i: number) => {
                const invalidReason = validateReconcileEntry(e);
                return (
                  <View key={i} style={[styles.row, { borderLeftColor: invalidReason ? theme.color.error : theme.color.warning }]}>
                    <Ionicons name={invalidReason ? "close-circle" : "alert-circle"} size={18} color={invalidReason ? theme.color.error : theme.color.warning} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={styles.rowTitle}>{shortDate(e.date)} • {fmt(e.amount, currencySymbol)}</Text>
                      <Text style={styles.rowSub}>{e.description || e.reference || "—"} • {e.type}</Text>
                      {invalidReason ? <Text style={styles.flaggedText} testID={`import-flag-${i}`}>⚠ {invalidReason}</Text> : null}
                    </View>
                    {invalidReason ? (
                      <View testID={`import-disabled-${i}`} style={[styles.importBtn, styles.importBtnDisabled]}>
                        <Text style={[styles.importBtnText, { color: theme.color.muted }]}>Invalid</Text>
                      </View>
                    ) : (
                      <Pressable testID={`import-${i}`} onPress={() => confirmAndImportOne(e)} disabled={importing} style={[styles.importBtn, importing && { opacity: 0.5 }]}>
                        <Text style={styles.importBtnText}>+ Add</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}

            <Text style={styles.section}>In Ledgr — not on statement ({result.notOnStatement.length})</Text>
            {result.notOnStatement.length === 0 ? <Text style={styles.empty}>All records appear on statement.</Text> :
              result.notOnStatement.map((o: any) => (
                <View key={o.id} style={[styles.row, { borderLeftColor: theme.color.error }]}>
                  <Ionicons name="close-circle" size={18} color={theme.color.error} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.rowTitle}>{shortDate(o.date)} • {fmt(o.amount)}</Text>
                    <Text style={styles.rowSub}>{o.notes || o.invoiceNo || o.reference || "—"}</Text>
                  </View>
                </View>
              ))}
          </>
        )}
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
    hint: { fontSize: 13, color: theme.color.muted, marginTop: 6 },
    actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md },
    actionText: { color: "#fff", fontWeight: "600", fontSize: 14 },
    preview: { width: "100%", height: 180, borderRadius: theme.radius.md, marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
    error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
    section: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface, marginTop: theme.spacing.lg, marginBottom: theme.spacing.md },
    empty: { color: theme.color.muted, textAlign: "center", padding: theme.spacing.md, fontSize: 13, fontStyle: "italic" },
    row: {
      flexDirection: "row", alignItems: "center",
      backgroundColor: theme.color.surfaceSecondary, padding: theme.spacing.md,
      borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border,
      borderLeftWidth: 4, marginBottom: theme.spacing.sm,
    },
    rowTitle: { fontSize: 14, fontWeight: "600", color: theme.color.onSurface },
    rowSub: { fontSize: 12, color: theme.color.muted, marginTop: 2 },
    importBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.sm, backgroundColor: theme.color.brandTertiary },
    importBtnDisabled: { backgroundColor: theme.color.surfaceTertiary },
    importBtnText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 12 },
    sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: theme.spacing.lg, marginBottom: theme.spacing.md, gap: 8 },
    importAllBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.sm, backgroundColor: theme.color.brandPrimary },
    importAllText: { color: "#fff", fontWeight: "700", fontSize: 12 },
    flaggedText: { color: theme.color.error, fontSize: 11, marginTop: 2, fontWeight: "600" },
    totalRow: { flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.sm },
    totalCol: { flex: 1, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, alignItems: "center" },
    totalLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
    totalVal: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface, marginTop: 4 },
  });
}
