import { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAnimations } from "@/src/context/ThemeContext";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";

export type VoiceOrbPhase = "idle" | "recording" | "processing";

type Props = {
  phase: VoiceOrbPhase;
  theme: any;
  compact?: boolean;
};

const BAR_HEIGHTS = [8, 12, 18, 28, 20, 34, 24, 38, 22, 32, 18, 26, 14, 9];

export function VoiceOrb({ phase, theme, compact = false }: Props) {
  const pulse = useSharedValue(0);
  const { motionEnabled } = useAnimations();

  useEffect(() => {
    pulse.value = phase === "recording" && motionEnabled
      ? withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true)
      : withTiming(0, { duration: 180 });
  }, [motionEnabled, phase, pulse]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (compact ? 0.045 : 0.09) * pulse.value }],
  }));
  const waveStyle = useAnimatedStyle(() => ({
    opacity: phase === "processing" ? 0.55 : 0.7 + pulse.value * 0.3,
    transform: [{ scaleX: 0.96 + pulse.value * 0.04 }],
  }));

  const size = compact ? 44 : 112;
  const glyphSize = compact ? 20 : 42;
  const color = theme.color.onBrandPrimary || "#fff";
  const accent = theme.color.brandPrimary;

  return (
    <View style={[styles.root, compact ? styles.rootCompact : styles.rootLarge]}>
      <Animated.View style={[styles.orb, { width: size, height: size, borderRadius: size / 2, backgroundColor: accent }, orbStyle]}>
        <Ionicons name={phase === "processing" ? "ellipsis-horizontal" : phase === "recording" ? "stop" : "mic"} size={glyphSize} color={color} />
      </Animated.View>
      <Animated.View style={[styles.wave, waveStyle]}>
        {BAR_HEIGHTS.map((height, index) => (
          <View key={index} style={{ width: compact ? 2 : 3, height: compact ? Math.max(5, height * 0.55) : height, borderRadius: 4, backgroundColor: index % 6 === 2 ? theme.color.info || accent : accent }} />
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", justifyContent: "center" },
  rootLarge: { minHeight: 156, minWidth: 300 },
  rootCompact: { flexDirection: "row", gap: 6, width: 72, minHeight: 48, overflow: "hidden" },
  orb: { alignItems: "center", justifyContent: "center", zIndex: 2 },
  wave: { position: "absolute", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 2, width: "100%", paddingHorizontal: 2 },
});
