import React, { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { quickActionFabBottom, quickActionMenuBottom, quickActionMenuMaxHeight, quickActionMenuWidth } from "@/src/utils/responsiveLayout";

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

  const setHover = (value: number) => {
    hover.value = reduceMotion ? value : withTiming(value, { duration: theme.motion.fast });
  };
  const setPressed = (value: number) => {
    pressed.value = reduceMotion ? value : withSpring(value, theme.motion.spring);
  };

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      onHoverIn={() => setHover(1)}
      onHoverOut={() => setHover(0)}
      onPressIn={() => {
        setPressed(1);
        if (hapticsEnabled && Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
      }}
      onPressOut={() => setPressed(0)}
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
    </AnimatedPressable>
  );
}

export default function QuickActionMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [openingModalVisible, setOpeningModalVisible] = useState(false);
  const [isPartnerMode, setIsPartnerMode] = useState(false);
  const router = useRouter();
  const theme = useTheme();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const fabBottom = quickActionFabBottom(insets.bottom);
  const menuBottom = quickActionMenuBottom(insets.bottom);
  const menuWidth = quickActionMenuWidth(screenWidth, insets.left, insets.right);
  const menuMaxHeight = quickActionMenuMaxHeight(screenHeight, insets.top, insets.bottom);
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const reduceMotion = useReducedMotion() || !motionEnabled;
  const progress = useSharedValue(0);
  const fabHover = useSharedValue(0);
  const fabPressed = useSharedValue(0);

  React.useEffect(() => {
    Promise.all([
      api.getV2BookConfig().catch(() => null),
      api.listInvestors().catch(() => []),
    ]).then(([config, investors]: any[]) => {
      setIsPartnerMode(config?.style === "retail_partnership" || investors.length > 0);
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
    shadowOpacity: 0.42 + fabHover.value * 0.18,
    shadowRadius: theme.effects.glowRadius + fabHover.value * 8,
  }), [reduceMotion, theme]);

  const navigate = (route: string | { pathname: string; params?: Record<string, string> }) => {
    closeMenu();
    router.push(route as any);
  };

  return (
    <>
      <View style={[styles.fabContainer, { bottom: fabBottom }]}>
        <AnimatedPressable
          testID="quick-action-fab"
          accessibilityRole="button"
          accessibilityLabel="Open Quick Actions"
          accessibilityHint="Create or record a business transaction"
          accessibilityState={{ expanded: isOpen }}
          onHoverIn={() => { fabHover.value = reduceMotion ? 1 : withTiming(1, { duration: theme.motion.standard }); }}
          onHoverOut={() => { fabHover.value = reduceMotion ? 0 : withTiming(0, { duration: theme.motion.standard }); }}
          onPressIn={() => { fabPressed.value = reduceMotion ? 1 : withSpring(1, theme.motion.spring); }}
          onPressOut={() => { fabPressed.value = reduceMotion ? 0 : withSpring(0, theme.motion.spring); }}
          onPress={toggleMenu}
          style={[
            styles.fab,
            {
              backgroundColor: isOpen ? theme.color.surfaceTertiary : theme.color.brandPrimary,
              shadowColor: isOpen ? theme.color.muted : theme.color.brandPrimary,
            },
            fabStyle,
          ]}
        >
          <Animated.View style={fabIconStyle}>
            <Ionicons name="add" size={28} color={isOpen ? theme.color.onSurface : theme.color.onBrandPrimary} />
          </Animated.View>
        </AnimatedPressable>
      </View>

      <Modal transparent visible={isOpen} animationType="none" onRequestClose={closeMenu}>
        <Animated.View style={[styles.overlayContainer, overlayStyle]}>
          <Pressable style={styles.overlayPressable} onPress={closeMenu}>
            <BlurView intensity={35} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.72)" }]} />
          </Pressable>
        </Animated.View>

        <Animated.View
          testID="quick-action-menu"
          accessibilityViewIsModal
          style={[
            styles.menuContainer,
            {
              backgroundColor: theme.color.surfaceSecondary,
              borderColor: theme.color.brandPrimary,
              shadowColor: theme.color.brandPrimary,
              width: menuWidth,
              bottom: menuBottom,
              maxHeight: menuMaxHeight,
            },
            menuStyle,
          ]}
        >
          <LinearGradient
            pointerEvents="none"
            colors={["transparent", theme.color.brandPrimary, "transparent"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.menuHighlight}
          />
          <ScrollView
            testID="quick-action-scroll"
            style={styles.menuScroller}
            contentContainerStyle={styles.menuInner}
            showsVerticalScrollIndicator={false}
            bounces={false}
            nestedScrollEnabled
          >
            <GlowPressable
              prominent
              haptic
              onPress={() => navigate("/ask")}
              style={[
                styles.aiAction,
                {
                  borderColor: theme.color.brandPrimary,
                  backgroundColor: theme.color.brandPrimary + "18",
                },
              ]}
            >
              <LinearGradient
                pointerEvents="none"
                colors={[theme.color.brandPrimary + "33", theme.color.brandPrimary + "0D"]}
                style={StyleSheet.absoluteFill}
              />
              <Text style={[styles.aiIcon, { textShadowColor: theme.color.brandPrimary + "80" }]}>✨</Text>
              <Text style={[styles.aiText, { color: theme.color.brandPrimary }]}>Scan Receipt or Ask AI</Text>
            </GlowPressable>

            <QuickActionRow
              icon="🧾"
              iconBackground="rgba(56,189,248,0.15)"
              title="Create Invoice"
              subtitle="Bill a customer with line items & tax"
              onPress={() => navigate({ pathname: "/invoices", params: { action: "create" } })}
            />
            <QuickActionRow
              icon="💰"
              iconBackground="rgba(74,222,128,0.15)"
              title="Log Sale"
              subtitle="Record a quick cash or credit sale"
              onPress={() => navigate("/sale-form")}
            />
            <QuickActionRow icon="💸" iconBackground="rgba(239,68,68,0.15)" title="Add Expense" subtitle="Log a bill or purchase" onPress={() => navigate("/bill-form")} />
            <QuickActionRow icon="💵" iconBackground="rgba(59,130,246,0.15)" title="Receive Payment" subtitle="Log incoming funds" onPress={() => navigate("/receipt-form")} />
            <QuickActionRow
              icon="👥"
              iconBackground="rgba(168,85,247,0.15)"
              title="Add Business Account"
              subtitle={isPartnerMode ? "Customer, supplier or capital account" : "Customer or supplier"}
              onPress={() => navigate("/suppliers?action=create")}
            />
            <QuickActionRow
              icon="📄"
              iconBackground="rgba(45,212,191,0.15)"
              title="Scan & Import"
              subtitle="AI-import a document or old report"
              onPress={() => navigate("/scan-import")}
            />
            <QuickActionRow
              icon="⚙️"
              iconBackground="rgba(234,179,8,0.15)"
              title="Opening Balances"
              subtitle="Setup starting cash, stock & equity"
              onPress={() => {
                closeMenu();
                setTimeout(() => setOpeningModalVisible(true), theme.motion.fast);
              }}
            />
          </ScrollView>
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
    alignSelf: "center",
    width: "94%",
    maxWidth: 410,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    borderWidth: 1,
    overflow: "hidden",
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.42,
    shadowRadius: 28,
    elevation: 18,
    transformOrigin: "bottom",
  },
  menuHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    opacity: 0.8,
  },
  menuScroller: { flexShrink: 1, width: "100%" },
  menuInner: { padding: 12 },
  aiAction: {
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  aiIcon: {
    fontSize: 22,
    marginRight: 10,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  aiText: { flexShrink: 1, fontSize: 16, fontWeight: "800", letterSpacing: 0.2, textAlign: "center" },
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
  actionDetails: { flex: 1, minWidth: 0 },
  actionTitle: { fontSize: 15, fontWeight: "700", marginBottom: 2 },
  actionSubtitle: { fontSize: 12 },
  fabContainer: {
    position: "absolute",
    alignSelf: "center",
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
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
});
