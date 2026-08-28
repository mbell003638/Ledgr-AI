import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { SETTINGS_SCREEN_CARD_GAP, SETTINGS_SCREEN_HEADER_BOTTOM } from '@/src/utils/settingsScreenLayout';

type Target = 'windows' | 'mac-linux' | 'docker';

const RELEASES_URL = 'https://github.com/mbell003638/Ledgr-SelfHost/releases/latest';
const DOWNLOAD_URLS: Record<Target, string> = {
  windows: 'https://github.com/mbell003638/Ledgr-SelfHost/releases/latest/download/ledgr-selfhost-install.ps1',
  'mac-linux': 'https://github.com/mbell003638/Ledgr-SelfHost/releases/latest/download/ledgr-selfhost-install.sh',
  docker: 'https://github.com/mbell003638/Ledgr-SelfHost/releases/latest/download/ledgr-selfhost-bundle.tar.gz',
};

const targets: { key: Target; label: string; icon: keyof typeof Ionicons.glyphMap; detail: string }[] = [
  { key: 'windows', label: 'Windows', icon: 'logo-windows', detail: 'Office computer or Windows server' },
  { key: 'mac-linux', label: 'macOS / Linux', icon: 'terminal-outline', detail: 'Mac, Linux computer, or VPS' },
  { key: 'docker', label: 'NAS / Docker', icon: 'cube-outline', detail: 'Synology, QNAP, TrueNAS, or Docker host' },
];

export default function SelfHostGuideScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [target, setTarget] = useState<Target>('windows');
  const selected = targets.find((item) => item.key === target) || targets[0];

  const openUrl = async (url: string) => {
    try {
      if (!(await Linking.canOpenURL(url))) throw new Error('This link is unavailable on the device.');
      await Linking.openURL(url);
    } catch (error: any) {
      // Keep the guide usable even when a device cannot launch an external browser.
      console.warn('self-host guide link', error?.message || error);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>
        <View style={{ flex: 1 }}><ScreenHeader embedded title="Set up self-hosted sync" subtitle="Guided setup for your own computer" /></View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}><Ionicons name="server-outline" size={26} color={theme.color.brandPrimary} /></View>
          <Text style={styles.title}>Set up once, then pair your phones</Text>
          <Text style={styles.body}>Ledgr will guide you to the right server package. The server runs on your computer, VPS, or NAS—not inside the phone app.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>1. Choose where the server will run</Text>
          <View style={styles.targetList}>
            {targets.map((item) => <Pressable key={item.key} accessibilityRole="button" onPress={() => setTarget(item.key)} style={[styles.target, target === item.key && styles.targetSelected]}>
              <Ionicons name={item.icon} size={22} color={target === item.key ? theme.color.brandPrimary : theme.color.muted} />
              <View style={{ flex: 1 }}><Text style={[styles.targetTitle, target === item.key && styles.targetTitleSelected]}>{item.label}</Text><Text style={styles.targetDetail}>{item.detail}</Text></View>
              {target === item.key ? <Ionicons name="checkmark-circle" size={20} color={theme.color.brandPrimary} /> : null}
            </Pressable>)}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>2. Prepare the server computer</Text>
          <Text style={styles.step}>• Keep the computer or server online when phones need to sync.</Text>
          <Text style={styles.step}>• Have a DNS name and HTTPS available for production use.</Text>
          <Text style={styles.step}>• Have an OIDC identity provider ready for sign-in.</Text>
          <Text style={styles.step}>• The installer asks for these values and checks them before starting.</Text>
          <Text style={styles.note}>Docker Engine 24+, Docker Compose v2, at least 2 CPUs, 2 GB RAM, and 20 GB free disk are recommended for the bundled setup.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>3. Download the {selected.label} package</Text>
          <Text style={styles.body}>{target === 'windows' ? 'Download the PowerShell installer to the Windows computer that will host Ledgr.' : target === 'mac-linux' ? 'Download the shell installer to the Mac, Linux computer, or VPS that will host Ledgr.' : 'Download and extract the Docker bundle on the computer or NAS that will host Ledgr.'}</Text>
          <Pressable testID={`download-self-host-${target}`} onPress={() => openUrl(DOWNLOAD_URLS[target])} style={styles.primaryButton}><Ionicons name="download-outline" size={20} color={theme.color.onBrandPrimary} /><Text style={styles.primaryText}>Download package</Text></Pressable>
          {target === 'windows' ? <View style={styles.command}><Text style={styles.commandText}>Set-ExecutionPolicy -Scope Process Bypass</Text><Text style={styles.commandText}>.\ledgr-selfhost-install.ps1</Text></View> : null}
          {target === 'mac-linux' ? <View style={styles.command}><Text style={styles.commandText}>chmod +x ledgr-selfhost-install.sh</Text><Text style={styles.commandText}>./ledgr-selfhost-install.sh</Text></View> : null}
          {target === 'docker' ? <View style={styles.command}><Text style={styles.commandText}>Extract the bundle</Text><Text style={styles.commandText}>Fill in .env, then run docker compose up -d</Text></View> : null}
          <Text style={styles.note}>The phone can download or share the package link, but the installer must be run on the target computer and may request administrator permission.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>4. Confirm the server, then pair devices</Text>
          <Text style={styles.step}>1. Open <Text style={styles.inlineStrong}>https://your-domain/healthz</Text> on the server or another browser.</Text>
          <Text style={styles.step}>2. Return to Ledgr and enter the server URL and OIDC details.</Text>
          <Text style={styles.step}>3. The owner can create an invitation QR for each additional phone.</Text>
          <Text style={styles.step}>4. Each phone scans the QR and signs in with its own identity.</Text>
          <Pressable testID="open-sync-settings-from-guide" onPress={() => router.replace('/sync-settings' as any)} style={styles.secondaryButton}><Ionicons name="qr-code-outline" size={19} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>Continue to sync settings</Text></Pressable>
        </View>

        <Pressable testID="open-self-host-release-page" onPress={() => openUrl(RELEASES_URL)} style={styles.releaseLink}><Text style={styles.releaseText}>View all releases and checksums</Text><Ionicons name="open-outline" size={17} color={theme.color.brandPrimary} /></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: theme.spacing.lg, paddingTop: 12, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM },
    content: { padding: theme.spacing.lg, paddingBottom: 40, gap: SETTINGS_SCREEN_CARD_GAP },
    hero: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.lg, padding: 18, gap: 8 },
    heroIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.surface },
    title: { color: theme.color.onSurface, fontSize: 21, fontWeight: '800' },
    sectionTitle: { color: theme.color.onSurface, fontSize: 16, fontWeight: '800', marginBottom: 4 },
    body: { color: theme.color.muted, fontSize: 13, lineHeight: 20 },
    card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 9 },
    targetList: { gap: 8 },
    target: { flexDirection: 'row', alignItems: 'center', gap: 11, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12 },
    targetSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surface },
    targetTitle: { color: theme.color.onSurface, fontSize: 14, fontWeight: '700' },
    targetTitleSelected: { color: theme.color.brandPrimary },
    targetDetail: { color: theme.color.muted, fontSize: 12, marginTop: 2 },
    step: { color: theme.color.muted, fontSize: 13, lineHeight: 20 },
    note: { color: theme.color.muted, fontSize: 11, lineHeight: 17, marginTop: 3 },
    inlineStrong: { color: theme.color.onSurface, fontWeight: '700' },
    primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, marginTop: 4 },
    primaryText: { color: theme.color.onBrandPrimary, fontWeight: '800' },
    command: { backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 12, gap: 4 },
    commandText: { color: theme.color.onSurface, fontFamily: 'monospace', fontSize: 11 },
    secondaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 12, marginTop: 5 },
    secondaryText: { color: theme.color.brandPrimary, fontWeight: '800' },
    releaseLink: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, paddingVertical: 4 },
    releaseText: { color: theme.color.brandPrimary, fontWeight: '700', fontSize: 12 },
  });
}

