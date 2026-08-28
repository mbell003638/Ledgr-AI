import React from "react";
import { ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

import { ScreenHeader } from "@/src/components/UI";
import { useTheme } from "@/src/context/ThemeContext";
import { SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from "@/src/utils/settingsScreenLayout";

const sections = [
  ["Data handled by the app", "Depending on the features you use, Ledgr may process business and financial records, customer and supplier contact details, invoice data, receipt or document images, voice recordings, and app preferences."],
  ["AI features", "AI features are optional. When you start an AI action, the selected question, image, audio, document content, and relevant accounting context may be sent directly to your selected provider. The provider processes that data under its own terms and privacy policy. Ledgr does not operate an intermediary AI server."],
  ["Storage and security", "Accounting data is stored locally on your device. On iOS and Android, AI API keys use secure credential storage. On the web, an entered API key is kept only in memory for the current page session. Android operating-system backup is disabled. Exported JSON backups are readable accounting data and should be stored and shared securely."],
  ["Permissions", "Camera, photo, microphone, and document access is requested only when you invoke a feature that needs it. App Lock can use your device PIN or biometric authentication when enabled."],
  ["Data deletion", "You can clear accounting data or perform a factory reset from Settings. Uninstalling the app also removes its local app data, subject to your operating system. Data already sent to an AI provider is governed by that provider's deletion policy."],
  ["Children", "Ledgr is a business accounting tool and is not directed to children."],
];

export default function PrivacyDataScreen() {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.color.surface }]} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" style={styles.back}>
          <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <ScreenHeader embedded title="Privacy & Data" subtitle="How Ledgr handles your information" />
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.effective, { color: theme.color.muted }]}>Effective date: August 6, 2026</Text>
        <Text style={[styles.intro, { color: theme.color.onSurface }]}>Ledgr is a local-first accounting application. Business records are stored on your device. Ledgr does not include advertising, analytics, or cross-app tracking.</Text>
        {sections.map(([title, body]) => (
          <View key={title} style={[styles.section, { borderBottomColor: theme.color.border }]}>
            <Text style={[styles.title, { color: theme.color.brandPrimary }]}>{title}</Text>
            <Text style={[styles.body, { color: theme.color.onSurface }]}>{body}</Text>
          </View>
        ))}
        <Text style={[styles.footer, { color: theme.color.muted }]}>For privacy questions, please open an issue in the Ledgr repository. This policy may be updated when app behavior changes.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 16, paddingBottom: SETTINGS_SCREEN_HEADER_BOTTOM },
  back: { marginRight: 12, padding: 4 },
  content: { paddingHorizontal: 24, paddingTop: SETTINGS_SCREEN_CONTENT_TOP, paddingBottom: 60 },
  effective: { fontSize: 12, marginBottom: 14 },
  intro: { fontSize: 15, lineHeight: 23, marginBottom: 8 },
  section: { paddingVertical: 18, borderBottomWidth: 1 },
  title: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  body: { fontSize: 14, lineHeight: 22 },
  footer: { fontSize: 12, lineHeight: 18, marginTop: 20 },
});

