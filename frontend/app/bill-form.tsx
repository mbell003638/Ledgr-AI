import React, { useEffect, useMemo, useState } from "react";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { LocationPicker } from "@/src/components/LocationPicker";

type StockProduct = { id: string; name: string; sku?: string; cost?: number; archived?: boolean };

export default function BillForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ supplierId?: string; id?: string }>();
  const editId = params.id;
  const [supplierId, setSupplierId] = useState<string>(params.supplierId || "");
  const [amount, setAmount] = useState("");
  const currency = "USD";
  const [billType, setBillType] = useState<"inventory" | "expense">("inventory");
  const [expenseCategory, setExpenseCategory] = useState<string>("Rent");
  const [paymentType, setPaymentType] = useState<"credit" | "cash">("credit");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(localTodayIso());
  const [photo, setPhoto] = useState<string>("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [stockEnabled, setStockEnabled] = useState(false);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [stockProductId, setStockProductId] = useState("");
  const [stockQty, setStockQty] = useState("");
  const [locationId, setLocationId] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const settings = await api.getSettings();
        const on = getEnabledFeatures(settings).includes("perpetualInventory");
        setStockEnabled(on);
        if (on) {
          const list = await (api as any).listProducts();
          setProducts((Array.isArray(list) ? list : []).filter((p: StockProduct) => p?.id && !p.archived));
        }
      } catch {
        setStockEnabled(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const s = await api.listSuppliers();
      if (!params.supplierId && !editId && s.length) setSupplierId(s[0].id);
      if (editId) {
        const bills = await api.listBills();
        const b = bills.find((x: any) => x.id === editId);
        if (b) {
          setSupplierId(b.supplierId);
          setAmount(String(b.amount));
          setBillType(b.isExpense === true || b.billType === "expense" ? "expense" : "inventory");
          if (b.category) setExpenseCategory(b.category);
          setPaymentType(b.paymentType);
          setInvoiceNo(b.invoiceNo || "");
          setNotes(b.notes || "");
          setDate(b.date);
          setPhoto(b.photo || "");
        }
      }
    })();
  }, [editId, params.supplierId]);

  const runOcr = async (base64: string, mimeType: string) => {
    setOcrLoading(true);
    try {
      const r = await api.ocrReceipt(base64, mimeType);
      if (r.amount) setAmount(String(r.amount));
      if (r.invoiceNo) setInvoiceNo(r.invoiceNo);
      if (r.date) setDate(r.date);
      if (r.supplierName) {
        const list = await api.listSuppliers();
        let match = list.find((s: any) => s.name.toLowerCase().includes(r.supplierName.toLowerCase()));
        if (!match) {
          match = await api.createSupplier({ name: r.supplierName });
        }
        setSupplierId(match.id);
      }
    } catch (e: any) {
      setError(e.message || "OCR failed");
    } finally {
      setOcrLoading(false);
    }
  };

  const scanReceipt = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setError("Camera permission denied"); return; }
    const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    const asset = res.assets[0];
    setPhoto(asset.base64!);
    await runOcr(asset.base64!, asset.mimeType || "image/jpeg");
  };

  const uploadReceipt = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError("Gallery permission denied"); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.5, mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled || !res.assets[0].base64) return;
    const asset = res.assets[0];
    setPhoto(asset.base64!);
    await runOcr(asset.base64!, asset.mimeType || "image/jpeg");
  };

  type LineItem = { description: string; qty: string; rate: string };
  const [lines, setLines] = useState<LineItem[]>([]);

  const addLine = () => setLines((prev) => [...prev, { description: "", qty: "1", rate: "" }]);
  const removeLine = (idx: number) => {
    setLines((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const totalAmt = next.reduce((sum, l) => sum + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
      if (totalAmt > 0) setAmount(totalAmt.toFixed(2));
      return next;
    });
  };
  const updateLine = (idx: number, field: keyof LineItem, val: string) => {
    setLines((prev) => {
      const next = prev.map((l, i) => (i === idx ? { ...l, [field]: val } : l));
      const totalAmt = next.reduce((sum, l) => sum + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
      if (totalAmt > 0) setAmount(totalAmt.toFixed(2));
      return next;
    });
  };

  const save = async () => {
    setError("");
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    let finalSupplierId = supplierId;
    if (newSupplierName.trim()) {
      try {
        const party = await api.findOrCreateParty(newSupplierName.trim(), "supplier", { phone: newSupplierPhone.trim() });
        if (party) finalSupplierId = party.id;
      } catch (e: any) {
        setError(e.message || "Failed to save supplier");
        return;
      }
    }
    if (!finalSupplierId) { setError("Enter or select a supplier"); return; }
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    setSaving(true);
    try {
      const itemSummaryText = lines.length > 0
        ? lines.map((l) => `${l.description || 'Item'} (${l.qty} x $${l.rate})`).join(", ")
        : "";
      const finalNotes = [itemSummaryText, notes.trim()].filter(Boolean).join(" — ");

      const qty = Number(stockQty);
      const stockProduct = products.find((p) => p.id === stockProductId);
      const productLines = !editId && billType === "inventory" && stockEnabled && stockProduct && Number.isFinite(qty) && qty !== 0
        ? [{ productId: stockProduct.id, qty, ...(Number.isFinite(Number(stockProduct.cost)) ? { unitCost: Number(stockProduct.cost) } : {}) }]
        : undefined;

      const payload = {
        supplierId: finalSupplierId, date: dateIso, amount: amt, currency,
        paymentType, invoiceNo, notes: finalNotes, photo,
        isExpense: billType === "expense",
        category: billType === "expense" ? expenseCategory : undefined,
        ...(locationId ? { locationId } : {}),
      };
      if (editId) await api.updateBill(editId, payload);
      else await api.createBill({ ...payload, ...(productLines ? { productLines } : {}) });
      router.back();
    } catch (e: any) { setError(e.message || "Failed"); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editId) return;
    setDeleting(true);
    try { await api.deleteBill(editId); router.back(); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");

  const EXPENSE_CATEGORIES = ["Rent", "Utilities", "Salaries", "Maintenance", "Office Supplies", "Marketing", "Other"];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-bill" onPress={() => router.back()}>
          <Ionicons name="close" size={26} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>New Vendor Bill</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <LocationPicker value={locationId} onChange={setLocationId} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              testID="btn-scan-receipt"
              onPress={scanReceipt}
              style={({ pressed }) => [styles.scanBtn, { flex: 1 }, pressed && { opacity: 0.85 }]}
            >
              {ocrLoading ? <ActivityIndicator color="#fff" /> : <>
                <Ionicons name="camera-outline" size={20} color="#fff" />
                <Text style={styles.scanText}>Scan</Text>
              </>}
            </Pressable>
            <Pressable
              testID="btn-upload-receipt"
              onPress={uploadReceipt}
              disabled={ocrLoading}
              style={({ pressed }) => [styles.scanBtn, { flex: 1, backgroundColor: theme.color.brandSecondary }, pressed && { opacity: 0.85 }]}
            >
              <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
              <Text style={styles.scanText}>Upload</Text>
            </Pressable>
          </View>

          {photo ? (
            <Image source={{ uri: `data:image/jpeg;base64,${photo}` }} style={styles.preview} />
          ) : null}

          <Card style={{ marginTop: theme.spacing.md }}>
            <Text style={styles.label}>Bill Type</Text>
            <View style={styles.segRowFull}>
              {(["inventory", "expense"] as const).map((t) => (
                <Pressable
                  key={t}
                  testID={`bill-type-${t}`}
                  onPress={() => {
                    setBillType(t);
                    if (t === "expense") { setStockProductId(""); setStockQty(""); }
                  }}
                  style={[styles.segBtnFull, billType === t && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, billType === t && styles.segTextActive]}>
                    {t === "inventory" ? "Stock / Inventory" : "Expense / Overhead"}
                  </Text>
                </Pressable>
              ))}
            </View>

            {billType === "expense" ? (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.label}>Expense Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {EXPENSE_CATEGORIES.map((cat) => (
                      <Pressable
                        key={cat}
                        testID={`exp-cat-${cat.toLowerCase().replace(/\s+/g, '-')}`}
                        onPress={() => setExpenseCategory(cat)}
                        style={[styles.chip, expenseCategory === cat && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, expenseCategory === cat && styles.chipTextActive]}>{cat}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </View>
            ) : null}

            <View style={{ marginTop: 12 }}>
              <PartyAutocompleteInput
                testID="input-supplier-name"
                label="Supplier / Vendor name *"
                value={newSupplierName}
                onChangeText={setNewSupplierName}
                placeholder="e.g. Sharma Traders"
                roleFilter="all"
                onSelectParty={(p) => setSupplierId(p.id)}
              />
            </View>
            <Text style={[styles.label, { marginTop: 12 }]}>Phone (optional)</Text>
            <TextInput
              testID="input-supplier-phone"
              value={newSupplierPhone}
              onChangeText={setNewSupplierPhone}
              keyboardType="phone-pad"
              placeholder="+1 555 000 0000"
              placeholderTextColor={theme.color.muted}
              style={styles.input}
            />

            {/* Line Items / Products (Optional) */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14, marginBottom: 6 }}>
              <Text style={styles.label}>Itemized Items & Prices (Optional)</Text>
              <Pressable onPress={addLine} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name="add-circle-outline" size={16} color={theme.color.brandPrimary} />
                <Text style={{ fontSize: 13, fontWeight: "700", color: theme.color.brandPrimary }}>+ Add Item</Text>
              </Pressable>
            </View>

            {lines.map((item, idx) => (
              <View key={idx} style={{ flexDirection: "row", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <TextInput
                  placeholder="Item Description"
                  placeholderTextColor={theme.color.muted}
                  value={item.description}
                  onChangeText={(val) => updateLine(idx, "description", val)}
                  style={[styles.input, { flex: 2, marginTop: 0 }]}
                />
                <TextInput
                  placeholder="Qty"
                  placeholderTextColor={theme.color.muted}
                  value={item.qty}
                  keyboardType="numeric"
                  onChangeText={(val) => updateLine(idx, "qty", val)}
                  style={[styles.input, { flex: 1, marginTop: 0 }]}
                />
                <TextInput
                  placeholder="Price"
                  placeholderTextColor={theme.color.muted}
                  value={item.rate}
                  keyboardType="decimal-pad"
                  onChangeText={(val) => updateLine(idx, "rate", val)}
                  style={[styles.input, { flex: 1.2, marginTop: 0 }]}
                />
                <Pressable onPress={() => removeLine(idx)} style={{ padding: 4 }}>
                  <Ionicons name="trash-outline" size={18} color={theme.color.error} />
                </Pressable>
              </View>
            ))}

            {!editId && billType === "inventory" && stockEnabled ? (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.label}>Product stock (optional)</Text>
                <Text style={styles.hint}>Adds to live product quantity when this bill is saved.</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    <Pressable
                      testID="pick-product-none"
                      onPress={() => { setStockProductId(""); setStockQty(""); }}
                      style={[styles.chip, !stockProductId && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, !stockProductId && styles.chipTextActive]}>None</Text>
                    </Pressable>
                    {products.map((p) => (
                      <Pressable
                        key={p.id}
                        testID={`pick-product-${p.id}`}
                        onPress={() => setStockProductId(p.id)}
                        style={[styles.chip, stockProductId === p.id && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, stockProductId === p.id && styles.chipTextActive]}>
                          {p.name}{p.sku ? ` · ${p.sku}` : ""}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
                {stockProductId ? (
                  <>
                    <Text style={[styles.label, { marginTop: 12 }]}>Quantity</Text>
                    <TextInput
                      testID="input-stock-qty"
                      value={stockQty}
                      onChangeText={setStockQty}
                      keyboardType="numeric"
                      placeholder="1"
                      placeholderTextColor={theme.color.muted}
                      style={styles.input}
                    />
                  </>
                ) : null}
                {!products.length ? <Text style={[styles.hint, { marginTop: 6 }]}>No products yet — add one under Products.</Text> : null}
              </View>
            ) : null}

            <Text style={[styles.label, { marginTop: 8 }]}>Total Amount ($)</Text>
            <TextInput
              testID="input-amount"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={theme.color.muted}
              style={[styles.input]}
            />

            <Text style={[styles.label, { marginTop: 12 }]}>Payment Type</Text>
            <View style={styles.segRowFull}>
              {(["credit", "cash"] as const).map((c) => (
                <Pressable
                  key={c}
                  testID={`pay-${c}`}
                  onPress={() => setPaymentType(c)}
                  style={[styles.segBtnFull, paymentType === c && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, paymentType === c && styles.segTextActive]}>{c === "credit" ? "On Credit" : "Cash"}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.label, { marginTop: 12 }]}>Invoice #</Text>
            <TextInput testID="input-invoice" value={invoiceNo} onChangeText={setInvoiceNo} placeholder="Optional" placeholderTextColor={theme.color.muted} style={styles.input} />

            <Text style={[styles.label, { marginTop: 12 }]}>Notes</Text>
            <TextInput testID="input-notes" value={notes} onChangeText={setNotes} placeholder="Optional" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />

            <Text style={[styles.label, { marginTop: 12 }]}>Date (YYYY-MM-DD)</Text>
            <TextInput value={date} onChangeText={setDate} placeholder="2024-01-01" placeholderTextColor={theme.color.muted} style={styles.input} />
          </Card>

          {error ? <Text style={styles.error} testID="bill-error">{error}</Text> : null}

          <Pressable
            testID="btn-save-bill"
            onPress={save}
            disabled={saving}
            style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>{editId ? "Update Bill" : "Save Bill"}</Text>}
          </Pressable>
          {editId ? (
            <Pressable
              testID="btn-delete-bill"
              onPress={remove}
              disabled={deleting}
              style={({ pressed }) => [styles.deleteBtn, (pressed || deleting) && { opacity: 0.85 }]}
            >
              {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={styles.deleteText}>Delete Bill</Text>}
            </Pressable>
          ) : null}
          <View style={{ height: 60 }} />
        </ScrollView>
      </KeyboardAvoidingView>

    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  scroll: { padding: theme.spacing.lg },
  scanBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: theme.color.brandPrimary, padding: theme.spacing.md, borderRadius: theme.radius.md },
  scanText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  preview: { width: "100%", height: 160, borderRadius: theme.radius.md, marginTop: theme.spacing.md, backgroundColor: theme.color.surfaceTertiary },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  hint: { fontSize: 12, color: theme.color.muted },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.color.surfaceTertiary, borderWidth: 1, borderColor: theme.color.border, flexShrink: 0 },
  chipActive: { backgroundColor: theme.color.brandPrimary, borderColor: theme.color.brandPrimary },
  chipText: { color: theme.color.onSurface, fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: "#fff" },
  segRow: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 2 },
  segBtn: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: theme.radius.sm },
  segRowFull: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 2, marginTop: 6 },
  segBtnFull: { flex: 1, paddingVertical: 12, borderRadius: theme.radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 13 },
  segTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  error: { color: theme.color.error, textAlign: "center", marginTop: theme.spacing.md, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  deleteBtn: { padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm },
  deleteText: { color: theme.color.error, fontWeight: "600", fontSize: 14 },
}); }
