import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FoldPosture, HingeRect, useFoldPosture } from "@/src/hooks/foldPosture";

export type ResponsiveLayoutMode = "compactPhone" | "phone" | "tablet" | "wide";
export type { FoldPosture };

export type ResponsiveDeviceMetrics = {
  width: number;
  height: number;
  shortestSide: number;
  landscape: boolean;
  compactPhone: boolean;
  phone: boolean;
  tablet: boolean;
  wide: boolean;
  layoutMode: ResponsiveLayoutMode;
  safeTop: number;
  safeBottom: number;
  safeLeft: number;
  safeRight: number;
  foldPosture: FoldPosture;
  hasHinge: boolean;
  dualPane: boolean;
  hingeRect: HingeRect | null;
};

/**
 * Centralized presentation metrics. Phone is deliberately the default and the
 * fold contract stays disabled until native posture/hinge data is available.
 * Accounting, routing, capability, and location decisions must not depend on
 * this hook.
 */
export function useResponsiveDevice(): ResponsiveDeviceMetrics {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const fold = useFoldPosture();
  return useMemo(() => {
    const shortestSide = Math.min(width, height);
    const landscape = width > height;
    const compactPhone = shortestSide < 360;
    const tablet = shortestSide >= 600;
    const wide = width >= 900;
    const phone = !tablet;
    const layoutMode: ResponsiveLayoutMode = compactPhone
      ? "compactPhone"
      : wide
        ? "wide"
        : tablet
          ? "tablet"
          : "phone";

    return {
      width,
      height,
      shortestSide,
      landscape,
      compactPhone,
      phone,
      tablet,
      wide,
      layoutMode,
      safeTop: insets.top,
      safeBottom: insets.bottom,
      safeLeft: insets.left,
      safeRight: insets.right,
      foldPosture: fold.posture,
      hasHinge: fold.hasHinge,
      dualPane: fold.dualPane,
      hingeRect: fold.hingeRect,
    };
  }, [fold.dualPane, fold.hasHinge, fold.hingeRect, fold.posture, height, insets.bottom, insets.left, insets.right, insets.top, width]);
}

export function responsivePlatformLabel(): "web" | "ios" | "android" | "native" {
  if (Platform.OS === "web" || Platform.OS === "ios" || Platform.OS === "android") return Platform.OS;
  return "native";
}
