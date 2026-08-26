import React from "react";
import {
  Platform,
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  withSequence,
} from "react-native-reanimated";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type GlowPressableProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  animateBorder?: boolean;
  pressScale?: number;
  disabled?: boolean;
  clipSafe?: boolean;
  glowRadius?: number;
  accessibilityRole?: any;
  accessibilityLabel?: string;
  accessibilityState?: any;
  prominent?: boolean;
  shadowEnabled?: boolean;
  haptic?: boolean;
  topHighlight?: boolean;
  restingBorderColor?: string;
  hoverBorderColor?: string;
  glowColor?: string;
  hoverLift?: number;
  hoverScale?: number;
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  onPressIn?: (event: GestureResponderEvent) => void;
  onPressOut?: (event: GestureResponderEvent) => void;
};

/**
 * Shared pointer/touch treatment derived from the HTML prototype:
 * hover lifts and glows, touch compresses slightly, and a narrow brand
 * highlight runs along the top edge. Long-press drag motion is layered by the
 * workspace grid so this component remains useful for ordinary controls too.
 */
export function GlowPressable(props: GlowPressableProps) {
  const { motionEnabled } = useAnimations();
  if (!motionEnabled) {
    const { children, style, testID, disabled, accessibilityRole, accessibilityLabel, accessibilityState, onPress, onLongPress, onPressIn, onPressOut } = props;
    return (
      <Pressable
        testID={testID}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          { position: "relative", borderWidth: 1, borderColor: props.restingBorderColor ?? "transparent" },
          style,
          { shadowOpacity: 0, shadowRadius: 0, elevation: 0, ...(Platform.OS === "web" ? { boxShadow: "none" } : {}) },
        ]}
      >
        {children}
      </Pressable>
    );
  }
  return <AnimatedGlowPressable {...props} />;
}
function AnimatedGlowPressable({
  children,
  style,
  testID,
  glowRadius,
  disabled,
  accessibilityRole,
  accessibilityLabel,
  accessibilityState,
  prominent = false,
  shadowEnabled = true,
  animateBorder = true,
  pressScale = 0.982,
  clipSafe = true,
  haptic = false,
  topHighlight = true,
  restingBorderColor,
  hoverBorderColor,
  glowColor,
  hoverLift = -4,
  hoverScale = 1.02,
  onPress,
  onLongPress,
  onPressIn,
  onPressOut,
}: GlowPressableProps) {
  const theme = useTheme();
  const isWeb = Platform.OS === "web";
  const reduceMotion = useReducedMotion();
  const hover = useSharedValue(0);
  const pressed = useSharedValue(0);
  const bounce = useSharedValue(0);

  // The shared theme spring is intentionally springy (ζ≈0.73, underdamped) so it
  // overshoots its target. On a large surface like the dashboard hero tile that
  // overshoot reads as a visible bounce on press/release, while the small KPI
  // tiles hide it — the inconsistency the user reported. Clamp the overshoot so
  // press motion settles crisply to its resting scale everywhere: consistent,
  // subtle, no bounce. (The animationsEnabled=false bypass above is untouched.)
  const settleSpring = { ...theme.motion.spring, overshootClamping: true };

  const animateHover = (value: number) => {
    hover.value = reduceMotion
      ? value
      : withTiming(value, { duration: theme.motion.expressive });
    if (value === 1 && clipSafe && !reduceMotion) {
      bounce.value = withSequence(
        withTiming(1, { duration: 80 }),
        withSpring(0, settleSpring),
      );
    }

  };

  const animatePress = (value: number) => {
    pressed.value = reduceMotion
      ? value
      : withSpring(value, settleSpring);
  };

  const animatedStyle = useAnimatedStyle(() => {
    const focus = Math.max(hover.value, pressed.value * 0.72);
    const translateY = reduceMotion || clipSafe ? 0 : interpolate(hover.value, [0, 1], [0, hoverLift]);
    const scale = reduceMotion
      ? 1
      : clipSafe
        ? 1 - bounce.value * 0.012 - pressed.value * (1 - pressScale)
        : 1 + hover.value * (hoverScale - 1) - pressed.value * (1 - pressScale);

    return {
      borderColor: animateBorder
        ? interpolateColor(
            focus,
            [0, 1],
            [restingBorderColor ?? theme.color.glassBorder, hoverBorderColor ?? theme.color.brandPrimary],
          )
        : restingBorderColor ?? theme.color.glassBorder,
      transform: [{ translateY }, { scale }],
      shadowColor: glowColor ?? theme.color.brandPrimary,
      shadowOpacity: shadowEnabled && isWeb ? interpolate(
        focus,
        [0, 1],
        [0, prominent ? 0.48 : theme.effects.glowOpacity],
      ) : 0,
      shadowRadius: shadowEnabled && isWeb ? interpolate(
        focus,
        [0, 1],
        [0, glowRadius ?? (prominent ? theme.effects.strongGlowRadius : theme.effects.glowRadius)],
      ) : 0,
      elevation: shadowEnabled && isWeb ? interpolate(focus, [0, 1], [0, prominent ? 12 : 8]) : 0,
    };
  }, [animateBorder, bounce, clipSafe, glowColor, glowRadius, hoverBorderColor, hoverLift, hoverScale, isWeb, pressScale, prominent, reduceMotion, restingBorderColor, shadowEnabled, theme]);

  return (
    <AnimatedPressable
      testID={testID}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      onHoverIn={Platform.OS === "web" ? () => animateHover(1) : undefined}
      onHoverOut={Platform.OS === "web" ? () => animateHover(0) : undefined}
      onPress={(event) => onPress?.(event)}
      onLongPress={(event) => onLongPress?.(event)}
      onPressIn={(event) => {
        animatePress(1);
        if (haptic && Platform.OS !== "web") {
          Haptics.selectionAsync().catch(() => {});
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animatePress(0);
        onPressOut?.(event);
      }}
      style={[
        {
          position: "relative",
          borderWidth: 1,
          borderColor: restingBorderColor ?? theme.color.glassBorder,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
        animatedStyle,
      ]}
    >
      {children}
      {topHighlight && isWeb ? <LinearGradient
        pointerEvents="none"
        colors={["transparent", theme.color.brandPrimary, "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          borderTopLeftRadius: theme.radius.card,
          borderTopRightRadius: theme.radius.card,
          opacity: theme.effects.topHighlightOpacity,
        }}
      /> : null}
    </AnimatedPressable>
  );
}
