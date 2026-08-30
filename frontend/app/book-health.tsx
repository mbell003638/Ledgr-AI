import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '@/src/api';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import type { BookHealth, BookHealthTone } from '@/src/utils/bookHealth';
import { SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

const iconFor = (tone: BookHealthTone) => tone === 'healthy' ? 'checkmark-circle' : tone === 'attention' ? 'alert-circle' : 'close-circle';

export default function BookHealthScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [health, setHealth] = useState<BookHealth | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setHealth(await api.getBookHealth()); }
    catch (error) { console.warn('book health', error); }
    finally { setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const colorFor = (tone: BookHealthTone) => tone === 'healthy' ? theme.color.success : tone === 'attention' ? theme.color.warning : theme.color.error;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}><ScreenHeader embedded title="Book Health" subtitle="Read-only accounting and recovery checks" /></View>
      </View>
      {!health ? <ActivityIndicator style={{ marginTop: 48 }} color={theme.color.brandPrimary} /> : (
        <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}>
          <Card shadowEnabled={false} style={[styles.summary, { borderColor: colorFor(health.tone) }]}>
            <Ionicons name={iconFor(health.tone) as any} size={30} color={colorFor(health.tone)} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.summaryTitle, { color: colorFor(health.tone) }]}>{health.label}</Text>
              <Text style={styles.summaryText}>Checked {new Date(health.checkedAt).toLocaleString()}</Text>
            </View>
          </Card>
          <Card shadowEnabled={false} style={{ padding: 0, overflow: 'hidden' }}>
            {health.checks.map((check) => (
              <View key={check.key} style={styles.checkRow}>
                <Ionicons name={iconFor(check.tone) as any} size={21} color={colorFor(check.tone)} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.checkTitle}>{check.label}</Text>
                  <Text style={styles.checkDetail}>{check.detail}</Text>
                </View>
              </View>
            ))}
          </Card>
          <Text style={styles.note}>Book Health never changes transactions. It reports issues for the active Business Account so you can review them safely.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: theme.spacing.lg, paddingTop: 16, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM },
    content: { padding: theme.spacing.lg, paddingTop: SETTINGS_SCREEN_CONTENT_TOP },
    summary: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: theme.spacing.lg, borderWidth: 1 },
    summaryTitle: { fontSize: 18, fontWeight: '700' },
    summaryText: { color: theme.color.muted, fontSize: 11, marginTop: 3 },
    checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
    checkTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '700' },
    checkDetail: { color: theme.color.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
    note: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: theme.spacing.lg },
  });
}
