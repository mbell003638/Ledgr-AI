import React, { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, {
  Extrapolation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";
import { LinearGradient } from "expo-linear-gradient";
import { OpeningBalancesModal } from "@/src/components/OpeningBalancesModal";
import { GlowPressable } from "@/src/components/GlowPressable";
import { api } from "@/src/api";
import { isCapabilityEnabled } from "@/src/utils/capabilities";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type QuickActionRowProps = {
  icon: string;
  iconBackground: string;
  title: string;
  subtitle: string;
  onPress: () => void;
};

function QuickActionRow({ icon, iconBackground, title, subtitle, onPress }: QuickActionRowProps) {
  const theme = useTheme();
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const reduceMotion = useReducedMotion() || !motionEnabled;
  const hover = useSharedValue(0);
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(255,255,255,${0.08 * Math.max(hover.value, pressed.value)})`,
    transform: [
      { translateX: reduceMotion ? 0 : 4 * hover.value },
      { scale: reduceMotion ? 1 : 1 - pressed.value * 0.015 },
    ],
  }), [reduceMotion]);
  const PressableComponent: any = Platform.OS === "web" ? Pressable : AnimatedPressable;

  const setHover = (value: number) => {
    hover.value = reduceMotion ? value : withTiming(value, { duration: theme.motion.fast });
  };
  const setPressed = (value: number) => {
    pressed.value = reduceMotion ? value : withSpring(value, theme.motion.spring);
  };

  return (
    <PressableComponent
      onHoverIn={() => setHover(1)}
      onHoverOut={() => setHover(0)}
      onPressIn={() => {
        setPressed(1);
        if (hapticsEnabled && Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
      }}
      onPressOut={() => setPressed(0)}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      onPress={onPress}
      style={[styles.actionRow, animatedStyle]}
    >
      <View style={[styles.actionIconCircle, { backgroundColor: iconBackground }]}>
        <Text style={{ fontSize: 20 }}>{icon}</Text>
      </View>
      <View style={styles.actionDetails}>
        <Text style={[styles.actionTitle, { color: theme.color.onSurface }]}>{title}</Text>
        <Text style={[styles.actionSubtitle, { color: theme.color.muted }]}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.color.muted} />
    </PressableComponent>
  );
}

export default function QuickActionMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [openingModalVisible, setOpeningModalVisible] = useState(false);
  const [isPartnerMode, setIsPartnerMode] = useState(false);
  const [settings, setSettings] = useState<any>({});
  const accountsEnabled = isCapabilityEnabled(settings, "customers") || isCapabilityEnabled(settings, "procurement") || isCapabilityEnabled(settings, "invoicing");
  const router = useRouter();
  const theme = useTheme();
  const isWeb = Platform.OS === "web";
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const reduceMotion = useReducedMotion() || !motionEnabled;
  const progress = useSharedValue(0);
  const fabHover = useSharedValue(0);
  const fabPressed = useSharedValue(0);

  React.useEffect(() => {
    Promise.all([
      api.getV2BookConfig().catch(() => null),
      api.listInvestors().catch(() => []),
      api.getSettings().catch(() => ({})),
    ]).then(([config, investors, currentSettings]: any[]) => {
      setIsPartnerMode(config?.style === "retail_partnership" || investors.length > 0);
      setSettings(currentSettings || {});
    }).catch(() => {});
  }, [isOpen]);

  const openMenu = () => {
    setIsOpen(true);
    if (hapticsEnabled && Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    progress.value = reduceMotion ? 1 : withSpring(1, theme.motion.sheetSpring);
  };

  const closeMenu = () => {
    if (!isOpen) return;
    progress.value = reduceMotion
      ? 0
      : withTiming(0, { duration: theme.motion.fast, easing: Easing.out(Easing.cubic) });
    setTimeout(() => setIsOpen(false), reduceMotion ? 0 : theme.motion.fast);
  };

  const toggleMenu = () => {
    if (isOpen) closeMenu();
    else openMenu();
  };

  const overlayStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const menuStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: reduceMotion ? 0 : interpolate(progress.value, [0, 1], [32, 0], Extrapolation.CLAMP) },
      { scale: reduceMotion ? 1 : interpolate(progress.value, [0, 1], [0.96, 1], Extrapolation.CLAMP) },
    ],
  }), [reduceMotion]);
  const fabIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 45])}deg` }],
  }));
  const fabStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: reduceMotion ? 0 : -3 * fabHover.value },
      { scale: reduceMotion ? 1 : 1 + fabHover.value * 0.08 - fabPressed.value * 0.04 },
    ],
  }), [reduceMotion]);

  const FabPressableComponent: any = isWeb ? Pressable : AnimatedPressable;

  const navigate = (route: string | { pathname: string; params?: Record<string, string> }) => {
    closeMenu();
    router.push(route as any);
  };

  return (
    <>
      <View style={styles.fabContainer}>
        <FabPressableComponent
          testID="quick-action-fab"
          onHoverIn={() => { fabHover.value = reduceMotion ? 1 : withTiming(1, { duration: theme.motion.standard }); }}
          onHoverOut={() => { fabHover.value = reduceMotion ? 0 : withTiming(0, { duration: theme.motion.standard }); }}
          onPressIn={() => { fabPressed.value = reduceMotion ? 1 : withSpring(1, theme.motion.spring); }}
          onPressOut={() => { fabPressed.value = reduceMotion ? 0 : withSpring(0, theme.motion.spring); }}
          onPress={toggleMenu}
          style={[
            styles.fab,
            fabStyle,
            {
              backgroundColor: isOpen ? theme.color.surfaceTertiary : theme.color.brandPrimary,
              ...(isWeb
                ? { boxShadow: isOpen ? `0 4px 16px ${theme.color.muted}33` : `0 4px 16px ${theme.color.brandPrimary}55` }
                : { shadowColor: isOpen ? theme.color.muted : theme.color.brandPrimary, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 12 }),
            },
            { opacity: 0.8 },
          ]}
        >
          <Animated.View style={fabIconStyle}>
            <Ionicons name="add" size={28} color={isOpen ? theme.color.onSurface : theme.color.onBrandPrimary} />
          </Animated.View>
        </FabPressableComponent>
      </View>

      <Modal transparent visible={isOpen} animationType="none" onRequestClose={closeMenu}>
        <Animated.View style={[styles.overlayContainer, overlayStyle]}>
          <Pressable style={styles.overlayPressable} onPress={closeMenu}>
            <BlurView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.72)" }]} />
          </Pressable>
        </Animated.View>

        <Animated.View
          style={[
            styles.menuContainer,
            {
              backgroundColor: theme.color.surfaceSecondary,
              borderColor: theme.color.brandPrimary,
              ...(isWeb
                ? { boxShadow: `0 -4px 24px ${theme.color.brandPrimary}33` }
                : { shadowColor: theme.color.brandPrimary, shadowOffset: { width: 0, height: -8 }, shadowOpacity: 0.32, shadowRadius: 24, elevation: 18 }),
            },
            menuStyle,
          ]}
        >
          <LinearGradient
            colors={["transparent", theme.color.brandPrimary, "transparent"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.menuHighlight}
          />
          <View style={styles.menuInner}>
            {isCapabilityEnabled(settings, "ai_assistant") && <GlowPressable
              haptic
              topHighlight={false}
              clipSafe
              accessibilityRole="button"
              accessibilityLabel="Scan receipt or ask AI"
              accessibilityHint="Opens Ask AI and document import tools"
              onPress={() => navigate("/ask")}
              style={[
                styles.aiAction,
                {
                  borderColor: theme.color.brandPrimary + "66",
                  backgroundColor: theme.color.brandPrimary + "12",
                },
              ]}
            >
              <View style={[styles.aiIcon, { backgroundColor: theme.color.brandPrimary + "22" }]}>
                <Ionicons name="sparkles-outline" size={20} color={theme.color.brandPrimary} />
              </View>
              <Text style={[styles.aiText, { color: theme.color.brandPrimary }]}>Scan Receipt or Ask AI</Text>
            </GlowPressable>}

            {isCapabilityEnabled(settings, "invoicing") && <QuickActionRow
              icon="🧾"
              iconBackground="rgba(56,189,248,0.15)"
              title="Create Invoice"
              subtitle="Bill a customer with line items & tax"
              onPress={() => navigate({ pathname: "/invoices", params: { action: "create" } })}
            />}
            {isCapabilityEnabled(settings, "commerce") && <QuickActionRow
              icon="💰"
              iconBackground="rgba(74,222,128,0.15)"
              title="Log Sale"
              subtitle="Record a quick cash or credit sale"
              onPress={() => navigate("/sale-form")}
            />}
            {isCapabilityEnabled(settings, "core_ledger") && <QuickActionRow icon="💸" iconBackground="rgba(239,68,68,0.15)" title="Add Expense" subtitle="Record a business expense" onPress={() => navigate("/expenses")} />}
            {isCapabilityEnabled(settings, "procurement") && <QuickActionRow icon="🛒" iconBackground="rgba(248,113,113,0.15)" title="Add Purchase" subtitle="Log a supplier bill or purchase" onPress={() => navigate("/bill-form")} />}
            {isCapabilityEnabled(settings, "customers") && <QuickActionRow icon="💵" iconBackground="rgba(59,130,246,0.15)" title="Receive Payment" subtitle="Log incoming funds" onPress={() => navigate("/receipt-form")} />}
            {accountsEnabled && <QuickActionRow
              icon="👥"
              iconBackground="rgba(168,85,247,0.15)"
              title="Add Account"
              subtitle={isPartnerMode ? "Customer, supplier or capital account" : "Customer or supplier account"}
              onPress={() => navigate("/suppliers?action=create")}
            />}
            {isCapabilityEnabled(settings, "ai_assistant") && <QuickActionRow
              icon="📄"
              iconBackground="rgba(45,212,191,0.15)"
              title="Scan & Import"
              subtitle="AI-import a document or old report"
              onPress={() => navigate("/scan-import")}
            />}
            {isCapabilityEnabled(settings, "core_ledger") && <QuickActionRow
              icon="⚙️"
              iconBackground="rgba(234,179,8,0.15)"
              title="Opening Balances"
              subtitle="Setup starting cash, stock & equity"
              onPress={() => {
                closeMenu();
                setTimeout(() => setOpeningModalVisible(true), theme.motion.fast);
              }}
            />}
          </View>
        </Animated.View>
      </Modal>

      <OpeningBalancesModal visible={openingModalVisible} onClose={() => setOpeningModalVisible(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  overlayContainer: { ...StyleSheet.absoluteFillObject },
  overlayPressable: { flex: 1 },
  menuContainer: {
    position: "absolute",
    bottom: 98,
    alignSelf: "center",
    width: "94%",
    maxWidth: 410,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    borderWidth: 1,
    overflow: "hidden",
    transformOrigin: "bottom",
  },
  menuHighlight: {
    position: "absolute",
    top: 5,
    left: 22,
    right: 22,
    height: 1,
    borderRadius: 1,
    opacity: 0.42,
    pointerEvents: "none",
  },
  menuInner: { padding: 12 },
  aiAction: {
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  aiIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  aiText: { fontSize: 16, fontWeight: "800", letterSpacing: 0.2 },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  actionIconCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },
  actionDetails: { flex: 1 },
  actionTitle: { fontSize: 15, fontWeight: "700", marginBottom: 2 },
  actionSubtitle: { fontSize: 12 },
  fabContainer: {
    position: "absolute",
    alignSelf: "center",
    bottom: 42,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 110,
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: "center",
    alignItems: "center",
  },
});
