import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fmt } from "@/src/theme";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { ScreenHeader, Empty } from "@/src/components/UI";
import { ActionSheetModal, ActionSheetItem } from "@/src/components/ActionSheetModal";
import { GlowPressable } from "@/src/components/GlowPressable";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";

type PartyRow = { id: string; name: string; phone?: string; role: "customer"|"supplier"|"partner"|"both"; receivable: number; payable: number };

export default function PartiesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ action?: string }>();
  const [items, setItems] = useState<PartyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all'|'customer'|'supplier'|'partner'>('all');
  const [isPartnerMode, setIsPartnerMode] = useState(false);
  const [partyPromptVisible, setPartyPromptVisible] = useState(false);
  const [investorModalVisible, setInvestorModalVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      const settings: any = await api.getSettings().catch(() => ({}));
      const partnerActive = settings?.accountingStyle === "retail_partnership";
      setIsPartnerMode(partnerActive);

      setFilter((current) => !partnerActive && current === 'partner' ? 'all' : current);
      const [v2, investors] = await Promise.all([api.listParties().catch(() => []), api.listInvestors().catch(() => [])]);
      if (v2.length) {
        const mapped: PartyRow[] = v2.map((p: any) => ({
          id: p.id,
          name: p.name,
          phone: p.phone,
          role: (p.roles.includes('partner') ? 'partner' : (p.roles.includes('customer') && p.roles.includes('supplier') ? 'both' : p.roles.includes('customer') ? 'customer' : 'supplier')) as PartyRow['role'],
          receivable: p.receivable,
          payable: p.payable,
        })).sort((a: any, b: any) => a.name.localeCompare(b.name));

        // Inject partners from settings if in partner mode
        if (partnerActive) {
          for (const investor of investors) {
            if (investor.name && !mapped.some((x) => x.name.toLowerCase() === investor.name.toLowerCase())) {
              mapped.push({ id: investor.id, name: investor.name, role: "partner", receivable: 0, payable: 0 });
            }
          }
        }
        setItems(mapped);
        return;
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
      if (partnerActive) {
        for (const investor of investors) {
          if (investor.name && !byName.has(investor.name.toLowerCase())) {
            byName.set(investor.name.toLowerCase(), { id: investor.id, name: investor.name, role: "partner", receivable: 0, payable: 0 });
          }
        }
      }
      setItems([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  useEffect(() => {
    if (params.action === 'create') {
      setPartyPromptVisible(true);
      router.setParams({ action: undefined });
    }
  }, [params.action, router]);

  const visible = items.filter((x) => {
    if (filter === 'all') return true;
    if (filter === 'customer') return x.role === 'customer' || x.role === 'both';
    if (filter === 'supplier') return x.role === 'supplier' || x.role === 'both';
    if (filter === 'partner') return x.role === 'partner';
    return true;
  });

  const open = (p: PartyRow) => {
    if (p.role === 'partner') {
      if (isPartnerMode) router.push({ pathname: '/investor/[id]', params: { id: p.id } } as any);
      return;
    }
    const cId = p.id.includes('|') ? p.id.split('|')[1] : p.id;
    const sId = p.id.includes('|') ? p.id.split('|')[0] : p.id;
    if (p.role === 'customer' || p.role === 'both') router.push(`/customer/${cId}` as any);
    else router.push(`/supplier/${sId}` as any);
  };

  const createActions: ActionSheetItem[] = [
    {
      id: "customer",
      label: "Create Customer",
      icon: "person-outline",
      onPress: () => router.push('/party-form?type=customer' as any),
    },
    {
      id: "supplier",
      label: "Create Supplier",
      icon: "business-outline",
      onPress: () => router.push('/party-form?type=supplier' as any),
    },
  ];

  if (isPartnerMode) {
    createActions.push({
      id: "partner",
      label: "Add Investor",
      icon: "people-outline",
      onPress: () => setInvestorModalVisible(true),
    });
  }

  const availableFilters: ('all' | 'customer' | 'supplier' | 'partner')[] = isPartnerMode
    ? ['all', 'customer', 'supplier', 'partner']
    : ['all', 'customer', 'supplier'];

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title="Parties"
        subtitle={`${items.length} contact${items.length === 1 ? '' : 's'}`}
        rightAction={
          <Pressable
            testID="btn-add-party"
            onPress={() => {
              if (filter === 'customer') router.push('/party-form?type=customer' as any);
              else if (filter === 'supplier') router.push('/party-form?type=supplier' as any);
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
              {x === 'all' ? 'All' : x === 'customer' ? 'Customers' : x === 'supplier' ? 'Suppliers' : 'Investors'}
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
          ListEmptyComponent={
            <Empty
              icon={<Ionicons name="people-outline" size={40} color={theme.color.muted} />}
              title="No parties found"
              hint="Create a customer, add a supplier, or setup partners."
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
                <Text style={styles.sub}>{item.phone || 'No phone'} • {item.role === 'both' ? 'Customer & Supplier' : item.role}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                {item.receivable !== 0 ? <Text style={[styles.balance, { color: theme.color.success }]}>Receive {fmt(item.receivable)}</Text> : null}
                {item.payable !== 0 ? <Text style={[styles.balance, { color: theme.color.error }]}>Pay {fmt(item.payable)}</Text> : null}
                {item.receivable === 0 && item.payable === 0 ? <Text style={styles.sub}>{item.role === 'partner' ? 'View capital ledger' : 'Settled'}</Text> : null}
              </View>
            </GlowPressable>
          )}
        />
      )}

      <ActionSheetModal
        visible={partyPromptVisible}
        onClose={() => setPartyPromptVisible(false)}
        title="Create Party"
        subtitle="Select the type of contact you want to add"
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
  });
}
