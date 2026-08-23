import React, { useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import type { LucideIcon } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  LinearTransition,
  interpolate,
  interpolateColor,
  runOnJS,
  scrollTo,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";

export type WorkspaceTileItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  route: string;
  iconColor?: string;
  iconBackground?: string;
  usesBrandIcon?: boolean;
  solidBrand?: boolean;
};

type ReorderableWorkspaceGridProps = {
  items: readonly WorkspaceTileItem[];
  editing: boolean;
  scrollRef: any;
  scrollY: SharedValue<number>;
  onEditingChange: (editing: boolean) => void;
  onOrderChange: (fromIndex: number, toIndex: number) => void;
  onTilePress: (tile: WorkspaceTileItem) => void;
};

const COLUMNS = 2;
const GAP = 12;
const TILE_HEIGHT = 115;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function slotPosition(index: number, tileWidth: number) {
  "worklet";
  return {
    x: (index % COLUMNS) * (tileWidth + GAP),
    y: Math.floor(index / COLUMNS) * (TILE_HEIGHT + GAP),
  };
}

export function ReorderableWorkspaceGrid({
  items,
  editing,
  scrollRef,
  scrollY,
  onEditingChange,
  onOrderChange,
  onTilePress,
}: ReorderableWorkspaceGridProps) {
  const theme = useTheme();
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(Math.max(0, Math.min(windowWidth, 1080) - 36));
  const tileWidth = (gridWidth - GAP) / COLUMNS;

  const activeIndex = useSharedValue(-1);
  const targetIndex = useSharedValue(-1);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragStartScrollY = useSharedValue(0);

  const hapticDragStart = (index: number) => {
    onEditingChange(true);
    if (hapticsEnabled && Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
  };

  const hapticSlotChange = () => {
    if (hapticsEnabled && Platform.OS !== "web") {
      Haptics.selectionAsync().catch(() => {});
    }
  };

  const commitDrop = (fromIndex: number, toIndex: number) => {
    const settleMs = theme.motion.fast;
    setTimeout(() => {
      onOrderChange(fromIndex, toIndex);
      if (hapticsEnabled && Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      requestAnimationFrame(() => {
        activeIndex.value = -1;
        targetIndex.value = -1;
        dragX.value = 0;
        dragY.value = 0;
      });
    }, motionEnabled ? settleMs : 0);
  };

  const cancelDrag = () => {
    activeIndex.value = -1;
    targetIndex.value = -1;
    dragX.value = 0;
    dragY.value = 0;
  };

  return (
    <View
      style={styles.grid}
      onLayout={(event) => {
        const measured = event.nativeEvent.layout.width;
        if (measured > 0 && Math.abs(measured - gridWidth) > 1) setGridWidth(measured);
      }}
    >
      {items.map((tile, index) => (
        <ReorderableWorkspaceTile
          key={tile.key}
          tile={tile}
          index={index}
          itemCount={items.length}
          editing={editing}
          tileWidth={tileWidth}
          windowHeight={windowHeight}
          scrollRef={scrollRef}
          scrollY={scrollY}
          dragStartScrollY={dragStartScrollY}
          activeIndex={activeIndex}
          targetIndex={targetIndex}
          dragX={dragX}
          dragY={dragY}
          onDragStart={hapticDragStart}
          onSlotChange={hapticSlotChange}
          onDrop={commitDrop}
          onCancel={cancelDrag}
          onPress={() => onTilePress(tile)}
        />
      ))}
    </View>
  );
}

type ReorderableWorkspaceTileProps = {
  tile: WorkspaceTileItem;
  index: number;
  itemCount: number;
  editing: boolean;
  tileWidth: number;
  windowHeight: number;
  scrollRef: any;
  scrollY: SharedValue<number>;
  dragStartScrollY: SharedValue<number>;
  activeIndex: SharedValue<number>;
  targetIndex: SharedValue<number>;
  dragX: SharedValue<number>;
  dragY: SharedValue<number>;
  onDragStart: (index: number) => void;
  onSlotChange: () => void;
  onDrop: (fromIndex: number, toIndex: number) => void;
  onCancel: () => void;
  onPress: () => void;
};

function ReorderableWorkspaceTile({
  tile,
  index,
  itemCount,
  editing,
  tileWidth,
  windowHeight,
  scrollRef,
  scrollY,
  dragStartScrollY,
  activeIndex,
  targetIndex,
  dragX,
  dragY,
  onDragStart,
  onSlotChange,
  onDrop,
  onCancel,
  onPress,
}: ReorderableWorkspaceTileProps) {
  const theme = useTheme();
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const reduceMotion = useReducedMotion() || !motionEnabled;
  const isBrand = tile.usesBrandIcon === true;
  const solidBrand = tile.solidBrand === true;
  const isWeb = Platform.OS === "web";
  const TileIcon = tile.icon;
  const hover = useSharedValue(0);
  const surfaceHover = useSharedValue(0);
  const iconHover = useSharedValue(0);
  const pressed = useSharedValue(0);

  const animateHover = (value: number) => {
    if (!motionEnabled) {
      hover.value = 0;
      surfaceHover.value = 0;
      iconHover.value = 0;
      return;
    }
    if (reduceMotion) {
      hover.value = value;
      surfaceHover.value = value;
      iconHover.value = value;
      return;
    }
    hover.value = withTiming(value, {
      duration: theme.motion.expressive,
      easing: Easing.bezier(0.2, 0.9, 0.3, 1),
    });
    surfaceHover.value = withTiming(value, {
      duration: theme.motion.standard,
      easing: Easing.ease,
    });
    iconHover.value = withTiming(value, {
      duration: 300,
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    });
  };

  const animatePress = (value: number) => {
    if (!motionEnabled) {
      pressed.value = 0;
      return;
    }
    pressed.value = reduceMotion ? value : withSpring(value, theme.motion.spring);
  };

  const tileSurfaceStyle = useAnimatedStyle(() => {
    const focus = Math.max(surfaceHover.value, pressed.value * 0.45);
    const commonStyle = {
      backgroundColor: interpolateColor(focus, [0, 1], [solidBrand ? theme.color.brandPrimary : isBrand ? theme.color.brandPrimary + "14" : theme.color.glassSurface, solidBrand ? theme.color.brandSecondary : theme.color.glassSurfaceHover]),
      borderColor: interpolateColor(focus, [0, 1], [solidBrand ? theme.color.brandPrimary : isBrand ? theme.color.brandPrimary + "80" : theme.color.glassBorder, solidBrand ? theme.color.brandSecondary : theme.color.brandPrimary]),
      transform: reduceMotion ? [] : [
        { translateY: interpolate(hover.value, [0, 1], [0, -5]) },
        { scale: 1 + hover.value * 0.02 - pressed.value * 0.03 },
      ],
    };

    // Native shadow properties are intentionally excluded from the web worklet.
    // React Native Web can serialize those properties as a detached rectangle;
    // the browser receives one bounded CSS shadow instead.
    return isWeb
      ? {
          ...commonStyle,
          boxShadow: focus > 0
            ? `0 4px ${isBrand ? 20 : 14}px ${theme.color.brandPrimary}2E`
            : "none",
        }
      : {
          ...commonStyle,
          shadowColor: theme.color.brandPrimary,
          shadowOpacity: isBrand ? 0.16 : 0,
          shadowRadius: isBrand ? 8 : 0,
          elevation: 4,
        };
  }, [isBrand, isWeb, reduceMotion, solidBrand, theme]);

  const iconMotionStyle = useAnimatedStyle(() => ({
    transform: reduceMotion ? [] : [
      { scale: 1 + iconHover.value * 0.10 },
      { rotate: `${-3 * iconHover.value}deg` },
    ],
  }), [reduceMotion]);


  const gesture = useMemo(() => Gesture.Pan()
    .activateAfterLongPress(motionEnabled ? theme.motion.longPress : 999999)
    .onStart(() => {
      activeIndex.value = index;
      targetIndex.value = index;
      dragX.value = 0;
      dragY.value = 0;
      dragStartScrollY.value = scrollY.value;
      runOnJS(onDragStart)(index);
    })
    .onUpdate((event) => {
      if (activeIndex.value !== index) return;

      const scrollCompensation = scrollY.value - dragStartScrollY.value;
      dragX.value = event.translationX;
      dragY.value = event.translationY + scrollCompensation;

      const origin = slotPosition(index, tileWidth);
      const centerX = origin.x + tileWidth / 2 + dragX.value;
      const centerY = origin.y + TILE_HEIGHT / 2 + dragY.value;
      const column = Math.max(0, Math.min(COLUMNS - 1, Math.round(centerX / (tileWidth + GAP))));
      const row = Math.max(0, Math.round(centerY / (TILE_HEIGHT + GAP)));
      const nextTarget = Math.max(0, Math.min(itemCount - 1, row * COLUMNS + column));

      if (nextTarget !== targetIndex.value) {
        targetIndex.value = nextTarget;
        runOnJS(onSlotChange)();
      }

      // Keep long grids movable without releasing the tile. Scroll changes are
      // compensated above so the active tile remains attached to the finger.
      if (event.absoluteY < 120 && scrollY.value > 0) {
        scrollTo(scrollRef, 0, Math.max(0, scrollY.value - 9), false);
      } else if (event.absoluteY > windowHeight - 150) {
        scrollTo(scrollRef, 0, scrollY.value + 9, false);
      }
    })
    .onEnd(() => {
      if (activeIndex.value !== index) return;
      const finalTarget = targetIndex.value < 0 ? index : targetIndex.value;
      const origin = slotPosition(index, tileWidth);
      const destination = slotPosition(finalTarget, tileWidth);
      dragX.value = reduceMotion
        ? destination.x - origin.x
        : withSpring(destination.x - origin.x, theme.motion.spring);
      dragY.value = reduceMotion
        ? destination.y - origin.y
        : withSpring(destination.y - origin.y, theme.motion.spring);
      runOnJS(onDrop)(index, finalTarget);
    })
    .onFinalize((_event, success) => {
      if (!success && activeIndex.value === index) {
        runOnJS(onCancel)();
      }
    }), [
      motionEnabled,
      activeIndex,
      dragStartScrollY,
      dragX,
      dragY,
      index,
      itemCount,
      onCancel,
      onDragStart,
      onSlotChange,
      onDrop,
      reduceMotion,
      scrollRef,
      scrollY,
      targetIndex,
      theme.motion.longPress,
      theme.motion.spring,
      tileWidth,
      windowHeight,
    ]);

  const dragStyle = useAnimatedStyle(() => {
    const from = activeIndex.value;
    const to = targetIndex.value;
    let translateX = 0;
    let translateY = 0;
    const active = from === index;

    if (active) {
      translateX = dragX.value;
      translateY = dragY.value;
    } else if (from >= 0 && to >= 0 && from < to && index > from && index <= to) {
      const current = slotPosition(index, tileWidth);
      const destination = slotPosition(index - 1, tileWidth);
      translateX = destination.x - current.x;
      translateY = destination.y - current.y;
    } else if (from >= 0 && to >= 0 && from > to && index >= to && index < from) {
      const current = slotPosition(index, tileWidth);
      const destination = slotPosition(index + 1, tileWidth);
      translateX = destination.x - current.x;
      translateY = destination.y - current.y;
    }

    const animatedX = active || reduceMotion ? translateX : withSpring(translateX, theme.motion.spring);
    const animatedY = active || reduceMotion ? translateY : withSpring(translateY, theme.motion.spring);

    return {
      zIndex: active ? 100 : 1,
      opacity: active ? 0.96 : 1,
      transform: [
        { translateX: animatedX },
        { translateY: animatedY },
        { scale: active && !reduceMotion ? withSpring(1.065, theme.motion.spring) : 1 },
        { rotate: active && !reduceMotion ? "-1deg" : "0deg" },
      ],
      shadowColor: theme.color.brandPrimary,
      shadowOpacity: isWeb && active ? 0.55 : 0,
      shadowRadius: isWeb && active ? theme.effects.strongGlowRadius : 0,
      elevation: isWeb && active ? 18 : 0,
    };
  }, [index, isWeb, reduceMotion, theme, tileWidth]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        layout={!motionEnabled || Platform.OS === "android" ? undefined : LinearTransition.springify().damping(18).stiffness(220)}
        style={[{ width: tileWidth, height: TILE_HEIGHT }, dragStyle]}
      >
        <AnimatedPressable
          testID={`tile-${tile.key}`}
          accessibilityRole="button"
          accessibilityLabel={tile.label}
          accessibilityHint={editing ? "Drag to reorder this workspace" : `Opens ${tile.label}`}
          accessibilityState={{ disabled: editing }}
          onHoverIn={() => animateHover(1)}
          onHoverOut={() => animateHover(0)}
          onPressIn={() => {
            animatePress(1);
            if (hapticsEnabled && !editing && Platform.OS !== "web") {
              Haptics.selectionAsync().catch(() => {});
            }
          }}
          onPressOut={() => animatePress(0)}
          onPress={() => {
            if (!editing && activeIndex.value < 0) onPress();
          }}
          style={[
            styles.tile,
            editing && styles.tileEditing,
            tileSurfaceStyle,
            !motionEnabled && {
              backgroundColor: solidBrand ? theme.color.brandPrimary : theme.color.glassSurface,
              borderColor: solidBrand ? theme.color.brandPrimary : theme.color.glassBorder,
              shadowOpacity: 0,
              shadowRadius: 0,
              elevation: 0,
              ...(Platform.OS === "web" ? { boxShadow: "none" } : {}),
            },
          ]}
        >
          {isWeb && motionEnabled ? <LinearGradient
            pointerEvents="none"
            colors={["transparent", solidBrand ? theme.color.onBrandPrimary : theme.color.brandPrimary, "transparent"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.topHighlight, { opacity: theme.effects.topHighlightOpacity }]}
          /> : null}
          <Animated.View
            style={[
              styles.tileIcon,
              {
                backgroundColor: solidBrand ? `${theme.color.onBrandPrimary}24` : isBrand ? `${theme.color.brandPrimary}24` : tile.iconBackground,
              },
              iconMotionStyle,
            ]}
          >
            <TileIcon
              width={22}
              height={22}
              strokeWidth={2}
              color={solidBrand ? theme.color.onBrandPrimary : isBrand ? theme.color.brandPrimary : tile.iconColor}
            />
          </Animated.View>
          <Text style={[styles.tileLabel, { color: solidBrand ? theme.color.onBrandPrimary : theme.color.onSurface }, editing && styles.tileLabelEditing]}>
            {tile.label}
          </Text>
          {editing ? (
            <View style={[styles.dragHandle, { backgroundColor: `${theme.color.brandPrimary}22` }]}>
              <Ionicons name="reorder-three" size={18} color={theme.color.brandPrimary} />
            </View>
          ) : null}
        </AnimatedPressable>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: GAP,
    rowGap: GAP,
  },
  tile: {
    width: "100%",
    height: "100%",
    borderRadius: 22,
    borderWidth: 1,
    padding: 16,
    justifyContent: "space-between",
    shadowOffset: { width: 0, height: 0 },
  },
  tileEditing: {
    borderWidth: 1.5,
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  tileIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    justifyContent: "center",
    alignItems: "center",
  },
  tileLabel: {
    fontSize: 14,
    fontWeight: "700",
    marginTop: 12,
  },
  tileLabelEditing: {
    paddingRight: 24,
  },
  dragHandle: {
    position: "absolute",
    right: 10,
    top: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
