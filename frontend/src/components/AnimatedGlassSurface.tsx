import { Platform, View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  withSequence,
  withSpring,
} from "react-native-reanimated";

import { useAnimations, useTheme } from "@/src/context/ThemeContext";

const AnimatedView = Animated.createAnimatedComponent(View);

type AnimatedGlassSurfaceProps = Omit<ViewProps, "style"> & {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  topHighlight?: boolean;
  shadowEnabled?: boolean;
  surfaceColor?: string;
  hoverSurfaceColor?: string;
  restingBorderColor?: string;
  prominent?: boolean;
};

/**
 * Non-pressable glass surface that can safely contain buttons and inputs.
 * On web it mirrors the prototype card hover; native keeps the same static
 * glass/glow treatment while child controls provide touch feedback.
 */
export function AnimatedGlassSurface(props: AnimatedGlassSurfaceProps) {
  const theme = useTheme();
  const { motionEnabled } = useAnimations();
  if (!motionEnabled) {
    const { children, style, surfaceColor, restingBorderColor } = props;
    const { topHighlight: _topHighlight, hoverSurfaceColor: _hoverSurfaceColor, prominent: _prominent, shadowEnabled: _shadowEnabled, ...rest } = props;
    return (
      <View
        {...rest}
        style={[
          { position: "relative", backgroundColor: surfaceColor ?? theme.color.glassSurface, borderWidth: 1, borderColor: restingBorderColor ?? theme.color.glassBorder },
          style,
          staticElevation(theme, _shadowEnabled !== false),
        ]}
      >
        {children}
      </View>
    );
  }
  return <AnimatedGlassSurfaceImpl {...props} />;
}
function AnimatedGlassSurfaceImpl({
  children,
  style,
  topHighlight = true,
  shadowEnabled = true,
  prominent = false,
  surfaceColor,
  hoverSurfaceColor,
  restingBorderColor,
  ...viewProps
}: AnimatedGlassSurfaceProps) {
  const theme = useTheme();
  const isWeb = Platform.OS === "web";
  const reduceMotion = useReducedMotion();
  const transformProgress = useSharedValue(0);
  const surfaceProgress = useSharedValue(0);

  const setHovered = (hovered: boolean) => {
    const value = hovered ? 1 : 0;
    transformProgress.value = reduceMotion || !hovered
      ? 0
      : withSequence(
          withTiming(1, { duration: 80 }),
          // Clamp the overshoot so the surface settles without a visible bounce,
          // matching GlowPressable's calmed press motion for consistent feel.
          withSpring(0, { ...theme.motion.spring, overshootClamping: true }),
        );
    surfaceProgress.value = reduceMotion
      ? value
      : withTiming(value, {
          duration: theme.motion.standard,
          easing: Easing.inOut(Easing.ease),
        });
  };

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      surfaceProgress.value,
      [0, 1],
      [surfaceColor ?? theme.color.glassSurface, hoverSurfaceColor ?? theme.color.glassSurfaceHover],
    ),
    borderColor: interpolateColor(
      surfaceProgress.value,
      [0, 1],
      [restingBorderColor ?? theme.color.glassBorder, theme.color.brandPrimary],
    ),
    transform: [
      { scale: reduceMotion ? 1 : 1 - interpolate(transformProgress.value, [0, 1], [0, 0.012]) },
    ],
    ...(isWeb
      ? {
          boxShadow: shadowEnabled
            ? `0 4px ${prominent ? 22 : 14}px rgba(0,0,0,${prominent ? 0.18 : 0.12})`
            : "none",
        }
      : {
          shadowColor: theme.color.brandPrimary,
          shadowOpacity: shadowEnabled ? interpolate(
            surfaceProgress.value,
            [0, 1],
            [0.08, prominent ? 0.48 : theme.effects.glowOpacity],
          ) : 0,
          shadowRadius: shadowEnabled ? interpolate(
            surfaceProgress.value,
            [0, 1],
            [4, prominent ? theme.effects.strongGlowRadius : theme.effects.glowRadius],
          ) : 0,
          elevation: shadowEnabled ? interpolate(surfaceProgress.value, [0, 1], [2, prominent ? 12 : 8]) : 0,
        }),
  }), [hoverSurfaceColor, prominent, reduceMotion, restingBorderColor, shadowEnabled, surfaceColor, theme]);

  const topEdge = topHighlight && Platform.OS === "web" ? (
    <LinearGradient
      colors={["transparent", theme.color.brandPrimary, "transparent"]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        opacity: 0.35,
        pointerEvents: "none",
      }}
    />
  ) : null;

  if (Platform.OS !== "web") {
    return (
      <View
        {...viewProps}
        onPointerEnter={undefined}
        onPointerLeave={undefined}
        style={[
          {
            position: "relative",
            backgroundColor: surfaceColor ?? theme.color.glassSurface,
            borderWidth: 1,
            borderColor: restingBorderColor ?? theme.color.glassBorder,
          },
          style,
          staticElevation(theme, shadowEnabled),
        ]}
      >
        {children}
        {topEdge}
      </View>
    );
  }
  return (
    <AnimatedView
      {...viewProps}
      onPointerEnter={(event) => {
        setHovered(true);
        viewProps.onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        viewProps.onPointerLeave?.(event);
      }}
      style={[
        {
          position: "relative",
            backgroundColor: surfaceColor ?? theme.color.glassSurface,
            borderWidth: 1,
            borderColor: restingBorderColor ?? theme.color.glassBorder,
            boxShadow: "none",
        },
        style,
        animatedStyle,
      ]}
    >
      {children}
      {topEdge}
    </AnimatedView>
  );
}

function staticElevation(theme: ReturnType<typeof useTheme>, enabled = true): ViewStyle {
  if (Platform.OS === "web") {
    return { boxShadow: enabled ? "0 4px 14px rgba(0,0,0,0.12)" : "none" } as ViewStyle;
  }
  if (!enabled) return { shadowOpacity: 0, shadowRadius: 0, elevation: 0 } as ViewStyle;
  return {
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  } as ViewStyle;
}
