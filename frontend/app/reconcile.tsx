import React, { useMemo, useState, useEffect } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { fmt, shortDate } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";

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
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (party === "customer" && customerId) {
      api.listDebtors().then((list: any[]) => setSupplier(list.find((d) => d.id === customerId) || null)).catch(() => {});
    } else if (supplierId) {
      api.getSupplier(supplierId).then(setSupplier).catch(() => {});
    }
  }, [supplierId, customerId, party]);

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

  const importMissing = async (e: any) => {
    if (!partyId) return;
    try {
      if (party === "customer") {
        // Customer statement: a "bill" line = an invoice they owe; a "payment"
        // line = money they paid (record as an against-invoice/advance receipt).
        if (e.type === "payment") {
          await api.createReceipt({
            mode: "advance", amount: e.amount, date: e.date, method: "cash",
            debtorId: partyId, clientName: supplier?.name || "",
            notes: e.description || "From reconciliation",
          });
        } else {
          await api.createInvoice({
            clientName: supplier?.name || "Customer",
            lines: [{ description: e.description || "From reconciliation", qty: 1, rate: e.amount }],
            taxRate: 0, total: e.amount, date: e.date, notes: e.reference || "",
          });
        }
        const r = await api.reconcileStatement(photo, partyId, "image/jpeg", "customer");
        setResult(r);
        return;
      }
      const st = await api.getSettings();
      void st;
      if (e.type === "bill" || !e.type) {
        await api.createBill({
          supplierId: partyId, date: e.date, amount: e.amount, currency: "USD",
          paymentType: "credit", invoiceNo: e.reference || "", notes: e.description || "From reconciliation",
        });
      } else {
        await api.createPayment({
          date: e.date, amount: e.amount, currency: "USD",
          type: "supplier_payment", supplierId: partyId, method: "cash",
          reference: e.reference || "", notes: e.description || "From reconciliation",
        });
      }
      // Refresh
      const r = await api.reconcileStatement(photo, partyId, "image/jpeg", "supplier");
      setResult(r);
    } catch (err: any) { setError(err.message); }
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

            <Text style={styles.section}>On statement — missing from Ledgr ({result.missingInLedgr.length})</Text>
            {result.missingInLedgr.length === 0 ? <Text style={styles.empty}>Nothing missing.</Text> :
              result.missingInLedgr.map((e: any, i: number) => (
                <View key={i} style={[styles.row, { borderLeftColor: theme.color.warning }]}>
                  <Ionicons name="alert-circle" size={18} color={theme.color.warning} />
                  <View style={{ flex: 1, marginLeft: 8 }}>
                    <Text style={styles.rowTitle}>{shortDate(e.date)} • {fmt(e.amount)}</Text>
                    <Text style={styles.rowSub}>{e.description || e.reference || "—"} • {e.type}</Text>
                  </View>
                  <Pressable testID={`import-${i}`} onPress={() => importMissing(e)} style={styles.importBtn}>
                    <Text style={styles.importBtnText}>+ Add</Text>
                  </Pressable>
                </View>
              ))}

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
    importBtnText: { color: theme.color.brandPrimary, fontWeight: "700", fontSize: 12 },
    totalRow: { flexDirection: "row", gap: theme.spacing.md, marginTop: theme.spacing.sm },
    totalCol: { flex: 1, padding: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, alignItems: "center" },
    totalLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
    totalVal: { fontSize: 20, fontWeight: "700", color: theme.color.onSurface, marginTop: 4 },
  });
}
