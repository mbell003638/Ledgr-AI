import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet, Modal, Platform, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/context/ThemeContext";
import { GlowPressable } from "@/src/components/GlowPressable";

export type ActionSheetItem = {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
};

interface Props {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  actions: ActionSheetItem[];
  animatedActions?: boolean;
}

export function ActionSheetModal({ visible, onClose, title = "Options", subtitle, actions, animatedActions = false }: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <Modal visible={visible} transparent animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={onClose}>
      <Pressable onPress={onClose} style={styles.overlay}>
        <Pressable onPress={(e) => e.stopPropagation()} style={styles.sheetContainer}>
          <View style={styles.handleBar} />
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <ScrollView style={{ maxHeight: 320, marginTop: 12 }} contentContainerStyle={{ paddingHorizontal: 2, paddingTop: 2 }}>
            {actions.map((act) => {
              const content = <>
                <View style={[styles.iconContainer, act.destructive && { backgroundColor: theme.color.errorBg }]}>
                  <Ionicons name={act.icon} size={20} color={act.destructive ? theme.color.error : theme.color.brandPrimary} />
                </View>
                <Text style={[styles.actionLabel, act.destructive && { color: theme.color.error }]}>{act.label}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.color.muted} />
              </>;
              const select = () => {
                onClose();
                act.onPress();
              };
              return animatedActions ? (
                <GlowPressable
                  key={act.id}
                  haptic
                  topHighlight={false}
                  hoverLift={0}
                  hoverScale={1}
                  restingBorderColor={theme.color.border}
                  onPress={select}
                  style={styles.actionRow}
                >
                  {content}
                </GlowPressable>
              ) : (
                <Pressable
                  key={act.id}
                  onPress={select}
                  style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
                >
                  {content}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable onPress={onClose} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(theme: any) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.65)",
      justifyContent: "flex-end",
      alignItems: "center",
    },
    sheetContainer: {
      width: "100%",
      maxWidth: 480,
      backgroundColor: theme.color.surfaceSecondary,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    handleBar: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.color.muted,
      alignSelf: "center",
      marginBottom: theme.spacing.md,
      opacity: 0.5,
    },
    title: {
      fontSize: 18,
      fontWeight: "700",
      color: theme.color.onSurface,
      textAlign: "center",
    },
    subtitle: {
      fontSize: 12,
      color: theme.color.muted,
      textAlign: "center",
      marginTop: 2,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: theme.radius.md,
      marginBottom: 6,
      backgroundColor: theme.color.surface,
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    actionRowPressed: {
      backgroundColor: theme.color.surfaceTertiary,
    },
    iconContainer: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: theme.color.brandPrimary + "15",
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    actionLabel: {
      flex: 1,
      fontSize: 14,
      fontWeight: "600",
      color: theme.color.onSurface,
    },
    cancelBtn: {
      marginTop: theme.spacing.md,
      paddingVertical: 14,
      borderRadius: theme.radius.md,
      backgroundColor: theme.color.surfaceTertiary,
      alignItems: "center",
      borderWidth: 1,
      borderColor: theme.color.border,
    },
    cancelText: {
      fontSize: 14,
      fontWeight: "700",
      color: theme.color.onSurface,
    },
  });
}
