import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { getHostingModeState, HOSTING_CONCEPT_COPY, HOSTING_MODE_DESCRIPTIONS, HOSTING_MODE_LABELS, hostingModeSummary, type HostingModeState } from '@/src/utils/hostingMode';
import { useTheme } from '@/src/context/ThemeContext';

export function HostingModeCard({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  const [state, setState] = useState<HostingModeState | null>(null);
  useEffect(() => {
    let mounted = true;
    void getHostingModeState().then((next) => { if (mounted) setState(next); });
    return () => { mounted = false; };
  }, []);
  if (!state) return null;
  const local = state.mode === 'local_only';
  const color = local ? (theme.color.warning || theme.color.brandPrimary) : (theme.color.success || theme.color.brandPrimary);
  return (
    <View testID="hosting-mode-card" style={{ borderWidth: 1, borderColor: `${color}55`, backgroundColor: `${color}0D`, borderRadius: 16, padding: compact ? 12 : 16, marginTop: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <Ionicons name={local ? 'phone-portrait-outline' : 'cloud-done-outline'} size={20} color={color} />
        <Text style={{ flex: 1, color, fontSize: 14, fontWeight: '800' }}>{HOSTING_MODE_LABELS[state.mode]}</Text>
        <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{local ? 'No server required' : state.enabled ? 'Enabled' : 'Configured'}</Text>
      </View>
      <Text style={{ color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 6 }}>{compact ? hostingModeSummary(state) : HOSTING_MODE_DESCRIPTIONS[state.mode]}</Text>
      {!compact ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <Pressable testID="open-backup-recovery" onPress={() => router.push('/backup-recovery' as any)} style={{ borderWidth: 1, borderColor: `${color}66`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color, fontSize: 12, fontWeight: '700' }}>{HOSTING_CONCEPT_COPY.backup}</Text></Pressable>
        <Pressable testID="open-private-sync" onPress={() => router.push('/sync-settings' as any)} style={{ borderWidth: 1, borderColor: `${color}66`, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }}><Text style={{ color, fontSize: 12, fontWeight: '700' }}>{HOSTING_CONCEPT_COPY.sync}</Text></Pressable>
      </View> : null}
    </View>
  );
}
