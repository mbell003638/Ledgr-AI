import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { api } from '@/src/api';
import { Card, ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { CAPABILITIES, getWorkspaceProfile, type OperationalModule } from '@/src/utils/workspaceCapabilities';
import { SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

export default function WorkflowsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [settings, setSettings] = useState<any>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    api.getSettings().then((value) => { if (active) setSettings(value); }).catch((error) => console.warn('workflows', error));
    return () => { active = false; };
  }, []));

  if (!settings) return <SafeAreaView style={styles.container}><ActivityIndicator style={{ marginTop: 48 }} color={theme.color.brandPrimary} /></SafeAreaView>;
  const profile = getWorkspaceProfile(settings);
  const modules = [...profile.featured, ...profile.advanced];
  const moduleRow = (module: OperationalModule) => (
    <Pressable key={module.key} accessibilityRole="button" onPress={() => router.push(module.route as any)} style={styles.row}>
      <View style={styles.icon}><Ionicons name={module.icon as any} size={20} color={theme.color.brandPrimary} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{module.label}</Text>
        <Text style={styles.rowDescription}>{module.description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.color.muted} />
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}><ScreenHeader embedded title="All Workflows" subtitle={profile.title} /></View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Card shadowEnabled={false} style={styles.introCard}>
          <Text style={styles.introTitle}>{profile.title}</Text>
          <Text style={styles.introText}>{profile.summary}</Text>
          <Text style={styles.introNote}>Only enabled workflows appear here. Hiding a workflow never deletes its saved accounting data.</Text>
        </Card>
        {CAPABILITIES.map((capability) => {
          const rows = modules.filter((module) => module.capability === capability.key);
          if (!rows.length) return null;
          return (
            <View key={capability.key} style={styles.section}>
              <Text style={styles.sectionTitle}>{capability.label}</Text>
              <Text style={styles.sectionDescription}>{capability.description}</Text>
              <Card shadowEnabled={false} style={{ padding: 0, overflow: 'hidden' }}>{rows.map(moduleRow)}</Card>
            </View>
          );
        })}
        <Pressable onPress={() => router.push('/customize-features' as any)} style={styles.customizeButton}>
          <Ionicons name="options-outline" size={19} color={theme.color.onBrandPrimary} />
          <Text style={styles.customizeText}>Customize Workflows</Text>
        </Pressable>
        <View style={{ height: 80 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: theme.spacing.lg, paddingTop: 16, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM },
    content: { padding: theme.spacing.lg, paddingTop: SETTINGS_SCREEN_CONTENT_TOP },
    introCard: { marginBottom: theme.spacing.lg },
    introTitle: { color: theme.color.brandPrimary, fontSize: 17, fontWeight: '700' },
    introText: { color: theme.color.onSurface, fontSize: 13, lineHeight: 19, marginTop: 5 },
    introNote: { color: theme.color.muted, fontSize: 11, lineHeight: 16, marginTop: 10 },
    section: { marginBottom: theme.spacing.lg },
    sectionTitle: { color: theme.color.onSurface, fontSize: 15, fontWeight: '700' },
    sectionDescription: { color: theme.color.muted, fontSize: 12, marginTop: 2, marginBottom: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
    icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.brandPrimary + '14' },
    rowTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '600' },
    rowDescription: { color: theme.color.muted, fontSize: 11, lineHeight: 15, marginTop: 2 },
    customizeButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, padding: 14 },
    customizeText: { color: theme.color.onBrandPrimary, fontSize: 14, fontWeight: '700' },
  });
}
