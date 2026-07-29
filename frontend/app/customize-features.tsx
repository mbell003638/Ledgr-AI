import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Switch,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { api } from "@/src/api";
import { Card, ScreenHeader } from "@/src/components/UI";
import {
  ALL_FEATURES,
  PERSONA_DEFAULT_FEATURES,
  getEnabledFeatures,
  FeatureKey,
  FeatureMeta,
} from "@/src/utils/featureFlags";

export default function CustomizeFeaturesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<any>({});
  const [activeFeatures, setActiveFeatures] = useState<Set<FeatureKey>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setSettings(s);
        const enabled = getEnabledFeatures(s);
        setActiveFeatures(new Set(enabled));
      } catch (e) {
        console.warn("Failed to load feature settings", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggleFeature = (key: FeatureKey) => {
    setActiveFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Must keep at least 1 feature enabled
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const resetToPersonaDefaults = () => {
    const persona = settings?.activePersona || settings?.businessType || "custom";
    const defaults = PERSONA_DEFAULT_FEATURES[persona] || ALL_FEATURES.map((f) => f.key);
    setActiveFeatures(new Set(defaults));
  };

  const enableAll = () => {
    setActiveFeatures(new Set(ALL_FEATURES.map((f) => f.key)));
  };

  const save = async () => {
    setSaving(true);
    try {
      const list = Array.from(activeFeatures);
      await api.updateSettings({ enabledFeatures: list });
      router.back();
    } catch (e: any) {
      console.warn("Failed to save feature flags", e);
    } finally {
      setSaving(false);
    }
  };

  const categories = [
    { id: "sales", title: "Sales & Billing", items: ALL_FEATURES.filter((f) => f.category === "sales") },
    { id: "purchases", title: "Purchases & Expenses", items: ALL_FEATURES.filter((f) => f.category === "purchases") },
    { id: "accounting", title: "Accounting & Reports", items: ALL_FEATURES.filter((f) => f.category === "accounting") },
    { id: "ai", title: "AI Intelligence", items: ALL_FEATURES.filter((f) => f.category === "ai") },
  ];

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.color.brandPrimary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={theme.color.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Customize Dashboard Tabs</Text>
        <Pressable onPress={save} disabled={saving} style={styles.saveBtn}>
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Save</Text>
          )}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: theme.spacing.md }}>
        <Text style={styles.subtitle}>
          Turn tabs on or off to tailor Ledgr to your exact business workflow. Disabled tabs will be hidden from your home screen.
        </Text>

        <View style={styles.actionRow}>
          <Pressable onPress={resetToPersonaDefaults} style={styles.actionChip}>
            <Ionicons name="refresh-outline" size={14} color={theme.color.brandPrimary} />
            <Text style={styles.actionChipText}>Reset to Persona Defaults</Text>
          </Pressable>
          <Pressable onPress={enableAll} style={styles.actionChip}>
            <Ionicons name="checkmark-done-outline" size={14} color={theme.color.brandPrimary} />
            <Text style={styles.actionChipText}>Enable All</Text>
          </Pressable>
        </View>

        {categories.map((cat) => (
          <View key={cat.id} style={{ marginBottom: 20 }}>
            <Text style={styles.categoryTitle}>{cat.title}</Text>
            <Card style={{ padding: 0, overflow: "hidden" }}>
              {cat.items.map((item, idx) => {
                const isEnabled = activeFeatures.has(item.key);
                const isLast = idx === cat.items.length - 1;
                return (
                  <View
                    key={item.key}
                    style={[
                      styles.row,
                      !isLast && { borderBottomWidth: 1, borderBottomColor: theme.color.border },
                    ]}
                  >
                    <View style={[styles.iconCircle, { backgroundColor: item.color + "33" }]}>
                      <Ionicons name={item.icon as any} size={20} color={theme.color.onSurface} />
                    </View>
                    <View style={{ flex: 1, marginHorizontal: 12 }}>
                      <Text style={styles.rowLabel}>{item.label}</Text>
                      <Text style={styles.rowDesc}>{item.description}</Text>
                    </View>
                    <Switch
                      value={isEnabled}
                      onValueChange={() => toggleFeature(item.key)}
                      trackColor={{ false: theme.color.border, true: theme.color.brandPrimary }}
                      thumbColor="#fff"
                    />
                  </View>
                );
              })}
            </Card>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.color.surface,
    },
    center: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.color.border,
    },
    backBtn: {
      padding: 4,
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: "700",
      color: theme.color.onSurface,
    },
    saveBtn: {
      backgroundColor: theme.color.brandPrimary,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 16,
    },
    saveBtnText: {
      color: "#fff",
      fontWeight: "700",
      fontSize: 13,
    },
    subtitle: {
      fontSize: 13,
      color: theme.color.muted,
      lineHeight: 18,
      marginBottom: 14,
    },
    actionRow: {
      flexDirection: "row",
      gap: 10,
      marginBottom: 18,
    },
    actionChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.color.surfaceInverse + "0D",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    actionChipText: {
      fontSize: 12,
      fontWeight: "600",
      color: theme.color.onSurface,
    },
    categoryTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.color.muted,
      textTransform: "uppercase",
      letterSpacing: 1,
      marginBottom: 8,
      marginLeft: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      padding: 14,
    },
    iconCircle: {
      width: 38,
      height: 38,
      borderRadius: 19,
      justifyContent: "center",
      alignItems: "center",
    },
    rowLabel: {
      fontSize: 14,
      fontWeight: "600",
      color: theme.color.onSurface,
    },
    rowDesc: {
      fontSize: 11,
      color: theme.color.muted,
      marginTop: 2,
    },
  });
}
