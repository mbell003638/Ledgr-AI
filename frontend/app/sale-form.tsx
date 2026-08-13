import React, { useEffect, useMemo, useState } from "react";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { View, Text, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card } from "@/src/components/UI";
import { calculateInvoiceTotals } from "@/src/utils/invoiceTotals";

import { PartyAutocompleteInput } from "@/src/components/PartyAutocompleteInput";
import { getEnabledFeatures } from "@/src/utils/featureFlags";

type StockProduct = { id: string; name: string; sku?: string; cost?: number; archived?: boolean };

export default function SaleForm() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = params.id;
  const [amount, setAmount] = useState("");
  const currency = "USD";
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState(localTodayIso());

  const [saleType, setSaleType] = useState<"cash" | "party">("cash");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [discount, setDiscount] = useState("");
  type LineItem = { description: string; qty: string; unit: string; rate: string };
  const [lines, setLines] = useState<LineItem[]>([]);
  const [stockEnabled, setStockEnabled] = useState(false);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [stockProductId, setStockProductId] = useState("");
  const [stockQty, setStockQty] = useState("");

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
      if (editId) {
        const list = await api.listSalesAndInvoices();
        const it = list.find((x: any) => x.id === editId);
        if (it) {
          setAmount(String(it.subtotal ?? it.amount));
          setNotes(it.notes || "");
          setDiscount(it.discount ? String(it.discount) : "");
          if (Array.isArray(it.lines) && it.lines.length) setLines(it.lines.map((line: any) => ({ description: line.description || "", qty: String(line.qty ?? 1), unit: line.unit || "", rate: String(line.rate ?? line.price ?? "") })));
          if (it.date) setDate(it.date);
          if (it.type === "invoice" || it.clientName || it.partyId || (it.notes && it.notes.toLowerCase().includes("credit sale"))) {
            setSaleType("party");
            setCustomerName(it.clientName || it.partyId || "");
            setCustomerPhone(it.clientPhone || "");
          }
        }
      }
    })();
  }, [editId]);

  const addLine = () => {
    setLines((prev) => {
      const subtotal = prev.reduce((sum, line) => sum + (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0), 0);
      setAmount(subtotal.toFixed(2));
      return [...prev, { description: "", qty: "1", unit: "", rate: "" }];
    });
  };
  const removeLine = (idx: number) => {
    setLines((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const totalAmt = next.reduce((sum, l) => sum + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
      setAmount(next.length ? totalAmt.toFixed(2) : "");
      return next;
    });
  };
  const updateLine = (idx: number, field: keyof LineItem, val: string) => {
    setLines((prev) => {
      const next = prev.map((l, i) => (i === idx ? { ...l, [field]: val } : l));
      const totalAmt = next.reduce((sum, l) => sum + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0);
      setAmount(totalAmt.toFixed(2));
      return next;
    });
  };

  const save = async () => {
    const lineSubtotal = lines.reduce((sum, line) => sum + (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0), 0);
    const amt = lines.length ? lineSubtotal : parseFloat(amount);
    if (!amt || amt <= 0) { setError("Enter a valid subtotal"); return; }
    if (saleType === "party" && !customerName.trim()) {
      setError("Enter the customer / party name for a credit sale");
      return;
    }
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    if (dateIso !== date) setDate(dateIso);
    setSaving(true); setError("");
    try {
      // Do not create a party on invoice edit — allocated renames must throw without an insert.
      if (!editId && customerName.trim()) {
        await api.findOrCreateParty(customerName.trim(), "customer", { phone: customerPhone.trim() });
      }

      const formattedLines = lines.length > 0 ? lines.map((l) => ({
        description: l.description.trim() || "Item",
        qty: parseFloat(l.qty) || 0,
        unit: l.unit.trim(),
        rate: parseFloat(l.rate) || 0,
      })) : [{ description: notes.trim() || "Sale", qty: 1, unit: "", rate: amt }];
      const totals = calculateInvoiceTotals(formattedLines, discount, 0);
      if (totals.total <= 0) throw new Error("Total after discount must be greater than zero");

      const common = { date: dateIso, lines: formattedLines, subtotal: totals.subtotal, discount: totals.discount, total: totals.total, amount: totals.total, taxRate: 0, notes: notes.trim() || undefined };
      const qty = Number(stockQty);
      const stockProduct = products.find((p) => p.id === stockProductId);
      const productLines = !editId && stockEnabled && stockProduct && Number.isFinite(qty) && qty !== 0
        ? [{ productId: stockProduct.id, qty, ...(Number.isFinite(Number(stockProduct.cost)) ? { unitCost: Number(stockProduct.cost) } : {}) }]
        : undefined;

      if (editId) {
        if (saleType === "party" || customerName.trim()) {
          await api.updateInvoice(editId, {
            clientName: customerName.trim(),
            clientPhone: customerPhone.trim(),
            ...common,
          });
        } else {
          await api.updateSale(editId, { ...common, currency });
        }
      } else if (saleType === "cash") {
        await api.createSale({ ...common, currency, ...(productLines ? { productLines } : {}) });
      } else {
        await api.createInvoice({
          clientName: customerName.trim(),
          clientPhone: customerPhone.trim(),
          ...common,
          ...(productLines ? { productLines } : {}),
        });
      }
      router.back();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!editId) return;
    setDeleting(true);
    try { await api.deleteSale(editId); router.back(); }
    catch (e: any) { setError(e.message); }
    finally { setDeleting(false); }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <Pressable testID="btn-close-sale" onPress={() => router.back()}><Ionicons name="close" size={26} color={theme.color.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>{editId ? "Edit Sale" : "Log Sale"}</Text>
        <View style={{ width: 26 }} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg }} keyboardShouldPersistTaps="handled">
          {/* Cash vs Party toggle — hidden while editing an existing cash sale */}
          {!editId && (
            <Card style={{ marginBottom: theme.spacing.md }}>
              <Text style={styles.label}>Sale type</Text>
              <View style={styles.segRow}>
                <Pressable
                  testID="seg-cash"
                  onPress={() => setSaleType("cash")}
                  style={[styles.segBtn, saleType === "cash" && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, saleType === "cash" && styles.segTextActive]}>💵 Cash sale</Text>
                </Pressable>
                <Pressable
                  testID="seg-party"
                  onPress={() => setSaleType("party")}
                  style={[styles.segBtn, saleType === "party" && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, saleType === "party" && styles.segTextActive]}>👤 To a customer (credit)</Text>
                </Pressable>
              </View>
              <Text style={styles.hint}>
                {saleType === "cash"
                  ? "Money received now — added straight to your cash sales."
                  : "Customer owes you — this creates an invoice and adds the balance to their customer account."}
              </Text>
            </Card>
          )}

          {/* Customer picker — placed immediately under Sale Type */}
          {saleType === "party" && (
            <Card style={{ marginBottom: theme.spacing.md }}>
              <PartyAutocompleteInput
                testID="input-customer-name"
                label="Customer account name *"
                value={customerName}
                onChangeText={setCustomerName}
                placeholder="e.g. Sharma Traders"
                roleFilter="all"
              />
              <Text style={[styles.label, { marginTop: 12 }]}>Phone (optional)</Text>
              <TextInput
                testID="input-customer-phone"
                value={customerPhone}
                onChangeText={setCustomerPhone}
                keyboardType="phone-pad"
                placeholder="+1 555 000 0000"
                placeholderTextColor={theme.color.muted}
                style={styles.input}
              />
            </Card>
          )}

          <Card>
            <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
            <TextInput value={date} onChangeText={setDate} placeholder="2024-01-01" placeholderTextColor={theme.color.muted} style={styles.input} />

            {/* Line Items / Products (Optional) */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14, marginBottom: 6 }}>
              <Text style={styles.label}>Itemized Items (Optional)</Text>
              <Pressable onPress={addLine} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Ionicons name="add-circle-outline" size={16} color={theme.color.brandPrimary} />
                <Text style={{ fontSize: 13, fontWeight: "700", color: theme.color.brandPrimary }}>+ Add Item</Text>
              </Pressable>
            </View>

            {lines.map((item, idx) => (
              <View key={idx} style={{ marginBottom: 10 }}>
                <TextInput
                  placeholder="Description"
                  placeholderTextColor={theme.color.muted}
                  value={item.description}
                  onChangeText={(val) => updateLine(idx, "description", val)}
                  style={[styles.input, { marginTop: 0 }]}
                />
                <View style={{ flexDirection: "row", gap: 8, marginTop: 6, alignItems: "center" }}>
                <TextInput
                  placeholder="Qty"
                  placeholderTextColor={theme.color.muted}
                  value={item.qty}
                  keyboardType="numeric"
                  onChangeText={(val) => updateLine(idx, "qty", val)}
                  style={[styles.input, { flex: 0.8, marginTop: 0 }]}
                />
                <TextInput
                  placeholder="Unit"
                  placeholderTextColor={theme.color.muted}
                  value={item.unit}
                  onChangeText={(val) => updateLine(idx, "unit", val)}
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
              </View>
            ))}

            {!editId && stockEnabled ? (
              <View style={{ marginTop: 14 }}>
                <Text style={styles.label}>Product stock (optional)</Text>
                <Text style={styles.hint}>Deducts from live product quantity when this sale is saved.</Text>
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
                {!products.length ? <Text style={styles.hint}>No products yet — add one under Products.</Text> : null}
              </View>
            ) : null}

            <Text style={[styles.label, { marginTop: 12 }]}>Subtotal Amount ($)</Text>
            <TextInput testID="input-sale-amount" value={amount} onChangeText={setAmount} editable={lines.length === 0} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input, lines.length > 0 && { opacity: 0.72 }]} />
            <Text style={[styles.label, { marginTop: 12 }]}>Discount ($, optional)</Text>
            <TextInput testID="input-sale-discount" value={discount} onChangeText={setDiscount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={theme.color.muted} style={[styles.input]} />
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
              <Text style={styles.label}>Total after discount</Text>
              <Text style={{ color: theme.color.brandPrimary, fontWeight: "700" }}>${Math.max(0, (parseFloat(amount) || 0) - (parseFloat(discount) || 0)).toFixed(2)}</Text>
            </View>
            <Text style={[styles.label, { marginTop: 12 }]}>Details / Notes (Payment For / Information)</Text>
            <TextInput testID="input-sale-notes" value={notes} onChangeText={setNotes} placeholder="e.g. Sale of products, July invoice" placeholderTextColor={theme.color.muted} style={[styles.input, { minHeight: 60 }]} multiline />
          </Card>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="btn-save-sale" onPress={save} disabled={saving} style={({ pressed }) => [styles.saveBtn, (pressed || saving) && { opacity: 0.85 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.saveText}>
                {editId ? "Update Sale" : saleType === "cash" ? "Save Cash Sale" : "Create Invoice & Save"}
              </Text>
            )}
          </Pressable>
          {editId ? (
            <Pressable testID="btn-delete-sale" onPress={remove} disabled={deleting} style={({ pressed }) => [{ padding: theme.spacing.md, alignItems: "center", marginTop: theme.spacing.sm }, (pressed || deleting) && { opacity: 0.85 }]}>
              {deleting ? <ActivityIndicator color={theme.color.error} /> : <Text style={{ color: theme.color.error, fontWeight: "600", fontSize: 14 }}>Delete Sale</Text>}
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  headerBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
  label: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface },
  hint: { fontSize: 12, color: theme.color.muted, marginTop: 8 },
  input: { marginTop: 6, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, fontSize: 14, color: theme.color.onSurface },
  segRow: { flexDirection: "row", backgroundColor: theme.color.surfaceTertiary, borderRadius: theme.radius.md, padding: 3, marginTop: 8, gap: 4 },
  segBtn: { flex: 1, paddingHorizontal: 10, paddingVertical: 12, borderRadius: theme.radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: theme.color.surfaceSecondary, borderWidth: 1, borderColor: theme.color.brandPrimary },
  segText: { color: theme.color.muted, fontWeight: "500", fontSize: 12, textAlign: "center" },
  segTextActive: { color: theme.color.brandPrimary, fontWeight: "700" },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
  chipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary },
  chipText: { fontSize: 13, color: theme.color.onSurface, fontWeight: "500" },
  chipTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  error: { color: theme.color.error, textAlign: "center", marginTop: 12, fontSize: 13 },
  saveBtn: { backgroundColor: theme.color.brandPrimary, padding: theme.spacing.lg, borderRadius: theme.radius.md, alignItems: "center", marginTop: theme.spacing.lg },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
}); }
