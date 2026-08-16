import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { useScreenData } from "@/src/hooks/useScreenData";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { ActionSheetModal, ActionSheetItem } from "@/src/components/ActionSheetModal";
import { GlowPressable } from "@/src/components/GlowPressable";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";
import { isCapabilityEnabled, workspaceLabelsFor } from "@/src/utils/capabilities";

type PartyRow = { id: string; name: string; phone?: string; role: "customer"|"supplier"|"partner"|"both"; receivable: number; payable: number; capitalBalance?: number };

export default function PartiesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string }>();
  const [filter, setFilter] = useState<'all'|'customer'|'supplier'|'partner'>('all');
  const [partyPromptVisible, setPartyPromptVisible] = useState(false);
  const [investorModalVisible, setInvestorModalVisible] = useState(false);
  const [workspaceSettings, setWorkspaceSettings] = useState<any>({});
  useEffect(() => {
    let active = true;
    api.getSettings().then((value) => { if (active) setWorkspaceSettings(value || {}); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const workspaceLabels = useMemo(() => workspaceLabelsFor(workspaceSettings), [workspaceSettings]);
  const customersEnabled = isCapabilityEnabled(workspaceSettings, "customers");
  const procurementEnabled = isCapabilityEnabled(workspaceSettings, "procurement");

  const loader = useCallback(async (): Promise<{ items: PartyRow[]; isPartnerMode: boolean }> => {
    const config: any = await api.getV2BookConfig().catch(() => null);
    const partnerConfigured = config?.style === "retail_partnership";

    const [v2, investors] = await Promise.all([api.listParties().catch(() => []), api.listInvestors().catch(() => [])]);
    const partnerActive = partnerConfigured || investors.length > 0;
    if (v2.length) {
      const mapped: PartyRow[] = v2.map((p: any) => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        role: ((Array.isArray(p.roles) ? p.roles : []).includes('partner') ? 'partner' : ((Array.isArray(p.roles) ? p.roles : []).includes('customer') && (Array.isArray(p.roles) ? p.roles : []).includes('supplier') ? 'both' : (Array.isArray(p.roles) ? p.roles : []).includes('customer') ? 'customer' : 'supplier')) as PartyRow['role'],
        receivable: p.receivable,
        payable: p.payable,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));

      // Capital Accounts and parties use different authoritative IDs. Keep
      // separate rows even when their display names match so navigation can never
      // send a Supplier/Customer ID to the Capital Statement screen.
      if (partnerActive) {
        for (const investor of investors) {
          if (investor.name && !mapped.some((row) => row.role === "partner" && row.id === investor.id)) {
            mapped.push({ id: investor.id, name: investor.name, role: "partner", receivable: 0, payable: 0, capitalBalance: Number(investor.currentCapital || 0) });
          }
        }
      }
      return { items: mapped, isPartnerMode: partnerActive };
    }

    const [suppliers, debtors] = await Promise.all([api.listSuppliers(), api.listDebtors()]);
    const byName = new Map<string, PartyRow>();
    for (const s of suppliers as any[]) {
      const k = (s.name || '').trim().toLowerCase();
      byName.set(k, { id: s.id, name: s.name, phone: s.phone, role: 'supplier', receivable: 0, payable: Number(s.balance) || 0 });
    }
    for (const d of debtors as any[]) {
      const k = (d.name || '').trim().toLowerCase();
      const found = byName.get(k);
      if (found) {
        found.role = 'both';
        found.receivable = Number(d.balance) || 0;
        found.phone = found.phone || d.phone;
        found.id = `${found.id}|${d.id}`;
      } else {
        byName.set(k, { id: d.id, name: d.name, phone: d.phone, role: 'customer', receivable: Number(d.balance) || 0, payable: 0 });
      }
    }
    const investorRows: PartyRow[] = partnerActive
      ? investors.filter((investor: any) => Boolean(investor.name)).map((investor: any) => ({
          id: investor.id,
          name: investor.name,
          role: "partner" as const,
          receivable: 0,
          payable: 0,
          capitalBalance: Number(investor.currentCapital || 0),
        }))
      : [];
    return { items: [...byName.values(), ...investorRows].sort((a, b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role)), isPartnerMode: partnerActive };
  }, []);

  const { data, loading, refreshing, reload, refresh } = useScreenData(
    `parties:${api.activeBookId()}`,
    loader,
  );
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const isPartnerMode = data?.isPartnerMode ?? false;
  const load = reload;

  // Keep the "partner" filter valid: if partner mode is off, fall back to All.
  useEffect(() => {
    if (!isPartnerMode) setFilter((current) => (current === 'partner' ? 'all' : current));
  }, [isPartnerMode]);

  useEffect(() => {
    if (params.action === 'create') {
      setPartyPromptVisible(true);
      router.setParams({ action: undefined });
    }
  }, [params.action, router]);

  const visible = useMemo(() => items.filter((x) => {
    if (x.role === 'partner') return filter === 'all' || filter === 'partner';
    if (x.role === 'customer' && !customersEnabled) return false;
    if (x.role === 'supplier' && !procurementEnabled) return false;
    if (x.role === 'both' && !customersEnabled && !procurementEnabled) return false;
    if (filter === 'all') return true;
    if (filter === 'customer') return customersEnabled && (x.role === 'customer' || x.role === 'both');
    if (filter === 'supplier') return procurementEnabled && (x.role === 'supplier' || x.role === 'both');
    if (filter === 'partner') return false;
    return true;
  }), [customersEnabled, filter, items, procurementEnabled]);

  const open = (p: PartyRow) => {
    if (p.role === 'partner') {
      if (isPartnerMode) router.push({ pathname: '/investor/[id]', params: { id: p.id } } as any);
      return;
    }
    const cId = p.id.includes('|') ? p.id.split('|')[1] : p.id;
    const sId = p.id.includes('|') ? p.id.split('|')[0] : p.id;
    if ((p.role === 'customer' || p.role === 'both') && customersEnabled) router.push(`/customer/${cId}` as any);
    else router.push(`/supplier/${sId}` as any);
  };

  const createActions: ActionSheetItem[] = [];
  if (customersEnabled) createActions.push({
    id: "customer",
    label: `Create ${workspaceLabels.customerLabel.replace(/s$/, "")}`,
    icon: "person-outline",
    onPress: () => router.push('/party-form?type=customer' as any),
  });
  if (procurementEnabled) createActions.push({
    id: "supplier",
    label: `Create ${workspaceLabels.supplierLabel.replace(/s$/, "")}`,
    icon: "business-outline",
    onPress: () => router.push('/party-form?type=supplier' as any),
  });

  if (isPartnerMode) {
    createActions.push({
      id: "partner",
      label: "Add Capital Account",
      icon: "people-outline",
      onPress: () => setInvestorModalVisible(true),
    });
  }

  // Filter vocabulary remains ['all', 'customer', 'supplier', 'partner']; persona capabilities decide which options are shown.
  const availableFilters = useMemo<('all' | 'customer' | 'supplier' | 'partner')[]>(() => [
    'all',
    ...(customersEnabled ? ['customer' as const] : []),
    ...(procurementEnabled ? ['supplier' as const] : []),
    ...(isPartnerMode ? ['partner' as const] : []),
  ], [customersEnabled, isPartnerMode, procurementEnabled]);
  useEffect(() => {
    if (!availableFilters.includes(filter)) setFilter('all');
  }, [availableFilters, filter]);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title={workspaceLabels.accountsTitle}
        subtitle={`${items.length} account${items.length === 1 ? '' : 's'}`}
        rightAction={
          <Pressable
            testID="btn-add-party"
            onPress={() => {
              if (filter === 'customer' && customersEnabled) router.push('/party-form?type=customer' as any);
              else if (filter === 'supplier' && procurementEnabled) router.push('/party-form?type=supplier' as any);
              else if (filter === 'partner') setInvestorModalVisible(true);
              else setPartyPromptVisible(true);
            }}
            style={styles.addBtn}
          >
            <Ionicons name="add" size={22} color="#fff" />
          </Pressable>
        }
      />

      <View style={styles.filters}>
        {availableFilters.map((x) => (
          <GlowPressable
            key={x}
            haptic
            topHighlight={false}
            hoverLift={0}
            hoverScale={1}
            restingBorderColor={filter === x ? theme.color.brandPrimary : theme.color.border}
            onPress={() => setFilter(x)}
            style={[styles.filter, filter === x && styles.filterOn]}
          >
            <Text style={[styles.filterText, filter === x && { color: '#fff' }]}>
              {x === 'all' ? 'All' : x === 'customer' ? 'Customers' : x === 'supplier' ? 'Suppliers' : 'Capital Accounts'}
            </Text>
          </GlowPressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={theme.color.brandPrimary} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(x) => `${x.role}:${x.id}`}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="people-outline" size={40} color={theme.color.muted} />}
              title={`No ${workspaceLabels.accountsTitle.toLowerCase()} found`}
              hint={workspaceLabels.emptyAccountsHint}
            />
          }
          renderItem={({ item }) => (
            <GlowPressable
              haptic
              topHighlight={false}
              hoverLift={0}
              hoverScale={1}
              restingBorderColor={theme.color.border}
              onPress={() => open(item)}
              style={styles.card}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{item.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.sub}>{item.phone || 'No phone'} • {item.role === 'both' ? `${workspaceLabels.customerLabel} & ${workspaceLabels.supplierLabel}` : item.role === 'partner' ? 'Capital Account' : item.role === 'customer' ? workspaceLabels.customerLabel : workspaceLabels.supplierLabel}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                {item.receivable !== 0 ? <Text style={[styles.balance, { color: theme.color.success }]}>Receive {fmt(item.receivable)}</Text> : null}
                {item.payable !== 0 ? <Text style={[styles.balance, { color: theme.color.error }]}>Pay {fmt(item.payable)}</Text> : null}
                {item.role === 'partner' ? <>
                  <Text style={[styles.balance, { color: theme.color.brandPrimary }]}>Capital {fmt(item.capitalBalance || 0)}</Text>
                  <Text style={styles.sub}>View Capital Statement</Text>
                  {isPartnerMode ? (
                    <Pressable
                      testID={`btn-quick-capital-${item.id}`}
                      accessibilityLabel={`Add capital for ${item.name}`}
                      // Same flow as the investor detail screen's Deposit Capital
                      // button: route there with action=deposit so the sheet
                      // auto-opens and posts via api.depositInvestorCapital.
                      onPress={() => router.push({ pathname: '/investor/[id]', params: { id: item.id, action: 'deposit' } } as any)}
                      style={styles.capitalBtn}
                    >
                      <Ionicons name="add" size={12} color={theme.color.brandPrimary} />
                      <Text style={styles.capitalBtnText}>Add Capital</Text>
                    </Pressable>
                  ) : null}
                </> : item.receivable === 0 && item.payable === 0 ? <Text style={styles.sub}>Settled</Text> : null}
              </View>
            </GlowPressable>
          )}
        />
      )}

      <ActionSheetModal
        visible={partyPromptVisible}
        onClose={() => setPartyPromptVisible(false)}
        title="Add Business Account"
        subtitle="Choose the account type to add"
        actions={createActions}
        animatedActions
      />

      <OpeningBalancesModal
        visible={investorModalVisible}
        mode="investor"
        onClose={() => setInvestorModalVisible(false)}
        onSuccess={() => { setInvestorModalVisible(false); load(); }}
      />
    </SafeAreaView>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: t.color.surface },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: t.spacing.lg },
    addBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: t.color.brandPrimary, justifyContent: 'center', alignItems: 'center', marginTop: t.spacing.md },
    filters: { flexDirection: 'row', gap: 8, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.md },
    filter: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: t.color.border },
    filterOn: { backgroundColor: t.color.brandPrimary, borderColor: t.color.brandPrimary },
    filterText: { fontWeight: '700', fontSize: 12, color: t.color.onSurface, textTransform: 'capitalize' },
    list: { paddingHorizontal: t.spacing.lg, paddingBottom: 140, gap: t.spacing.md },
    card: { flexDirection: 'row', backgroundColor: t.color.surfaceSecondary, borderRadius: t.radius.lg, padding: t.spacing.lg, borderWidth: 1, borderColor: t.color.border, alignItems: 'center', gap: t.spacing.md, elevation: 0, shadowOpacity: 0, shadowRadius: 0 },
    avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: t.color.brandTertiary, justifyContent: 'center', alignItems: 'center' },
    avatarText: { color: t.color.brandPrimary, fontWeight: '800' },
    name: { fontSize: 15, fontWeight: '700', color: t.color.onSurface },
    sub: { fontSize: 12, color: t.color.muted, marginTop: 2, textTransform: 'capitalize' },
    balance: { fontSize: 12, fontWeight: '700', marginTop: 2 },
    capitalBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: t.color.brandPrimary, backgroundColor: t.color.brandPrimary + '14' },
    capitalBtnText: { fontSize: 11, fontWeight: '700', color: t.color.brandPrimary },
  });
}
