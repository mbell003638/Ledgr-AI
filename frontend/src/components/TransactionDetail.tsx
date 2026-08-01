import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";

type ActionName = "Edit" | "Reversal/Delete" | "Share" | "Print" | "More";

export type TransactionDetailAction = {
  label: ActionName;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress?: () => void;
  disabled?: boolean;
};

export type TransactionDetailProps = {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  children?: React.ReactNode;
  onEdit?: () => void;
  onReversalDelete?: () => void;
  onShare?: () => void;
  onPrint?: () => void;
  onMore?: () => void;
};

/** Shared transaction detail shell and action bar for transaction screens. */
export function TransactionDetail({
  title,
  subtitle,
  badge,
  children,
  onEdit,
  onReversalDelete,
  onShare,
  onPrint,
  onMore,
}: TransactionDetailProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const actions: TransactionDetailAction[] = [
    { label: "Edit", icon: "create-outline", onPress: onEdit },
    { label: "Reversal/Delete", icon: "trash-outline", onPress: onReversalDelete },
    { label: "Share", icon: "share-outline", onPress: onShare },
    { label: "Print", icon: "print-outline", onPress: onPrint },
    { label: "More", icon: "ellipsis-horizontal", onPress: onMore },
  ];

  return (
    <View style={styles.container} testID="transaction-detail">
      <View style={styles.heading}>
        <Text style={styles.title}>{title}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {badge}
        </View>
      </View>
      {children ? <View style={styles.content}>{children}</View> : null}
      <View style={styles.actions} accessibilityRole="toolbar" accessibilityLabel="Transaction actions">
        {actions.map(({ label, icon, onPress, disabled }) => (
          <Pressable
            key={label}
            onPress={onPress}
            disabled={disabled || !onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: Boolean(disabled || !onPress) }}
            style={({ pressed }) => [styles.action, pressed && styles.pressed, (disabled || !onPress) && styles.disabled]}
          >
            <Ionicons name={icon} size={20} color={theme.color.onSurface} />
            <Text style={styles.actionLabel}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: { backgroundColor: theme.color.surfaceSecondary, borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.color.border, overflow: "hidden" },
    heading: { padding: theme.spacing.lg, paddingBottom: theme.spacing.md },
    title: { color: theme.color.onSurface, fontSize: 20, fontWeight: "700" },
    subtitle: { color: theme.color.muted, fontSize: 13, marginTop: 4 },
    content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
    actions: { flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.color.divider, padding: theme.spacing.sm, justifyContent: "space-between" },
    action: { alignItems: "center", flex: 1, gap: 4, paddingVertical: theme.spacing.sm, borderRadius: theme.radius.sm },
    actionLabel: { color: theme.color.onSurface, fontSize: 11, fontWeight: "600", textAlign: "center" },
    pressed: { opacity: 0.65, backgroundColor: theme.color.surfaceTertiary },
    disabled: { opacity: 0.4 },
  });
}
