import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, Alert, InteractionManager } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { api as ledgrApi } from "@/src/api";
import { getDataVersion } from "@/src/utils/dataVersion";
import { fmt } from "@/src/theme";
import { getCurrencySymbol } from "@/src/utils/currency";
import { ScreenHeader, Card } from "@/src/components/UI";
import { FormCard, FormField, FormActions } from "@/src/components/FormCard";
import { isValidDateString, localTodayIso, normalizeDateInput } from "@/src/utils/dateValidation";
import { parseMoneyInput } from "@/src/money";
import { getEnabledFeatures } from "@/src/utils/featureFlags";

type AssetCategory = "equipment" | "vehicle" | "computer" | "other";
type AssetFunding = "cash" | "bank" | "loan";
type FixedAsset = {
  id: string;
  name: string;
  category: string;
  date: string;
  cost: number;
  residual: number;
  usefulLifeMonths: number;
  accumDep: number;
  netBookValue: number;
  disposed: boolean;
};
type AcquireInput = {
  name: string;
  category: AssetCategory;
  date: string;
  cost: number;
  residual: number;
  usefulLifeMonths: number;
  funding: AssetFunding;
};

const api = ledgrApi as typeof ledgrApi & {
  listFixedAssets: () => Promise<unknown>;
  acquireFixedAsset: (input: AcquireInput) => Promise<unknown>;
  postAssetDepreciation: (input: { assetId: string; date: string }) => Promise<unknown>;
  disposeFixedAsset: (input: { assetId: string; date: string }) => Promise<unknown>;
};

const today = () => localTodayIso();
const categories = [
  { id: "equipment", label: "Equipment" },
  { id: "vehicle", label: "Vehicle" },
  { id: "computer", label: "Computer" },
  { id: "other", label: "Other" },
] as const;
const fundingOptions = [
  { id: "cash", label: "Cash" },
  { id: "bank", label: "Bank" },
  { id: "loan", label: "Loan" },
] as const;

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asAsset(row: any): FixedAsset {
  const cost = asNumber(row?.cost);
  const accumDep = asNumber(row?.accumDep ?? row?.accumulatedDepreciation ?? row?.accum_dep ?? row?.accumulated_depreciation);
  const netBookValue = asNumber(row?.netBookValue ?? row?.net_book_value ?? row?.nbv, cost - accumDep);
  return {
    id: String(row?.id ?? ""),
    name: String(row?.name ?? "Untitled asset"),
    category: String(row?.category ?? "other"),
    date: String(row?.date ?? row?.acquiredDate ?? row?.acquired_date ?? ""),
    cost,
    residual: asNumber(row?.residual),
    usefulLifeMonths: asNumber(row?.usefulLifeMonths ?? row?.useful_life_months),
    accumDep,
    netBookValue,
    disposed: Boolean(row?.disposed),
  };
}

function asAssetList(raw: unknown): FixedAsset[] {
  const rows = Array.isArray(raw) ? raw : ((raw as any)?.assets ?? (raw as any)?.items ?? []);
  return (Array.isArray(rows) ? rows : []).map(asAsset).filter((row) => row.id);
}

function categoryLabel(id: string): string {
  return categories.find((option) => option.id === id)?.label || id;
}

export default function FixedAssetsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [currSym, setCurrSym] = useState("$");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<AssetCategory>("equipment");
  const [date, setDate] = useState(today());
  const [cost, setCost] = useState("");
  const [residual, setResidual] = useState("");
  const [life, setLife] = useState("");
  const [funding, setFunding] = useState<AssetFunding>("cash");
  const loadedVersion = React.useRef<number>(-1);

  const load = useCallback(async () => {
    try {
      setError("");
      const settings = await api.getSettings();
      setCurrSym(getCurrencySymbol(settings.currency || "USD"));
      const on = getEnabledFeatures(settings).includes("fixedAssets");
      setEnabled(on);
      if (!on) {
        setAssets([]);
        loadedVersion.current = getDataVersion();
        return;
      }
      const rows = await api.listFixedAssets();
      setAssets(asAssetList(rows));
      loadedVersion.current = getDataVersion();
    } catch (e: any) {
      setError(e?.message || "Could not load the fixed asset register.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (loadedVersion.current === getDataVersion() && enabled !== null) return;
    const task = InteractionManager.runAfterInteractions(() => { load(); });
    return () => task.cancel();
  }, [load, enabled]));

  const resetForm = () => {
    setName(""); setCategory("equipment"); setDate(today()); setCost(""); setResidual(""); setLife(""); setFunding("cash"); setError("");
  };

  const acquire = async () => {
    const costValue = parseMoneyInput(cost);
    const residualRaw = residual.trim() === "" ? 0 : parseMoneyInput(residual);
    const months = Number(life.trim());
    const dateIso = normalizeDateInput(date);
    if (!isValidDateString(dateIso)) { setError(`Couldn't read "${date.trim()}" as a date. Please use YYYY-MM-DD.`); return; }
    setDate(dateIso);
    if (!name.trim()) { setError("Enter an asset name."); return; }
    if (!Number.isFinite(costValue) || costValue <= 0) { setError("Enter a positive cost."); return; }
    if (!Number.isFinite(residualRaw) || residualRaw < 0) { setError("Enter a residual value of zero or more."); return; }
    if (residualRaw > costValue) { setError("Residual value cannot exceed cost."); return; }
    if (!Number.isInteger(months) || months <= 0) { setError("Enter useful life in whole months."); return; }
    setSaving(true); setError("");
    try {
      await api.acquireFixedAsset({
        name: name.trim(),
        category,
        date: dateIso,
        cost: costValue,
        residual: residualRaw,
        usefulLifeMonths: months,
        funding,
      });
      resetForm();
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not acquire this asset.");
    } finally {
      setSaving(false);
    }
  };

  const runAssetAction = async (asset: FixedAsset, kind: "depreciate" | "dispose") => {
    const actionDate = today();
    setActingId(asset.id); setError("");
    try {
      if (kind === "depreciate") await api.postAssetDepreciation({ assetId: asset.id, date: actionDate });
      else await api.disposeFixedAsset({ assetId: asset.id, date: actionDate });
      await load();
    } catch (e: any) {
      setError(e?.message || (kind === "depreciate" ? "Could not post depreciation." : "Could not dispose this asset."));
    } finally {
      setActingId(null);
    }
  };

  const depreciate = (asset: FixedAsset) => { void runAssetAction(asset, "depreciate"); };

  const dispose = (asset: FixedAsset) => {
    Alert.alert("Dispose this asset?", "The remaining book value will be written off as of today.", [
      { text: "Cancel", style: "cancel" },
      { text: "Dispose", style: "destructive", onPress: () => { void runAssetAction(asset, "dispose"); } },
    ]);
  };

  const totalCost = assets.reduce((sum, row) => sum + row.cost, 0);
  const totalAccum = assets.reduce((sum, row) => sum + row.accumDep, 0);
  const totalNbv = assets.reduce((sum, row) => sum + row.netBookValue, 0);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Fixed Asset Register" subtitle="Straight-line depreciation register" />
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />} keyboardShouldPersistTaps="handled">
        {enabled === false ? (
          <Card style={styles.guidance}>
            <Ionicons name="information-circle-outline" size={19} color={theme.color.brandPrimary} />
            <View style={{ flex: 1, gap: 10 }}>
              <Text style={styles.guidanceText}>Fixed Asset Register is an optional module. Turn it on in Customize Features to record equipment, vehicles, and computers with straight-line depreciation.</Text>
              <Pressable onPress={() => router.push("/customize-features")} style={styles.linkBtn}>
                <Text style={styles.linkBtnText}>Open Customize Features</Text>
              </Pressable>
            </View>
          </Card>
        ) : enabled === null && error ? (
          <Card style={styles.guidance}>
            <Ionicons name="alert-circle-outline" size={19} color={theme.color.error} />
            <Text style={styles.guidanceText}>{error}</Text>
          </Card>
        ) : enabled ? (
          <>
            <Card style={styles.guidance}>
              <Ionicons name="information-circle-outline" size={19} color={theme.color.brandPrimary} />
              <Text style={styles.guidanceText}>Straight-line depreciation. Enable this module in Customize Features.</Text>
            </Card>

            <FormCard>
              <View style={styles.formTitleRow}>
                <View style={styles.formIcon}><Ionicons name="car-outline" size={19} color={theme.color.brandPrimary} /></View>
                <View>
                  <Text style={styles.cardTitle}>Add Asset</Text>
                  <Text style={styles.hint}>Debit fixed assets; credit the selected funding source.</Text>
                </View>
              </View>
              <FormField label="Asset name" first testID="input-asset-name" value={name} onChangeText={setName} placeholder="e.g. Delivery van" />
              <Text style={styles.labelSpaced}>Category</Text>
              <View style={styles.chips}>
                {categories.map((option) => {
                  const active = category === option.id;
                  return <Pressable key={option.id} onPress={() => setCategory(option.id)} style={[styles.chip, active && styles.chipActive]}><Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text></Pressable>;
                })}
              </View>
              <FormField label="Acquisition date" value={date} onChangeText={setDate} onBlur={() => { if (date.trim()) setDate(normalizeDateInput(date)); }} placeholder="YYYY-MM-DD" />
              <FormField label="Cost" value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0.00" />
              <FormField label="Residual value" value={residual} onChangeText={setResidual} keyboardType="decimal-pad" placeholder="0.00" />
              <FormField label="Useful life (months)" value={life} onChangeText={setLife} keyboardType="number-pad" placeholder="e.g. 60" />
              <Text style={styles.labelSpaced}>Funded from</Text>
              <View style={styles.chips}>
                {fundingOptions.map((option) => {
                  const active = funding === option.id;
                  return <Pressable key={option.id} onPress={() => setFunding(option.id)} style={[styles.chip, active && styles.chipActive]}><Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text></Pressable>;
                })}
              </View>
              <FormActions primaryLabel="Acquire Asset" primaryTestID="btn-acquire-asset" onPrimary={acquire} primaryBusy={saving} error={error} />
            </FormCard>

            <Card style={styles.listCard}>
              <View style={styles.listTitleRow}>
                <View style={styles.listIcon}><Ionicons name="list-outline" size={17} color={theme.color.brandPrimary} /></View>
                <Text style={styles.cardTitle}>Register</Text>
              </View>
              {!assets.length ? (
                <Text style={styles.empty}>No fixed assets recorded yet.</Text>
              ) : assets.map((asset) => (
                <View key={asset.id} style={styles.entry}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.entryName}>{asset.name}{asset.disposed ? " · Disposed" : ""}</Text>
                    <Text style={styles.entryMeta}>{categoryLabel(asset.category)}{asset.date ? ` · ${asset.date}` : ""}{asset.usefulLifeMonths ? ` · ${asset.usefulLifeMonths} mo` : ""}</Text>
                    <Text style={styles.entryMeta}>Cost {fmt(asset.cost, currSym)} · Accum. dep. {fmt(asset.accumDep, currSym)}</Text>
                    {!asset.disposed ? (
                      <View style={styles.assetActions}>
                        <Pressable testID="btn-post-depreciation" onPress={() => depreciate(asset)} disabled={actingId === asset.id} style={styles.assetBtn}>
                          <Text style={styles.assetBtnText}>{actingId === asset.id ? "Working…" : "Post this month's depreciation"}</Text>
                        </Pressable>
                        <Pressable onPress={() => dispose(asset)} disabled={actingId === asset.id} style={styles.disposeBtn}>
                          <Text style={styles.disposeBtnText}>Dispose</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.entryAmount}>{fmt(asset.netBookValue, currSym)}</Text>
                </View>
              ))}
              <View style={styles.totalRow}>
                <View>
                  <Text style={styles.totalLabel}>Net book value</Text>
                  <Text style={styles.entryMeta}>Cost {fmt(totalCost, currSym)} · Accum. dep. {fmt(totalAccum, currSym)}</Text>
                </View>
                <Text style={styles.total}>{fmt(totalNbv, currSym)}</Text>
              </View>
            </Card>
          </>
        ) : null}
        <View style={{ height: 120 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxxl },
  guidance: { flexDirection: "row", gap: 9, alignItems: "flex-start", marginBottom: theme.spacing.md },
  guidanceText: { flex: 1, color: theme.color.muted, fontSize: 12, lineHeight: 18 },
  linkBtn: { alignSelf: "flex-start", borderWidth: 1, borderColor: theme.color.brandPrimary, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  linkBtnText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "700" },
  formTitleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: theme.spacing.md },
  formIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  cardTitle: { fontSize: 15, fontWeight: "700", color: theme.color.onSurface },
  hint: { color: theme.color.muted, fontSize: 11, marginTop: 2 },
  labelSpaced: { fontSize: 13, fontWeight: "600", color: theme.color.onSurface, marginTop: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 6 },
  chip: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 10 },
  chipActive: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.brandPrimary },
  chipText: { color: theme.color.onSurface, fontSize: 12, fontWeight: "600" },
  chipTextActive: { color: theme.color.onBrandPrimary || "#fff" },
  listCard: { marginTop: theme.spacing.md },
  listTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: theme.spacing.sm },
  listIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfaceTertiary },
  empty: { color: theme.color.muted, fontSize: 12, paddingVertical: theme.spacing.sm },
  entry: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: theme.spacing.sm, borderBottomWidth: 1, borderBottomColor: theme.color.border },
  entryName: { color: theme.color.onSurface, fontSize: 13, fontWeight: "700" },
  entryMeta: { color: theme.color.muted, fontSize: 11, marginTop: 3 },
  entryAmount: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: "800", marginTop: 2 },
  assetActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  assetBtn: { borderWidth: 1, borderColor: theme.color.brandPrimary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  assetBtnText: { color: theme.color.brandPrimary, fontSize: 11, fontWeight: "700" },
  disposeBtn: { borderWidth: 1, borderColor: theme.color.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  disposeBtnText: { color: theme.color.error, fontSize: 11, fontWeight: "700" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingTop: theme.spacing.md, marginTop: 2 },
  totalLabel: { color: theme.color.onSurface, fontSize: 13, fontWeight: "800" },
  total: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" },
}); }
