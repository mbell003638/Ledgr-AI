import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/context/ThemeContext';
import { v2Services } from '@/src/accountingV2/runtime';
import { V2DocumentService } from '@/src/accountingV2/documentService';
import { V2AppService } from '@/src/accountingV2/appService';

export type AuditLogEntry = {
  id: string;
  sourceType: string;
  date: string;
  memo: string;
  amount: number;
  partyName?: string;
  reversed: boolean;
  source: 'ai' | 'voice' | 'manual';
};

export type TransactionAuditModalProps = {
  visible: boolean;
  onClose: () => void;
  onTransactionReversed?: () => void;
};

export function TransactionAuditModal({
  visible,
  onClose,
  onTransactionReversed,
}: TransactionAuditModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [reversingId, setReversingId] = useState<string | null>(null);

  const loadAuditHistory = useCallback(async () => {
    setLoading(true);
    try {
      const services = v2Services();
      const appService = new V2AppService(services.repo.db);
      const ctx = await appService.activeContext();
      if (!ctx) {
        setEntries([]);
        return;
      }
      const runner = services.repo.db;
      const rows = await runner.all<{
        id: string;
        type: string;
        date: string;
        reference: string | null;
        metadata: string;
      }>(
        "SELECT id, type, date, reference, metadata FROM v2_sources WHERE book_id=? ORDER BY date DESC, id DESC LIMIT 50",
        [ctx.bookId]
      );

      const items: AuditLogEntry[] = rows.map((row: any) => {
        let meta: Record<string, any> = {};
        try {
          meta = JSON.parse(row.metadata || '{}');
        } catch {
          meta = {};
        }
        return {
          id: row.id,
          sourceType: row.type,
          date: row.date,
          memo: row.reference || meta.notes || meta.memo || `${row.type} entry`,
          amount: Number(meta.total || meta.amount || 0),
          partyName: meta.partyName || meta.clientName || meta.supplierName,
          reversed: Boolean(meta.reversed),
          source: meta.source === 'ai' ? 'ai' : meta.source === 'voice' ? 'voice' : 'manual',
        };
      });
      setEntries(items);
    } catch (err) {
      console.warn('Failed to load audit history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      loadAuditHistory();
    }
  }, [visible, loadAuditHistory]);

  /**
   * Domain-Aware Reversal Handler.
   * Routes the "Undo" operation through appropriate domain services
   * (updating subledgers like AR/AP and inventory alongside GL entries).
   */
  const handleDomainUndo = async (entry: AuditLogEntry) => {
    Alert.alert(
      'Undo Transaction',
      `Are you sure you want to reverse "${entry.memo}" of $${entry.amount.toFixed(2)}? Subledger balances and inventory will be restored.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Undo Transaction',
          style: 'destructive',
          onPress: async () => {
            setReversingId(entry.id);
            try {
              const services = v2Services();
              const appService = new V2AppService(services.repo.db);
              const documentService = new V2DocumentService(services.repo);
              const type = entry.sourceType;
              if (type === 'invoice') {
                await appService.deleteInvoice(entry.id);
              } else if (type === 'expense') {
                await appService.deleteExpense(entry.id);
              } else if (type === 'cash_sale' || type === 'sale') {
                await appService.deleteSale(entry.id);
              } else if (type === 'cash_purchase' || type === 'credit_purchase') {
                await appService.deleteBill(entry.id);
              } else if (type === 'supplier_payment' || type === 'drawing' || type === 'commission_payment') {
                await appService.deletePayment(entry.id);
              } else {
                await documentService.reverseSource(entry.id, type, `Undo ${type}`, true);
              }
              Alert.alert('Success', 'Transaction successfully reversed with subledger sync.');
              loadAuditHistory();
              onTransactionReversed?.();
            } catch (err: any) {
              Alert.alert('Reversal Failed', err?.message || 'Unable to reverse transaction.');
            } finally {
              setReversingId(null);
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: AuditLogEntry }) => (
    <View style={[styles.card, item.reversed && styles.cardReversed]}>
      <View style={styles.cardHeader}>
        <View style={styles.badgeRow}>
          <Text style={styles.typeBadge}>{item.sourceType.replace(/_/g, ' ').toUpperCase()}</Text>
          {item.source !== 'manual' && (
            <Text style={styles.aiBadge}>{item.source.toUpperCase()} CO-PILOT</Text>
          )}
          {item.reversed && <Text style={styles.reversedBadge}>REVERSED</Text>}
        </View>
        <Text style={styles.dateText}>{item.date}</Text>
      </View>

      <Text style={styles.memoText} numberOfLines={2}>
        {item.memo}
      </Text>

      {item.partyName ? <Text style={styles.partyText}>Party: {item.partyName}</Text> : null}

      <View style={styles.cardFooter}>
        <Text style={styles.amountText}>${item.amount.toFixed(2)}</Text>
        {!item.reversed && (
          <Pressable
            onPress={() => handleDomainUndo(item)}
            disabled={reversingId === item.id}
            style={({ pressed }) => [styles.undoButton, pressed && styles.pressed]}
          >
            {reversingId === item.id ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="arrow-undo-outline" size={14} color="#fff" />
                <Text style={styles.undoButtonText}>Undo</Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <Ionicons name="journal-outline" size={22} color={theme.color.onSurface} />
              <Text style={styles.headerTitle}>Audit Trail & Change Log</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={theme.color.onSurface} />
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.color.onSurface} />
              <Text style={styles.loadingText}>Loading immutable audit log...</Text>
            </View>
          ) : (
            <FlatList
              data={entries}
              keyExtractor={(item) => item.id}
              renderItem={renderItem}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No transaction records found.</Text>
                </View>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    container: {
      height: '80%',
      backgroundColor: theme.color.surface,
      borderTopLeftRadius: theme.radius.card,
      borderTopRightRadius: theme.radius.card,
      paddingTop: theme.spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.color.border,
    },
    headerTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.color.onSurface,
    },
    closeButton: {
      padding: theme.spacing.sm,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    loadingText: {
      color: theme.color.muted,
      fontSize: 14,
    },
    listContent: {
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    card: {
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.card,
      padding: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.color.border,
      gap: theme.spacing.sm,
    },
    cardReversed: {
      opacity: 0.6,
      backgroundColor: theme.color.surfaceTertiary,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    badgeRow: {
      flexDirection: 'row',
      gap: 6,
      alignItems: 'center',
    },
    typeBadge: {
      backgroundColor: theme.color.surfaceTertiary,
      color: theme.color.onSurface,
      fontSize: 10,
      fontWeight: '700',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
    },
    aiBadge: {
      backgroundColor: '#8B5CF620',
      color: '#8B5CF6',
      fontSize: 10,
      fontWeight: '700',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
    },
    reversedBadge: {
      backgroundColor: '#EF444420',
      color: '#EF4444',
      fontSize: 10,
      fontWeight: '700',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
    },
    dateText: {
      fontSize: 12,
      color: theme.color.muted,
    },
    memoText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.color.onSurface,
    },
    partyText: {
      fontSize: 12,
      color: theme.color.muted,
    },
    cardFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: theme.spacing.sm,
    },
    amountText: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.color.onSurface,
    },
    undoButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: '#EF4444',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 6,
      borderRadius: theme.radius.sm,
    },
    undoButtonText: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.7,
    },
    emptyContainer: {
      padding: theme.spacing.lg,
      alignItems: 'center',
    },
    emptyText: {
      color: theme.color.muted,
      fontSize: 14,
    },
  });
}
