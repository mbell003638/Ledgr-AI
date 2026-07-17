import React, { useMemo } from "react";
import { View, Text, StyleSheet, ViewStyle, StyleProp } from "react-native";
import { useTheme } from "@/src/context/ThemeContext";

export function ScreenHeader({ title, subtitle, testID }: { title: string; subtitle?: string; testID?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.header} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
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

export function KpiTile({ label, value, hint, testID }: { label: string; value: string; hint?: string; testID?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.kpi} testID={testID}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
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
    },
    kpi: {
      flex: 1,
      backgroundColor: theme.color.surfaceSecondary,
      borderRadius: theme.radius.lg,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    kpiLabel: { fontSize: 12, color: theme.color.muted, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },
    kpiValue: { fontSize: 22, fontWeight: "700", color: theme.color.onSurface, marginTop: 6 },
    kpiHint: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
    empty: { alignItems: "center", padding: theme.spacing.xxl, gap: 8 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.color.onSurface, marginTop: 8 },
    emptyHint: { fontSize: 13, color: theme.color.muted, textAlign: "center" },
  });
}
