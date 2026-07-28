import React, { useMemo } from "react";
import { View, Text, StyleSheet, ViewStyle, StyleProp, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";

import { api } from "@/src/api";

export function ScreenHeader({ title, subtitle, testID, rightAction }: { title: string; subtitle?: string; testID?: string; rightAction?: React.ReactNode }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [bizName, setBizName] = React.useState<string | null>(null);
  
  React.useEffect(() => {
    api.getSettings().then(s => {
      setBizName(s.businessName || "Main Account");
    }).catch(() => {});
  }, []);

  return (
    <View style={styles.header} testID={testID}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 8 }}>
          {bizName ? (
            <View style={{ flexShrink: 0, backgroundColor: theme.color.brandPrimary + "15", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: theme.color.brandPrimary + "40", flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="business" size={14} color={theme.color.brandPrimary} />
              <Text style={{ fontSize: 13, fontWeight: "800", color: theme.color.brandPrimary, textTransform: "uppercase", letterSpacing: 0.5 }}>{bizName}</Text>
            </View>
          ) : null}
          {rightAction}
        </View>
      </View>
    </View>
  );
}

export function Card({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
}

export function KpiTile({ label, value, hint, testID, onPress }: { label: string; value: string; hint?: string; testID?: string; onPress?: () => void }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const content = (
    <>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} testID={testID} style={({ pressed }: { pressed: boolean }) => [styles.kpi, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}>
        {content}
        <View style={{ position: "absolute", top: 10, right: 10 }}>
          <Ionicons name="chevron-forward" size={14} color={theme.color.muted} />
        </View>
      </Pressable>
    );
  }
  return (
    <View style={styles.kpi} testID={testID}>
      {content}
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center" }, style]}>{children}</View>;
}

export function Divider() {
  const theme = useTheme();
  return <View style={{ height: 1, backgroundColor: theme.color.divider, marginVertical: theme.spacing.md }} />;
}

export function Empty({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.empty}>
      {icon}
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    header: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
      backgroundColor: theme.color.surface,
    },
    title: { fontSize: 28, fontWeight: "700", color: theme.color.onSurface, letterSpacing: -0.5 },
    subtitle: { fontSize: 14, color: theme.color.muted, marginTop: 4 },
    card: {
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      // Professional elevation and shadow
      elevation: 2,
      shadowColor: theme.color.muted,
      shadowOpacity: 0.08,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      marginVertical: theme.spacing.xs,
    },
    kpi: {
      flex: 1,
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
      // Consistent subtle shadow
      elevation: 1,
      shadowColor: theme.color.muted,
      shadowOpacity: 0.06,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 0.5 },
    },
    kpiLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
    kpiValue: { fontSize: 22, fontWeight: "700", color: theme.color.onSurface, marginTop: 6 },
    kpiHint: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
    empty: { alignItems: "center", padding: theme.spacing.xxl, gap: 8 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.color.onSurface, marginTop: 8 },
    emptyHint: { fontSize: 13, color: theme.color.muted, textAlign: "center" },
  });
}
