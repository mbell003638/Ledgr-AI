import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, Pressable, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ScreenHeader, Card } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { api } from '@/src/api';
import { workspacePackFor } from '@/src/utils/workspacePacks';
import type { OperationalModule } from '@/src/utils/operationalModules';

function ModuleCard({ module, onPress, theme }: { module: OperationalModule; onPress: () => void; theme: any }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${module.label}`} onPress={onPress} style={{ width: '48%', minHeight: 112, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary, marginBottom: 10 }}>
      <View style={{ width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.brandPrimary + '18', marginBottom: 8 }}>
        <Ionicons name="grid-outline" size={16} color={theme.color.brandPrimary} />
      </View>
      <Text numberOfLines={1} style={{ color: theme.color.onSurface, fontWeight: '800', fontSize: 13 }}>{module.label}</Text>
      <Text numberOfLines={3} style={{ color: theme.color.muted, fontSize: 10, lineHeight: 14, marginTop: 4 }}>{module.description}</Text>
    </Pressable>
  );
}

export default function ModulesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [settings, setSettings] = useState<any>({});
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    setRefreshing(true);
    try { setSettings(await api.getSettings()); } finally { setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const pack = workspacePackFor(settings);
  const openModule = (module: OperationalModule) => router.push((module.routes[0] || '/reports') as any);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.surface }}>
      <ScreenHeader title="Business tools" subtitle={`${pack.title} workspace`} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}>
        <Card style={{ padding: 16, marginBottom: 16 }}>
          <Text style={{ color: theme.color.brandPrimary, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.7 }}>Progressive disclosure</Text>
          <Text style={{ color: theme.color.onSurface, fontSize: 20, fontWeight: '800', marginTop: 6 }}>Everything you need, when you need it</Text>
          <Text style={{ color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 6 }}>Ledgr keeps the Home screen focused on your selected business. Open advanced tools here only when your workflow grows.</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Customize workspace modules" onPress={() => router.push('/customize-features' as any)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: theme.color.brandPrimary }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>Customize workspace</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Open local integrations" onPress={() => router.push('/integrations' as any)} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: theme.color.brandPrimary }}>
              <Text style={{ color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800' }}>Integrations</Text>
            </Pressable>
          </View>
        </Card>

        <Text style={{ color: theme.color.onSurface, fontSize: 17, fontWeight: '800', marginBottom: 10 }}>Featured for {pack.title}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          {pack.featuredModules.map((module) => <ModuleCard key={module.key} module={module} theme={theme} onPress={() => openModule(module)} />)}
        </View>

        {pack.advancedModules.length ? <>
          <Text style={{ color: theme.color.onSurface, fontSize: 17, fontWeight: '800', marginTop: 12, marginBottom: 10 }}>Advanced when needed</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
            {pack.advancedModules.map((module) => <ModuleCard key={module.key} module={module} theme={theme} onPress={() => openModule(module)} />)}
          </View>
        </> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
