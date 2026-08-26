import React, { useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScreenHeader } from '@/src/components/UI';
import { useTheme } from '@/src/context/ThemeContext';
import { SELF_HOST_DISTRIBUTION } from '@/src/sync/selfHostDistribution';

type HostChoice = 'computer' | 'vps' | 'nas';
type HostOption = {
  label: string;
  icon: string;
  intro: string;
  note: string;
  setup: string;
  downloadLabel: string;
  downloadUrl: string;
  alternateDownloadLabel?: string;
  alternateDownloadUrl?: string;
};

const hosts: Record<HostChoice, HostOption> = {
  computer: {
    label: 'Office computer',
    icon: 'desktop-outline',
    intro: 'Best for one office, one shop, or a small team using the same network.',
    note: 'Keep the computer powered on whenever another device needs to sync.',
    setup: 'Install Docker Desktop, download the guided package, and follow the setup screen. You do not need to open a terminal first.',
    downloadLabel: 'Download for Windows',
    downloadUrl: SELF_HOST_DISTRIBUTION.windowsInstallerUrl,
    alternateDownloadLabel: 'Download for macOS/Linux',
    alternateDownloadUrl: SELF_HOST_DISTRIBUTION.linuxInstallerUrl,
  },
  vps: {
    label: 'VPS',
    icon: 'globe-outline',
    intro: 'Best when owners, team members, or shops work from different places.',
    note: 'Use a domain name, HTTPS, firewall rules, updates, and automated backups.',
    setup: 'Use the Linux installer on your VPS. It checks Docker, creates the protected deployment folders, starts the services, and prints the health address.',
    downloadLabel: 'Download Linux installer',
    downloadUrl: SELF_HOST_DISTRIBUTION.linuxInstallerUrl,
  },
  nas: {
    label: 'NAS',
    icon: 'server-outline',
    intro: 'Best when your business already has Synology, QNAP, or TrueNAS storage.',
    note: 'Docker and Compose must be available; use a VPN or HTTPS for remote access.',
    setup: 'Download the Compose bundle, open your NAS container manager, and use the guided values for domain, identity, and secrets.',
    downloadLabel: 'Download NAS/Docker bundle',
    downloadUrl: SELF_HOST_DISTRIBUTION.bundleUrl,
  },
};

const simpleSteps = [
  ['1', 'Choose where it lives', 'Pick an office computer, VPS, or NAS. Ledgr will show only the instructions that apply to that choice.'],
  ['2', 'Download the guided package', 'Use the matching button below. The release package contains the sync service and deployment files, not the private mobile app.'],
  ['3', 'Run the safety check', 'The installer checks Docker, required values, secret-file permissions, HTTPS intent, and Compose configuration before starting.'],
  ['4', 'Check HTTPS and health', 'Confirm the public health check and protected readiness check before connecting any additional device.'],
  ['5', 'Pair devices with QR', 'The owner creates a role-and-location invitation. The joining device scans it, reviews access, and signs in with its own account.'],
];

async function openExternal(url: string) {
  try {
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
  } catch {
    // The link remains visible so the user can retry from the release page.
  }
}

export default function PrivateSyncGuideScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [host, setHost] = useState<HostChoice>('computer');
  const selected = hosts[host];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScreenHeader title="Private sync guide" subtitle="Set up your own server" leftAction={<Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>User-owned by design</Text>
          <Text style={styles.heroTitle}>Ledgr helps you choose the right setup.</Text>
          <Text style={styles.heroText}>You do not need a server for one device. Use Private sync only when phones, computers, POS devices, or shops need to share one business book.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Where will the server live?</Text>
          <Text style={styles.hint}>Choose the picture that looks like your situation. The download button will change to match it.</Text>
          <View style={styles.hostGrid}>
            {(Object.keys(hosts) as HostChoice[]).map((key) => {
              const item = hosts[key];
              const isSelected = host === key;
              return <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: isSelected }} onPress={() => setHost(key)} style={[styles.hostChoice, isSelected && styles.hostChoiceSelected]}><Ionicons name={item.icon as any} size={22} color={isSelected ? theme.color.brandPrimary : theme.color.muted} /><Text style={[styles.hostLabel, isSelected && { color: theme.color.brandPrimary }]}>{item.label}</Text></Pressable>;
            })}
          </View>
          <Text style={styles.hostIntro}>{selected.intro}</Text>
          <Text style={styles.hint}>{selected.note}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Your recommended next step</Text>
          <Text style={styles.choiceTitle}>{selected.label}</Text>
          <Text style={styles.hint}>{selected.setup}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={selected.downloadLabel} testID={`download-self-host-${host}`} onPress={() => void openExternal(selected.downloadUrl)} style={styles.primary}><Ionicons name="download-outline" size={20} color={theme.color.onBrandPrimary} /><Text style={styles.primaryText}>{selected.downloadLabel}</Text></Pressable>
          {selected.alternateDownloadUrl ? <Pressable accessibilityRole="button" accessibilityLabel={selected.alternateDownloadLabel} onPress={() => void openExternal(selected.alternateDownloadUrl as string)} style={styles.secondary}><Ionicons name="download-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>{selected.alternateDownloadLabel}</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Open all self-host downloads" onPress={() => void openExternal(SELF_HOST_DISTRIBUTION.releaseUrl)} style={styles.secondary}><Ionicons name="list-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>See all versions and downloads</Text></Pressable>
          <Text style={styles.hint}>The package is distributed through versioned GitHub Releases. Your computer, VPS, or NAS runs the service; GitHub does not run your business server.</Text>
          <Text style={styles.code}>Container image: {SELF_HOST_DISTRIBUTION.image}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Five simple setup steps</Text>
          {simpleSteps.map(([number, title, text]) => <View key={number} style={styles.step}><View style={styles.number}><Text style={styles.numberText}>{number}</Text></View><View style={styles.stepCopy}><Text style={styles.stepTitle}>{title}</Text><Text style={styles.hint}>{text}</Text></View></View>)}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What the installer does</Text>
          <Text style={styles.hint}>It detects Docker and Compose, validates production settings, creates secure secret-file locations, starts PostgreSQL plus the sync service and HTTPS edge, and tells you which health address to open. It does not contain private mobile-app source code or customer data.</Text>
          <Text style={styles.hint}>For the bundled small-business setup, use 2 CPUs, 2 GB RAM, 20 GB free disk, Docker Engine 24 or newer, Docker Compose v2, encrypted storage, HTTPS, and an explicit CORS origin.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Connect the first device</Text>
          <Text style={styles.hint}>Keep the device Local-only while you make and verify an encrypted backup. Then open Private sync, choose Set up my own server, enter the server address, and review the first snapshot before publishing it.</Text>
          <Text style={styles.hint}>Ledgr sends checked accounting operations. It never copies a raw SQLite file over the server database.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Go to Private sync setup" onPress={() => router.back()} style={styles.primary}><Text style={styles.primaryText}>Go to Private sync</Text></Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Connect another device with QR</Text>
          <Text style={styles.hint}>On the owner device, open Sync Administration and create a QR invitation with the correct role and shop locations. On the new device, choose Join an existing business, scan the QR, confirm the server and access scope, sign in with that person’s own account, and join.</Text>
          <Text style={styles.hint}>The QR invitation expires after 15 minutes, works once, and never contains the administrator’s access token.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Open QR invitation scanner" onPress={() => router.push('/sync-scan' as any)} style={styles.secondary}><Ionicons name="qr-code-outline" size={18} color={theme.color.brandPrimary} /><Text style={styles.secondaryText}>Open QR scanner</Text></Pressable>
        </View>

        <View style={styles.remember}><Text style={styles.rememberTitle}>Remember</Text><Text style={styles.hint}>No internet? Keep working. The device keeps local work and retries later. Lost device? Revoke it in Sync Administration.</Text></View>
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surface },
  scroll: { padding: theme.spacing.lg, gap: 12, paddingBottom: 42 },
  hero: { backgroundColor: theme.color.surfaceTertiary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 17, gap: 7 },
  eyebrow: { color: theme.color.brandPrimary, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  heroTitle: { color: theme.color.onSurface, fontSize: 22, lineHeight: 28, fontWeight: '800' },
  heroText: { color: theme.color.muted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: theme.color.surfaceSecondary, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 9 },
  sectionTitle: { color: theme.color.onSurface, fontSize: 17, fontWeight: '800' },
  hostGrid: { flexDirection: 'row', gap: 7 },
  hostChoice: { flex: 1, minHeight: 76, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 7 },
  hostChoiceSelected: { borderColor: theme.color.brandPrimary, backgroundColor: theme.color.surfaceTertiary },
  hostLabel: { color: theme.color.onSurface, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  hostIntro: { color: theme.color.onSurface, fontWeight: '800', fontSize: 14 },
  hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19 },
  choiceTitle: { color: theme.color.onSurface, fontWeight: '800', fontSize: 16 },
  code: { color: theme.color.muted, backgroundColor: theme.color.surface, borderColor: theme.color.border, borderWidth: 1, borderRadius: theme.radius.md, padding: 10, fontSize: 12, lineHeight: 17 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderTopColor: theme.color.border, borderTopWidth: 1, paddingTop: 11 },
  number: { width: 27, height: 27, borderRadius: 14, backgroundColor: theme.color.brandPrimary, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: theme.color.onBrandPrimary, fontWeight: '800' },
  stepCopy: { flex: 1, gap: 3 },
  stepTitle: { color: theme.color.onSurface, fontWeight: '800', fontSize: 14 },
  primary: { backgroundColor: theme.color.brandPrimary, borderRadius: theme.radius.md, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: 3 },
  primaryText: { color: theme.color.onBrandPrimary, fontWeight: '800' },
  secondary: { borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.md, paddingVertical: 11, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  secondaryText: { color: theme.color.brandPrimary, fontWeight: '800' },
  remember: { borderColor: theme.color.brandPrimary, borderWidth: 1, borderRadius: theme.radius.lg, padding: 16, gap: 4 },
  rememberTitle: { color: theme.color.brandPrimary, fontWeight: '800', fontSize: 16 },
});
