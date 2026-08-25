import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { ScreenHeader } from "@/src/components/UI";
import { useTheme } from "@/src/context/ThemeContext";

const sections = [
  {
    title: "Data handled by the app",
    body: "Depending on the features you use, Ledgr may process business and financial records, customer and supplier contact details, invoice data, receipt or document images, voice recordings, and app preferences.",
  },
  {
    title: "AI features",
    body: "AI features are optional and require you to configure an AI provider and API key. When you start an AI action, the selected question, image, audio, document content, and relevant accounting context may be sent directly to that provider. Ledgr does not operate an intermediary AI server. The provider processes that data under its own terms and privacy policy.",
  },
  {
    title: "Storage and security",
    body: "Accounting data is stored locally on your device. AI API keys are stored using the device's secure credential storage. Android operating-system backup is disabled. You may explicitly export a JSON backup; exported files are readable accounting data and should be stored and shared securely. Camera, photo, microphone, and document access is requested only when you invoke a feature that needs it. App Lock can use your device PIN or biometric authentication when enabled.",
  },
  {
    title: "Data deletion",
    body: "You can clear accounting data or perform a factory reset from Settings. Uninstalling the app also removes its local app data, subject to the device operating system's behavior. Data already sent to a chosen AI provider is governed by that provider's deletion policy.",
  },
  {
    title: "Children",
    body: "Ledgr is a business accounting tool and is not directed to children.",
  },
  {
    title: "Changes and contact",
    body: "This policy may be updated when app behavior changes. The effective date will be revised for material changes. For privacy questions, use the Ledgr support or repository contact channel shown in the app documentation.",
  },
];

export default function PrivacyScreen() {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title="Privacy & Data"
        subtitle="How Ledgr handles your information"
        leftAction={<Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back"><Ionicons name="arrow-back" size={24} color={theme.color.onSurface} /></Pressable>}
      />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.notice}>
          <Ionicons name="shield-checkmark-outline" size={22} color={theme.color.brandPrimary} />
          <View style={styles.noticeCopy}>
            <Text style={styles.noticeTitle}>Local-first privacy</Text>
            <Text style={styles.noticeText}>Ledgr stores your books on your device by default. Optional AI and private sync features only act when you start and configure them.</Text>
          </View>
        </View>
        <View style={styles.card}>
          <Text style={styles.policyTitle}>Ledgr Privacy Policy</Text>
          <Text style={styles.effective}>Effective date: August 6, 2026</Text>
          <Text style={styles.intro}>Ledgr is a local-first accounting application. Business records are stored on the user&apos;s device. Ledgr does not include advertising, analytics, or cross-app tracking.</Text>
          {sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.body}>{section.body}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.footer}>This in-app copy is provided so you can review the policy without leaving Ledgr.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.color.surface },
    scroll: { padding: theme.spacing.lg, paddingBottom: 48, gap: theme.spacing.md },
    notice: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 14, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.color.brandPrimary + "55", backgroundColor: theme.color.brandPrimary + "0D" },
    noticeCopy: { flex: 1 },
    noticeTitle: { color: theme.color.brandPrimary, fontSize: 14, fontWeight: "800" },
    noticeText: { color: theme.color.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
    card: { padding: 18, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.color.border, backgroundColor: theme.color.surfaceSecondary },
    policyTitle: { color: theme.color.onSurface, fontSize: 20, fontWeight: "800" },
    effective: { color: theme.color.muted, fontSize: 12, marginTop: 5 },
    intro: { color: theme.color.onSurface, fontSize: 13, lineHeight: 20, marginTop: 18 },
    section: { marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: theme.color.border },
    sectionTitle: { color: theme.color.brandPrimary, fontSize: 15, fontWeight: "800", marginBottom: 6 },
    body: { color: theme.color.onSurface, fontSize: 13, lineHeight: 20 },
    footer: { color: theme.color.muted, fontSize: 11, lineHeight: 16, textAlign: "center", paddingHorizontal: 12 },
  });
}
