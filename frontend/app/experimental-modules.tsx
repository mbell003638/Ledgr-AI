import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { EXPERIMENTAL_MODULES } from '@/src/utils/experimentalModules';

export default function ExperimentalModulesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}><Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable><View style={{ flex: 1 }}><ScreenHeader embedded title="Experimental Modules" subtitle="Safety-gated previews" /></View></View>
      <ScrollView contentContainerStyle={styles.content}>
        <Card shadowEnabled={false} style={styles.notice}><Ionicons name="flask-outline" size={24} color={theme.color.warning} /><View style={{ flex: 1 }}><Text style={styles.noticeTitle}>No experimental module can silently post</Text><Text style={styles.hint}>Preview-only tools are isolated from accounting commands. Blocked modules have no route or enable switch.</Text></View></Card>
        {EXPERIMENTAL_MODULES.map((module) => (
          <Card key={module.key} shadowEnabled={false} style={styles.card}>
            <View style={styles.titleRow}><Text style={styles.title}>{module.label}</Text><View style={[styles.badge, module.status === 'preview_only' ? styles.previewBadge : styles.blockedBadge]}><Text style={styles.badgeText}>{module.status === 'preview_only' ? 'PREVIEW ONLY' : 'BLOCKED'}</Text></View></View>
            <Text style={styles.hint}>{module.summary}</Text>
            <Text style={styles.subheading}>Current safeguards</Text>
            {module.safeguards.map((item) => <Text key={item} style={styles.item}>• {item}</Text>)}
            <Text style={styles.subheading}>Required before production</Text>
            {module.missingBeforeProduction.map((item) => <Text key={item} style={styles.item}>• {item}</Text>)}
            {module.status === 'preview_only' && module.route ? <Pressable onPress={() => router.push(module.route as any)} style={styles.openButton}><Text style={styles.openText}>Open Safe Preview</Text><Ionicons name="chevron-forward" size={18} color={theme.color.brandPrimary} /></Pressable> : null}
          </Card>
        ))}
        <View style={{ height: 70 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: theme.spacing.lg, paddingTop: 12 },
    content: { padding: theme.spacing.lg, gap: 12 },
    notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderColor: theme.color.warning },
    noticeTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '700' },
    card: { gap: 6 },
    titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    title: { flex: 1, color: theme.color.onSurface, fontSize: 16, fontWeight: '700' },
    hint: { color: theme.color.muted, fontSize: 12, lineHeight: 17 },
    badge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
    previewBadge: { backgroundColor: theme.color.warning + '22' },
    blockedBadge: { backgroundColor: theme.color.error + '18' },
    badgeText: { color: theme.color.onSurface, fontSize: 9, fontWeight: '700' },
    subheading: { color: theme.color.brandPrimary, fontSize: 11, fontWeight: '700', marginTop: 5, textTransform: 'uppercase' },
    item: { color: theme.color.muted, fontSize: 11, lineHeight: 16 },
    openButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.color.border, paddingTop: 10, marginTop: 6 },
    openText: { color: theme.color.brandPrimary, fontSize: 13, fontWeight: '700' },
  });
}
