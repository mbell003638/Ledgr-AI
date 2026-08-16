import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { localTodayIso } from '@/src/utils/dateValidation';
import { Card } from '@/src/components/UI';
import { GlowPressable } from '@/src/components/GlowPressable';

type Order = { id: string; platform: string; external_order_id: string; date: string; status: string; gross: number; marketplace_fee: number; shipping_fee: number; refund: number; rto_fee: number; net: number; currency: string };
type Settlement = { id: string; platform: string; settlement_id: string; date: string; payout: number; currency: string };
const n = (value: string) => Number(value.trim() || 0);

export default function MarketplaceScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'orders' | 'settlements'>('orders');
  const [platform, setPlatform] = useState('Marketplace');
  const [orderId, setOrderId] = useState('');
  const [date, setDate] = useState(localTodayIso());
  const [gross, setGross] = useState('');
  const [tax, setTax] = useState('');
  const [fee, setFee] = useState('');
  const [shipping, setShipping] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [rate, setRate] = useState('1');
  const [settlementId, setSettlementId] = useState('');
  const [payout, setPayout] = useState('');
  const [selected, setSelected] = useState<Order | null>(null);
  const [adjustment, setAdjustment] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orderRows, settlementRows] = await Promise.all([api.listMarketplaceOrders(), api.listMarketplaceSettlements()]);
      setOrders(orderRows as Order[]); setSettlements(settlementRows as Settlement[]);
    } catch (error: any) { setMessage(error?.message || 'Could not load marketplace operations.'); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const saveOrder = async () => {
    if (!orderId.trim() || n(gross) <= 0) { setMessage('Enter an external order ID and a gross amount.'); return; }
    setSaving(true); setMessage('');
    try {
      await api.createMarketplaceOrder({ platform, externalOrderId: orderId, date, gross: n(gross), tax: n(tax), marketplaceFee: n(fee), shippingFee: n(shipping), currency, exchangeRate: n(rate) || 1, settlementId: settlementId.trim() || undefined });
      setOrderId(''); setGross(''); setTax(''); setFee(''); setShipping(''); await load(); setMessage('Marketplace order posted to the V2 ledger.');
    } catch (error: any) { setMessage(error?.message || 'Could not post marketplace order.'); }
    finally { setSaving(false); }
  };

  const saveSettlement = async () => {
    if (!settlementId.trim() || n(payout) <= 0) { setMessage('Enter a settlement ID and payout amount.'); return; }
    setSaving(true); setMessage('');
    try {
      await api.createMarketplaceSettlement({ platform, settlementId, date, payout: n(payout), currency, exchangeRate: n(rate) || 1 });
      setSettlementId(''); setPayout(''); await load(); setMessage('Marketplace payout settlement posted to the V2 ledger.');
    } catch (error: any) { setMessage(error?.message || 'Could not post marketplace settlement.'); }
    finally { setSaving(false); }
  };

  const saveAdjustment = async (kind: 'refund' | 'rto') => {
    if (!selected || n(adjustment) <= 0) { setMessage(kind === 'rto' ? 'Enter the RTO fee.' : 'Enter the refund amount.'); return; }
    setSaving(true); setMessage('');
    try {
      if (kind === 'refund') await api.recordMarketplaceRefund({ orderId: selected.id, date: localTodayIso(), amount: n(adjustment) });
      else await api.recordMarketplaceRto({ orderId: selected.id, date: localTodayIso(), fee: n(adjustment) });
      setSelected(null); setAdjustment(''); await load(); setMessage(`${kind === 'rto' ? 'RTO' : 'Refund'} adjustment posted to the V2 ledger.`);
    } catch (error: any) { setMessage(error?.message || 'Could not post marketplace adjustment.'); }
    finally { setSaving(false); }
  };

  return <SafeAreaView style={styles.container} edges={['top']}>
    <View style={styles.header}><GlowPressable topHighlight={false} animateBorder={false} restingBorderColor="transparent" onPress={() => router.back()} accessibilityLabel="Back" style={styles.back}><Ionicons name="arrow-back" size={22} color={theme.color.onSurface} /></GlowPressable><View style={{ flex: 1 }}><Text style={styles.title}>Marketplace Operations</Text><Text style={styles.subtitle}>Orders, fees, payouts, refunds, and RTO</Text></View></View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card><Text style={styles.sectionTitle}>Post marketplace order</Text><Text style={styles.help}>Gross revenue is credited to Sales; fees, shipping, refunds, and RTO are posted to their dedicated V2 accounts.</Text><Field label="Platform" value={platform} onChangeText={setPlatform} styles={styles} /><Field label="External order ID" value={orderId} onChangeText={setOrderId} styles={styles} /><View style={styles.row}><View style={{ flex: 1 }}><Field label="Date" value={date} onChangeText={setDate} styles={styles} /></View><View style={{ flex: 1 }}><Field label="Currency" value={currency} onChangeText={setCurrency} styles={styles} /></View></View><View style={styles.row}><View style={{ flex: 1 }}><Field label="Gross" value={gross} onChangeText={setGross} keyboard="decimal-pad" styles={styles} /></View><View style={{ flex: 1 }}><Field label="Tax" value={tax} onChangeText={setTax} keyboard="decimal-pad" styles={styles} /></View></View><View style={styles.row}><View style={{ flex: 1 }}><Field label="Marketplace fee" value={fee} onChangeText={setFee} keyboard="decimal-pad" styles={styles} /></View><View style={{ flex: 1 }}><Field label="Shipping" value={shipping} onChangeText={setShipping} keyboard="decimal-pad" styles={styles} /></View></View><Field label="Exchange rate to book currency" value={rate} onChangeText={setRate} keyboard="decimal-pad" styles={styles} /><GlowPressable onPress={saveOrder} disabled={saving} style={styles.primary}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Post order</Text>}</GlowPressable></Card>
      <View style={styles.tabs}><Pressable onPress={() => setTab('orders')} style={[styles.tab, tab === 'orders' && styles.tabActive]}><Text style={[styles.tabText, tab === 'orders' && styles.tabTextActive]}>Orders ({orders.length})</Text></Pressable><Pressable onPress={() => setTab('settlements')} style={[styles.tab, tab === 'settlements' && styles.tabActive]}><Text style={[styles.tabText, tab === 'settlements' && styles.tabTextActive]}>Settlements ({settlements.length})</Text></Pressable></View>
      {tab === 'settlements' && <Card><Text style={styles.sectionTitle}>Post payout settlement</Text><Text style={styles.help}>The payout debits Bank and clears the marketplace clearing account. Use the settlement ID to compare the payout with imported orders.</Text><Field label="Settlement ID" value={settlementId} onChangeText={setSettlementId} styles={styles} /><Field label="Payout amount" value={payout} onChangeText={setPayout} keyboard="decimal-pad" styles={styles} /><GlowPressable onPress={saveSettlement} disabled={saving} style={styles.primary}>{saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Post settlement</Text>}</GlowPressable></Card>}
      {loading ? <ActivityIndicator style={{ marginTop: 18 }} color={theme.color.brandPrimary} /> : tab === 'orders' ? orders.map((order) => <Card key={order.id} style={{ marginTop: 10 }}><View style={styles.itemHeader}><View style={{ flex: 1 }}><Text style={styles.itemTitle}>{order.platform} · {order.external_order_id}</Text><Text style={styles.help}>{order.date} · {order.status.toUpperCase()}</Text></View><Text style={styles.amount}>{order.currency} {Number(order.net || 0).toFixed(2)}</Text></View><Text style={styles.detail}>Gross {Number(order.gross || 0).toFixed(2)} · Fees {Number(order.marketplace_fee || 0).toFixed(2)} · Shipping {Number(order.shipping_fee || 0).toFixed(2)}</Text><View style={styles.actions}><Pressable onPress={() => { setSelected(order); setAdjustment(''); }} style={styles.secondary}><Text style={styles.secondaryText}>Refund / RTO</Text></Pressable></View></Card>) : settlements.map((settlement) => <Card key={settlement.id} style={{ marginTop: 10 }}><View style={styles.itemHeader}><View style={{ flex: 1 }}><Text style={styles.itemTitle}>{settlement.platform} · {settlement.settlement_id}</Text><Text style={styles.help}>{settlement.date}</Text></View><Text style={styles.amount}>{settlement.currency} {Number(settlement.payout || 0).toFixed(2)}</Text></View><Pressable onPress={async () => { try { const result = await api.reconcileMarketplaceSettlement(settlement.platform, settlement.settlement_id); setMessage(`Expected ${result.expectedPayout.toFixed(2)} · Variance ${result.variance.toFixed(2)} · ${result.orderCount} linked order(s).`); } catch (error: any) { setMessage(error?.message || 'Could not reconcile settlement.'); } }} style={styles.secondary}><Text style={styles.secondaryText}>Reconcile linked orders</Text></Pressable></Card>)}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
    <Modal visible={Boolean(selected)} transparent animationType="slide" onRequestClose={() => setSelected(null)}><View style={styles.modalBackdrop}><View style={styles.modal}><Text style={styles.sectionTitle}>Adjust {selected?.external_order_id}</Text><Text style={styles.help}>Enter a refund amount or RTO fee. Each action posts a separate correcting journal.</Text><Field label="Amount" value={adjustment} onChangeText={setAdjustment} keyboard="decimal-pad" styles={styles} /><View style={styles.row}><Pressable onPress={() => saveAdjustment('refund')} style={[styles.primary, { flex: 1 }]}><Text style={styles.primaryText}>Post refund</Text></Pressable><Pressable onPress={() => saveAdjustment('rto')} style={[styles.secondary, { flex: 1 }]}><Text style={styles.secondaryText}>Post RTO fee</Text></Pressable></View><Pressable onPress={() => setSelected(null)} style={styles.cancel}><Text style={styles.secondaryText}>Cancel</Text></Pressable></View></View></Modal>
  </SafeAreaView>;
}

function Field({ label, value, onChangeText, keyboard = 'default', styles }: { label: string; value: string; onChangeText: (value: string) => void; keyboard?: 'default' | 'decimal-pad'; styles: ReturnType<typeof makeStyles> }) { return <View style={{ marginBottom: 9 }}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} keyboardType={keyboard} placeholderTextColor="#89958E" style={styles.input} /></View>; }

function makeStyles(theme: any) { return StyleSheet.create({ container: { flex: 1, backgroundColor: theme.color.surface }, header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: theme.color.border }, back: { padding: 4 }, title: { color: theme.color.onSurface, fontSize: 17, fontWeight: '800' }, subtitle: { color: theme.color.muted, fontSize: 11, marginTop: 2 }, content: { padding: 14, paddingBottom: 50 }, sectionTitle: { color: theme.color.onSurface, fontSize: 15, fontWeight: '900', marginBottom: 5 }, help: { color: theme.color.muted, fontSize: 11, lineHeight: 16 }, label: { color: theme.color.muted, fontSize: 10, fontWeight: '800', marginBottom: 3 }, input: { borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, borderRadius: 10, padding: 10, color: theme.color.onSurface, fontSize: 13 }, row: { flexDirection: 'row', gap: 8 }, primary: { backgroundColor: theme.color.brandPrimary, borderRadius: 12, padding: 12, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, primaryText: { color: '#fff', fontWeight: '800', fontSize: 12 }, tabs: { flexDirection: 'row', marginTop: 14, borderBottomWidth: 1, borderBottomColor: theme.color.border }, tab: { flex: 1, padding: 12, alignItems: 'center' }, tabActive: { borderBottomWidth: 2, borderBottomColor: theme.color.brandPrimary }, tabText: { color: theme.color.muted, fontSize: 12, fontWeight: '800' }, tabTextActive: { color: theme.color.brandPrimary }, itemHeader: { flexDirection: 'row', alignItems: 'center' }, itemTitle: { color: theme.color.onSurface, fontSize: 13, fontWeight: '800' }, amount: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: '900' }, detail: { color: theme.color.muted, fontSize: 11, marginTop: 8 }, actions: { flexDirection: 'row', marginTop: 10 }, secondary: { borderWidth: 1, borderColor: theme.color.brandPrimary, borderRadius: 10, padding: 9, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: theme.color.brandPrimary, fontWeight: '800', fontSize: 11 }, message: { color: theme.color.brandPrimary, fontSize: 12, lineHeight: 17, marginTop: 14 }, modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }, modal: { backgroundColor: theme.color.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18 }, cancel: { alignItems: 'center', padding: 12, marginTop: 6 } }); }
