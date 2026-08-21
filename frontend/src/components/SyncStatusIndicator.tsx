import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { api } from '@/src/api';
import { useTheme } from '@/src/context/ThemeContext';

type Status = { configured?: boolean; enabled?: boolean; pending?: number; retryable?: number; conflicts?: number; lastSyncError?: string; lastError?: string };

export function SyncStatusIndicator() {
  const theme = useTheme();
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(async () => { try { setStatus(await api.getSyncStatus() as Status); } catch { setStatus(null); } }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 20_000); return () => clearInterval(timer); }, [refresh]);
  if (!status?.configured) return null;
  const queue = Number(status.pending || 0) + Number(status.retryable || 0);
  const conflicts = Number(status.conflicts || 0);
  const error = Boolean(status.lastSyncError || status.lastError);
  if (!queue && !conflicts && !error) return null;
  const label = error ? 'Sync attention' : conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : `${queue} queued`;
  const color = error ? (theme.color.error || '#c53b3b') : (theme.color.warning || '#B7791F');
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}. Open Sync Health`} onPress={() => router.push('/sync-health' as any)} style={[styles.pill, { backgroundColor: theme.color.surfaceSecondary, borderColor: `${color}88`, top: Platform.OS === 'web' ? 10 : 54 }]}><Ionicons name={error ? 'alert-circle-outline' : 'cloud-upload-outline'} size={15} color={color} /><Text style={[styles.text, { color }]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({ pill: { position: 'absolute', right: 12, zIndex: 20, elevation: 20, flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 6 }, text: { fontSize: 11, fontWeight: '800' } });
