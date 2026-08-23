import React, { useMemo } from "react";
import { View, Text, StyleSheet, ViewStyle, TextStyle, StyleProp, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { GlowPressable } from "@/src/components/GlowPressable";
import { AnimatedGlassSurface } from "@/src/components/AnimatedGlassSurface";

import { api } from "@/src/api";

export function ScreenHeader({ title, subtitle, testID, leftAction, rightAction, style, titleStyle, subtitleStyle }: { title: string; subtitle?: string; testID?: string; leftAction?: React.ReactNode; rightAction?: React.ReactNode; style?: StyleProp<ViewStyle>; titleStyle?: StyleProp<TextStyle>; subtitleStyle?: StyleProp<TextStyle> }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [bizName, setBizName] = React.useState<string | null>(null);
  
  useFocusEffect(
    React.useCallback(() => {
      let active = true;
      api.getSettings().then(s => {
        if (active) setBizName(s.businessName || "Main Account");
      }).catch(() => {});
      return () => { active = false; };
    }, [])
  );

  return (
    <View style={[styles.header, style]} testID={testID}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start' }}>
          {leftAction ? <View style={{ marginRight: 10, paddingTop: 2 }}>{leftAction}</View> : null}
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, titleStyle]}>{title}</Text>
            {subtitle ? <Text style={[styles.subtitle, subtitleStyle]}>{subtitle}</Text> : null}
          </View>
        </View>
        <View style={{ alignItems: "flex-end", gap: 8, maxWidth: "45%" }}>
          {bizName ? (
            <View style={{ flexShrink: 0, backgroundColor: theme.color.brandPrimary + "15", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: theme.color.brandPrimary + "40", flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="business" size={14} color={theme.color.brandPrimary} />
              <Text numberOfLines={1} ellipsizeMode="tail" style={{ flexShrink: 1, fontSize: 13, fontWeight: "800", color: theme.color.brandPrimary, textTransform: "uppercase", letterSpacing: 0.5 }}>{bizName}</Text>
            </View>
          ) : null}
          {rightAction}
        </View>
      </View>
    </View>
  );
}

export function Card({ children, style, testID, shadowEnabled = true, surfaceColor, hoverSurfaceColor, restingBorderColor }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string; shadowEnabled?: boolean; surfaceColor?: string; hoverSurfaceColor?: string; restingBorderColor?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <AnimatedGlassSurface style={[styles.card, style]} testID={testID} shadowEnabled={shadowEnabled} surfaceColor={surfaceColor} hoverSurfaceColor={hoverSurfaceColor} restingBorderColor={restingBorderColor}>
      {children}
    </AnimatedGlassSurface>
  );
}

export function KpiTile({ label, value, hint, icon, valueColor, testID, onPress }: { label: string; value: string; hint?: string; icon?: React.ReactNode; valueColor?: string; testID?: string; onPress?: () => void }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const content = (
    <>
      <View style={styles.kpiTop}>
        <Text style={styles.kpiLabel}>{label}</Text>
        {icon}
      </View>
      <Text style={[styles.kpiValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      {hint ? <Text style={styles.kpiHint}>{hint}</Text> : null}
    </>
  );
  if (onPress) {
    return (
      <GlowPressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityHint="Opens the related accounting view"
        haptic
        topHighlight
        clipSafe={false}
        hoverLift={-5}
        hoverScale={1.02}
        // Match the dashboard hero card's press depth (see AnimatedHeroCard)
        // so every dashboard surface compresses identically on touch.
        pressScale={0.972}
        restingBorderColor={theme.color.glassBorder}
        hoverBorderColor={theme.color.brandPrimary}
        testID={testID}
        style={styles.kpi}
      >
        {content}
      </GlowPressable>
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
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 10,
      backgroundColor: theme.color.surface,
    },
    title: { fontSize: 26, fontWeight: "800", color: theme.color.onSurface, letterSpacing: -0.5 },
    subtitle: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
    card: {
      backgroundColor: theme.color.glassSurface,
      borderRadius: theme.radius.card,
      padding: 18,
      borderWidth: 1,
      borderColor: theme.color.glassBorder,
      ...(Platform.OS === "web" ? { boxShadow: "none", overflow: "hidden" } : {}),
      marginVertical: 0,
    },
    kpi: {
      flex: 1,
      backgroundColor: theme.color.glassSurface,
      borderRadius: theme.radius.kpi,
      padding: 14,
      borderWidth: 1,
      borderColor: theme.color.glassBorder,
      ...(Platform.OS === "web" ? { boxShadow: "none", overflow: "hidden" } : {}),
    },
    kpiTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    kpiLabel: { fontSize: 11, color: theme.color.muted, fontWeight: "700" },
    kpiValue: { fontSize: 18, fontWeight: "800", color: theme.color.onSurface, marginTop: 6 },
    kpiHint: { fontSize: 11, color: theme.color.muted, marginTop: 2 },
    empty: { alignItems: "center", padding: theme.spacing.xxl, gap: 8 },
    emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.color.onSurface, marginTop: 8 },
    emptyHint: { fontSize: 13, color: theme.color.muted, textAlign: "center" },
  });
}
