import React, { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { fmt } from "@/src/theme";
import { parseMoneyInput } from "@/src/money";
import { getCurrencySymbol } from "@/src/utils/currency";
import { getEnabledFeatures } from "@/src/utils/featureFlags";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { confirmAction } from "@/src/utils/alerts";
import { ScreenHeader, Empty, Card } from "@/src/components/UI";
import { FormCard, FormField, FormActions } from "@/src/components/FormCard";
import { GlowPressable } from "@/src/components/GlowPressable";
import { LocationPicker } from "@/src/components/LocationPicker";

type Product = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  cost: number;
  price: number;
  qty: number;
  archived?: boolean;
};

type FormMode = "create" | "edit" | "adjust";

type ProductClient = {
  listProducts: (locationId?: string) => Promise<any[]>;
  upsertProduct: (input: {
    id?: string;
    name: string;
    sku?: string;
    unit?: string;
    cost: number;
    price: number;
    openingQty?: number;
  }) => Promise<unknown>;
  archiveProduct: (id: string) => Promise<unknown>;
  adjustProductQty: (input: {
    productId: string;
    date: string;
    qtyDelta: number;
    notes?: string;
  }) => Promise<unknown>;
};

const productApi = api as unknown as ProductClient;

function asProduct(row: any): Product {
  return {
    id: String(row?.id || ""),
    name: String(row?.name || ""),
    sku: String(row?.sku || ""),
    unit: String(row?.unit || ""),
    cost: Number(row?.cost || 0),
    price: Number(row?.price || 0),
    qty: Number(row?.qty ?? row?.quantity ?? 0),
    archived: Boolean(row?.archived),
  };
}

function formatQty(n: number) {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export default function ProductsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [enabled, setEnabled] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [mode, setMode] = useState<FormMode | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState("");
  const [price, setPrice] = useState("");
  const [openingQty, setOpeningQty] = useState("");
  const [adjustDate, setAdjustDate] = useState(localTodayIso());
  const [qtyDelta, setQtyDelta] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [locationId, setLocationId] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const settings = await api.getSettings();
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
      const on = getEnabledFeatures(settings).includes("perpetualInventory");
      setEnabled(on);
      if (!on) {
        setProducts([]);
        return;
      }
      const list = await productApi.listProducts(locationId || undefined);
      setProducts((Array.isArray(list) ? list : []).map(asProduct).filter((p) => p.id && !p.archived));
    } catch (e: any) {
      setError(e?.message || "Could not load products.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [locationId]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const resetForm = () => {
    setMode(null);
    setEditId(null);
    setName("");
    setSku("");
    setUnit("");
    setCost("");
    setPrice("");
    setOpeningQty("");
    setAdjustDate(localTodayIso());
    setQtyDelta("");
    setNotes("");
    setFormError("");
  };

  const openCreate = () => {
    resetForm();
    setMode("create");
  };

  const openEdit = (product: Product) => {
    setMode("edit");
    setEditId(product.id);
    setName(product.name);
    setSku(product.sku);
    setUnit(product.unit);
    setCost(product.cost ? String(product.cost) : "");
    setPrice(product.price ? String(product.price) : "");
    setOpeningQty("");
    setFormError("");
  };

  const openAdjust = (product: Product) => {
    setMode("adjust");
    setEditId(product.id);
    setName(product.name);
    setQtyDelta("");
    setNotes("");
    setAdjustDate(localTodayIso());
    setFormError("");
  };

  const selected = products.find((p) => p.id === editId);

  const saveProduct = async () => {
    const costVal = cost.trim() === "" ? 0 : parseMoneyInput(cost);
    const priceVal = price.trim() === "" ? 0 : parseMoneyInput(price);
    if (!name.trim()) { setFormError("Enter a product name."); return; }
    if (!Number.isFinite(costVal) || costVal < 0) { setFormError("Enter a valid cost."); return; }
    if (!Number.isFinite(priceVal) || priceVal < 0) { setFormError("Enter a valid price."); return; }
    const input: Parameters<ProductClient["upsertProduct"]>[0] = {
      name: name.trim(),
      sku: sku.trim() || undefined,
      unit: unit.trim() || undefined,
      cost: costVal,
      price: priceVal,
    };
    if (mode === "edit" && editId) {
      input.id = editId;
    } else {
      const opening = openingQty.trim() === "" ? 0 : Number(openingQty);
      if (!Number.isFinite(opening) || opening < 0) { setFormError("Enter a valid opening quantity."); return; }
      input.openingQty = opening;
      if (locationId) (input as any).locationId = locationId;
    }
    setSaving(true);
    setFormError("");
    try {
      await productApi.upsertProduct(input);
      resetForm();
      await load();
    } catch (e: any) {
      setFormError(e?.message || "Could not save this product.");
    } finally {
      setSaving(false);
    }
  };

  const saveAdjust = async () => {
    if (!editId) return;
    const dateIso = normalizeDateInput(adjustDate);
    if (!isValidDateString(dateIso)) {
      setFormError(`Couldn't read "${adjustDate.trim()}" as a date. Please use YYYY-MM-DD.`);
      return;
    }
    if (dateIso !== adjustDate) setAdjustDate(dateIso);
    const delta = Number(qtyDelta);
    if (!Number.isFinite(delta) || delta === 0) { setFormError("Enter a quantity change other than zero."); return; }
    setSaving(true);
    setFormError("");
    try {
      await productApi.adjustProductQty({
        productId: editId,
        date: dateIso,
        qtyDelta: delta,
        notes: notes.trim() || undefined,
        ...(locationId ? { locationId } : {}),
      });
      resetForm();
      await load();
    } catch (e: any) {
      setFormError(e?.message || "Could not adjust quantity.");
    } finally {
      setSaving(false);
    }
  };

  const archive = (product: Product) => {
    confirmAction(
      "Archive product?",
      `${product.name} will be hidden from the list. Existing stock history is kept.`,
      async () => {
        try {
          await productApi.archiveProduct(product.id);
          if (editId === product.id) resetForm();
          await load();
        } catch (e: any) {
          setError(e?.message || "Could not archive this product.");
        }
      },
      "Archive",
    );
  };

  if (mode) {
    const isAdjust = mode === "adjust";
    const title = isAdjust ? "Adjust quantity" : mode === "edit" ? "Edit product" : "Add product";
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.headerBar}>
          <Pressable testID="btn-close-product" onPress={resetForm}>
            <Ionicons name="close" size={26} color={theme.color.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>{title}</Text>
          <View style={{ width: 26 }} />
        </View>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.formScroll} keyboardShouldPersistTaps="handled">
            {isAdjust ? (
              <FormCard>
                <Text style={styles.cardTitle}>{selected?.name || name}</Text>
                <Text style={styles.hint}>On hand: {formatQty(selected?.qty ?? 0)}{selected?.unit ? ` ${selected.unit}` : ""}. Enter a positive or negative change.</Text>
                <FormField
                  first
                  label="Date (YYYY-MM-DD)"
                  value={adjustDate}
                  onChangeText={setAdjustDate}
                  onBlur={() => { if (adjustDate.trim()) setAdjustDate(normalizeDateInput(adjustDate)); }}
                  placeholder="YYYY-MM-DD"
                  autoCapitalize="none"
                />
                <FormField
                  label="Quantity change"
                  value={qtyDelta}
                  onChangeText={setQtyDelta}
                  keyboardType="numeric"
                  placeholder="e.g. 5 or -2"
                />
                <FormField
                  label="Notes (optional)"
                  multiline
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Count correction, damage, transfer"
                />
              </FormCard>
            ) : (
              <FormCard>
                <FormField
                  first
                  label="Product name"
                  testID="input-product-name"
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g. 500ml water"
                />
                <FormField label="SKU (optional)" value={sku} onChangeText={setSku} placeholder="e.g. WAT-500" autoCapitalize="characters" />
                <FormField label="Unit (optional)" value={unit} onChangeText={setUnit} placeholder="e.g. bottle, kg, pcs" />
                <FormField label="Cost" value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0.00" />
                <FormField label="Price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0.00" />
                {mode === "create" ? (
                  <FormField
                    label="Opening quantity"
                    value={openingQty}
                    onChangeText={setOpeningQty}
                    keyboardType="numeric"
                    placeholder="0"
                    hint="Counted on hand when this product is created. Later changes use Adjust quantity."
                  />
                ) : null}
              </FormCard>
            )}
            <FormActions
              primaryLabel={isAdjust ? "Save adjustment" : mode === "edit" ? "Save product" : "Add product"}
              primaryTestID={isAdjust ? "btn-adjust-qty" : "btn-save-product"}
              onPrimary={isAdjust ? saveAdjust : saveProduct}
              primaryBusy={saving}
              error={formError}
              secondaryLabel={mode === "edit" && editId ? "Archive product" : undefined}
              onSecondary={mode === "edit" && selected ? () => archive(selected) : undefined}
              secondaryTestID="btn-archive-product"
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title="Products"
        subtitle={enabled ? "Each sale and purchase updates quantity" : "Periodic counts remain the default"}
        leftAction={<Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10}><Ionicons name="chevron-back" size={26} color={theme.color.onSurface} /></Pressable>}
        rightAction={enabled ? (
          <Pressable
            testID="btn-add-product"
            onPress={openCreate}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="add" size={22} color="#fff" />
          </Pressable>
        ) : undefined}
      />
      {enabled ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <LocationPicker value={locationId} onChange={setLocationId} />
        </View>
      ) : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {!enabled ? (
            <Card>
              <View style={styles.guidance}>
                <Ionicons name="layers-outline" size={22} color={theme.color.brandPrimary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Live product stock is off</Text>
                  <Text style={styles.guidanceText}>
                    Periodic counts remain the default. Sales and purchases will not change a product quantity until you turn on Live Product Stock.
                  </Text>
                  <Text style={styles.guidanceText}>
                    The Stock tile still does period counts — opening value, physical count, and close.
                  </Text>
                </View>
              </View>
              <Pressable
                testID="btn-customize-features"
                onPress={() => router.push("/customize-features")}
                style={({ pressed }) => [styles.linkBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.linkBtnText}>Turn on in Customize Features</Text>
              </Pressable>
            </Card>
          ) : (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {!products.length ? (
                <Empty
                  icon={<Ionicons name="cube-outline" size={40} color={theme.color.muted} />}
                  title="No products yet"
                  hint="Tap + to add a product with an opening quantity."
                />
              ) : products.map((item) => (
                <GlowPressable
                  key={item.id}
                  testID={`product-${item.id}`}
                  onPress={() => openEdit(item)}
                  haptic
                  topHighlight={false}
                  restingBorderColor={theme.color.border}
                  style={styles.row}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowMeta}>
                      {item.sku ? item.sku : "No SKU"}
                    </Text>
                    <Text style={styles.rowMeta}>
                      Cost {fmt(item.cost, currSym)} · Price {fmt(item.price, currSym)}
                    </Text>
                  </View>
                  <View style={styles.rowRight}>
                    <Text style={styles.qty}>{formatQty(item.qty)}</Text>
                    <Text style={styles.qtyLabel}>on hand</Text>
                    <View style={styles.rowActions}>
                      <Pressable testID={`btn-adjust-${item.id}`} onPress={() => openAdjust(item)} hitSlop={10}>
                        <Ionicons name="swap-vertical-outline" size={16} color={theme.color.brandPrimary} />
                      </Pressable>
                      <Pressable testID={`btn-archive-${item.id}`} onPress={() => archive(item)} hitSlop={10}>
                        <Ionicons name="archive-outline" size={16} color={theme.color.muted} />
                      </Pressable>
                    </View>
                  </View>
                </GlowPressable>
              ))}
            </>
          )}
          <View style={{ height: 120 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    headerBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: theme.spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: theme.color.border,
      backgroundColor: theme.color.surfaceSecondary,
    },
    headerTitle: { fontSize: 16, fontWeight: "700", color: theme.color.onSurface },
    addBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: theme.color.brandPrimary,
      justifyContent: "center",
      alignItems: "center",
      marginTop: theme.spacing.md,
    },
    list: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.md },
    formScroll: { padding: theme.spacing.lg },
    guidance: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
    guidanceText: { color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
    cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    hint: { fontSize: 12, color: theme.color.muted, marginTop: 6 },
    linkBtn: {
      backgroundColor: theme.color.brandPrimary,
      padding: theme.spacing.lg,
      borderRadius: theme.radius.md,
      alignItems: "center",
      marginTop: theme.spacing.lg,
    },
    linkBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
    error: { color: theme.color.error, textAlign: "center", fontSize: 13 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.md,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    rowName: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
    rowMeta: { fontSize: 12, color: theme.color.muted, marginTop: 3 },
    rowRight: { alignItems: "flex-end", gap: 4 },
    qty: { fontSize: 16, fontWeight: "800", color: theme.color.brandPrimary },
    qtyLabel: { fontSize: 10, color: theme.color.muted, fontWeight: "600" },
    rowActions: { flexDirection: "row", gap: 12, marginTop: 6 },
  });
}
