import React, { useMemo } from "react";
import { View, Text, StyleSheet, ViewStyle, TextStyle, StyleProp, Platform, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";
import { GlowPressable } from "@/src/components/GlowPressable";
import { AnimatedGlassSurface } from "@/src/components/AnimatedGlassSurface";

import { api } from "@/src/api";
import { isCompactHeaderWidth } from "@/src/utils/responsiveLayout";

export function ScreenHeader({ title, subtitle, testID, leftAction, rightAction, compact = false, style, titleStyle, subtitleStyle }: { title: string; subtitle?: string; testID?: string; leftAction?: React.ReactNode; rightAction?: React.ReactNode; compact?: boolean; style?: StyleProp<ViewStyle>; titleStyle?: StyleProp<TextStyle>; subtitleStyle?: StyleProp<TextStyle> }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const compactHeader = compact || (isCompactHeaderWidth(width) && (Boolean(leftAction) || title.length > 18));

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
      <View style={[{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: compactHeader ? 8 : 10 }, compactHeader && styles.compactRow]}>
        <View style={[{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start' }, compactHeader && styles.compactTitleArea]}>
          {leftAction ? <View style={{ marginRight: compactHeader ? 6 : 10, paddingTop: 2 }}>{leftAction}</View> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={compactHeader ? 2 : undefined} adjustsFontSizeToFit={compactHeader} minimumFontScale={compactHeader ? 0.78 : undefined} ellipsizeMode={compactHeader ? "tail" : undefined} style={[styles.title, titleStyle, compactHeader && styles.titleCompact]}>{title}</Text>
            {subtitle ? <Text numberOfLines={compactHeader ? 2 : undefined} ellipsizeMode="tail" style={[styles.subtitle, subtitleStyle]}>{subtitle}</Text> : null}
          </View>
        </View>
        <View style={[{ alignItems: "flex-end", gap: compactHeader ? 6 : 8, maxWidth: compactHeader ? 82 : "45%" }, compactHeader && styles.compactActions]}>
          {bizName ? (
              <View accessible accessibilityLabel={`Business Account ${bizName}`} style={{ flexShrink: 0, maxWidth: compactHeader ? 82 : undefined, backgroundColor: theme.color.brandPrimary + "15", paddingHorizontal: compactHeader ? 9 : 14, paddingVertical: compactHeader ? 6 : 8, borderRadius: 20, borderWidth: 1, borderColor: theme.color.brandPrimary + "40", flexDirection: "row", alignItems: "center", gap: compactHeader ? 4 : 6 }}>
              <Ionicons name="business" size={14} color={theme.color.brandPrimary} />
              <Text numberOfLines={1} ellipsizeMode="tail" style={{ flexShrink: 1, maxWidth: compactHeader ? 48 : undefined, fontSize: 13, fontWeight: "800", color: theme.color.brandPrimary, textTransform: "uppercase", letterSpacing: 0.5 }}>{bizName}</Text>
            </View>
          ) : null}
          {rightAction}
        </View>
      </View>
    </View>
  );
}

export function Card({ children, style, testID, shadowEnabled = false, surfaceColor, hoverSurfaceColor, restingBorderColor }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string; shadowEnabled?: boolean; surfaceColor?: string; hoverSurfaceColor?: string; restingBorderColor?: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <AnimatedGlassSurface style={[styles.card, style]} testID={testID} shadowEnabled={shadowEnabled} surfaceColor={surfaceColor ?? theme.color.surfaceSecondary} hoverSurfaceColor={hoverSurfaceColor} restingBorderColor={restingBorderColor}>
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
    titleCompact: { fontSize: 22, lineHeight: 27, letterSpacing: -0.35 },
    compactRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    compactTitleArea: { flex: 1, minWidth: 0 },
    compactActions: { alignSelf: "flex-start", flexShrink: 0, maxWidth: 82 },
    subtitle: { fontSize: 13, color: theme.color.muted, marginTop: 2 },
    card: {
      backgroundColor: theme.color.glassSurface,
      borderRadius: theme.radius.card,
      padding: 18,
      borderWidth: 1,
      borderColor: theme.color.glassBorder,
      overflow: "hidden",
      ...(Platform.OS === "web" ? { boxShadow: "none" } : {}),
      marginVertical: 0,
    },
    kpi: {
      flex: 1,
      backgroundColor: theme.color.glassSurface,
      borderRadius: theme.radius.kpi,
      padding: 14,
      borderWidth: 1,
      borderColor: theme.color.glassBorder,
      overflow: "hidden",
      ...(Platform.OS === "web" ? { boxShadow: "none" } : {}),
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
