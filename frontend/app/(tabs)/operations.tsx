import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Card, ScreenHeader } from "@/src/components/UI";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { isCapabilityEnabled, workspaceTileLabelsFor } from "@/src/utils/capabilities";

type Operation = { key: string; label: string; detail: string; icon: keyof typeof Ionicons.glyphMap; route: string; enabled: boolean };

export default function OperationsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setSettings(await api.getSettings()); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading || !settings) return <SafeAreaView style={styles.container} edges={["top"]}><ActivityIndicator style={styles.loading} color={theme.color.brandPrimary} /></SafeAreaView>;
  const labels = workspaceTileLabelsFor(settings);
  const operations: Operation[] = [
    { key: "sales", label: labels.sales || "Sales", detail: "Record cash sales and commercial orders.", icon: "trending-up-outline", route: "/sales", enabled: isCapabilityEnabled(settings, "commerce") },
    { key: "purchases", label: labels.bills || "Purchases", detail: "Record supplier bills, stock purchases, and payables.", icon: "cart-outline", route: "/bills", enabled: isCapabilityEnabled(settings, "procurement") },
    { key: "payments", label: labels.payments || "Payments", detail: "Pay suppliers or record capital withdrawals.", icon: "cash-outline", route: "/payments", enabled: isCapabilityEnabled(settings, "procurement") },
    { key: "receipts", label: labels.receipts || "Receipts", detail: "Record customer collections and advances.", icon: "receipt-outline", route: "/receipts", enabled: isCapabilityEnabled(settings, "invoicing") || isCapabilityEnabled(settings, "customers") },
    { key: "expenses", label: labels.expenses || "Expenses", detail: "Record operating expenses with an accountable category.", icon: "wallet-outline", route: "/expenses", enabled: isCapabilityEnabled(settings, "core_ledger") },
    { key: "cashbook", label: "Cash Book", detail: "Review cash, bank, card, and mobile movements.", icon: "swap-vertical-outline", route: "/cashbook", enabled: isCapabilityEnabled(settings, "cashbook") },
    { key: "stock", label: labels.inventory || "Stock counts", detail: "Review products, stock counts, and adjustments.", icon: "cube-outline", route: "/inventory-form", enabled: isCapabilityEnabled(settings, "inventory") },
    { key: "locations", label: "Locations & shop close", detail: "Separate tills, stock, physical counts, and shop closeout.", icon: "storefront-outline", route: "/locations", enabled: isCapabilityEnabled(settings, "multi_location") },
  ];

  return <SafeAreaView style={styles.container} edges={["top"]}>
    <ScreenHeader title="Operations" subtitle="Sales, purchases, payments, receipts, and shop controls" />
    <ScrollView contentContainerStyle={styles.content}>
      <Card style={styles.intro}><Ionicons name="grid-outline" size={20} color={theme.color.brandPrimary} /><Text style={styles.introText}>Your core finance operations are restored here as direct routes. They remain separated from reports and work with the active shop when multi-location is enabled.</Text></Card>
      <Text style={styles.section}>Record & manage</Text>
      {operations.filter((operation) => operation.enabled).map((operation) => <Pressable key={operation.key} accessibilityRole="button" accessibilityLabel={operation.label} onPress={() => router.push(operation.route as any)} style={styles.row}>
        <View style={styles.icon}><Ionicons name={operation.icon} size={21} color={theme.color.brandPrimary} /></View>
        <View style={styles.copy}><Text style={styles.label}>{operation.label}</Text><Text style={styles.detail}>{operation.detail}</Text></View>
        <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
      </Pressable>)}
      <Card style={styles.manage}><Text style={styles.manageTitle}>Need another workflow?</Text><Text style={styles.manageText}>Workspace capabilities control which operations appear here. Existing records are retained when a workflow is hidden.</Text><Pressable onPress={() => router.push("/customize-features" as any)} style={styles.manageButton}><Text style={styles.manageButtonText}>Customize workspace</Text><Ionicons name="options-outline" size={17} color={theme.color.brandPrimary} /></Pressable></Card>
    </ScrollView>
  </SafeAreaView>;
}

function makeStyles(theme: any) { return StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface }, loading: { marginTop: 44 }, content: { padding: 16, paddingBottom: 120 }, intro: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 18, backgroundColor: theme.color.brandPrimary + "0D", borderColor: theme.color.brandPrimary + "55", borderWidth: 1 }, introText: { flex: 1, color: theme.color.onSurface, fontSize: 12, lineHeight: 18 }, section: { color: theme.color.muted, fontSize: 11, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase", marginBottom: 9 }, row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 72, borderRadius: 16, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, marginBottom: 9 }, icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.color.brandPrimary + "15" }, copy: { flex: 1 }, label: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" }, detail: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 3 }, manage: { marginTop: 14 }, manageTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: "800" }, manageText: { color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 4 }, manageButton: { marginTop: 11, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5 }, manageButtonText: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: "800" },
}); }
