import React from "react";
import { Tabs } from "expo-router";
import { Platform, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Grid3X3 from "lucide-react-native/icons/grid-3x3";
import Users from "lucide-react-native/icons/users";
import PieChart from "lucide-react-native/icons/chart-pie";
import Settings from "lucide-react-native/icons/settings";
import { useAnimations, useTheme } from "@/src/context/ThemeContext";
import QuickActionMenu from "@/src/components/QuickActionMenu";
import VoiceFab from "@/src/components/VoiceFab";

const TAB_ICON_SIZE = 22;

type TabIconComponent = React.ComponentType<{
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}>;

function PrototypeTabIcon({ color, focused, Icon }: { color: string; focused: boolean; Icon: TabIconComponent }) {
  return (
    <View style={{ width: 28, height: 24, alignItems: "center", justifyContent: "center", transform: [{ translateY: focused ? -1 : 0 }] }}>
      <Icon width={TAB_ICON_SIZE} height={TAB_ICON_SIZE} color={color} strokeWidth={focused ? 2.25 : 2} />
    </View>
  );
}

function PrototypeTabLabel({ color, focused, children }: { color: string; focused: boolean; children: string }) {
  return (
    <View style={{ minWidth: 60, alignItems: "center", justifyContent: "center" }}>
      <Text
        allowFontScaling
        maxFontSizeMultiplier={1.25}
        numberOfLines={1}
        style={{ color, fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 0.1, includeFontPadding: false, textAlign: "center" }}
      >
        {children}
      </Text>
      <View
        {...(Platform.OS === "web"
          ? ({ dataSet: { tabIndicator: focused ? "active" : "inactive" } } as any)
          : {})}
        style={{ width: 28, height: 3, marginTop: 3, borderRadius: 999, backgroundColor: color, opacity: focused ? 1 : 0 }}
      />
    </View>
  );
}

function WebTabMotion({ brandColor, enabled }: { brandColor: string; enabled: boolean }) {
  if (Platform.OS !== "web" || !enabled) return null;

  // Preserve Expo Router's own anchor. Only its icon and short underline move,
  // avoiding the square focus/active outline and any document-reload behavior.
  return React.createElement("style", {
    dangerouslySetInnerHTML: {
      __html: `
        [role="tablist"] [role="tab"] {
          box-sizing: border-box;
          position: relative;
          border: 0 !important;
          border-radius: 18px;
          outline: none;
          background: transparent !important;
          box-shadow: none !important;
          overflow: visible !important;
        }
        [role="tablist"] [role="tab"] svg {
          transform-origin: center;
          transition: transform 220ms cubic-bezier(.2,.9,.3,1);
          will-change: transform;
        }
        [role="tablist"] [role="tab"]:hover svg {
          transform: translateY(-2px) scale(1.04);
        }
        [role="tablist"] [role="tab"][aria-selected="true"] svg {
          transform: translateY(-1px);
        }
        [role="tablist"] [role="tab"] [data-tab-indicator] {
          transition: opacity 180ms ease, transform 220ms cubic-bezier(.2,.9,.3,1), box-shadow 180ms ease;
          transform: scaleX(.55);
          transform-origin: center;
        }
        [role="tablist"] [role="tab"]:hover [data-tab-indicator] {
          opacity: .62 !important;
          transform: scaleX(.78);
          box-shadow: 0 0 8px color-mix(in srgb, ${brandColor} 32%, transparent);
        }
        [role="tablist"] [role="tab"][aria-selected="true"] [data-tab-indicator] {
          opacity: 1 !important;
          transform: scaleX(1);
          box-shadow: 0 0 10px color-mix(in srgb, ${brandColor} 50%, transparent);
        }
        [role="tablist"] [role="tab"]:focus,
        [role="tablist"] [role="tab"]:focus-visible {
          outline: none !important;
        }
        [role="tablist"] [role="tab"]:focus-visible [data-tab-indicator] {
          opacity: 1 !important;
          transform: scaleX(1.15);
          box-shadow: 0 0 12px color-mix(in srgb, ${brandColor} 58%, transparent);
        }
        @media (prefers-reduced-motion: reduce) {
          [role="tablist"] [role="tab"] svg,
          [role="tablist"] [role="tab"] [data-tab-indicator] {
            transition: none;
          }
          [role="tablist"] [role="tab"]:hover svg,
          [role="tablist"] [role="tab"][aria-selected="true"] svg {
            transform: none;
          }
        }
      `,
    },
  } as any);
}

export default function TabsLayout() {
  const theme = useTheme();
  const { motionEnabled, hapticsEnabled } = useAnimations();
  const insets = useSafeAreaInsets();
  // The prototype is 80px tall. A 64px content area plus the real bottom
  // inset keeps that proportion while clearing gesture and three-button bars.
  const tabBarBottomInset = Math.max(insets.bottom, 16);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.surface }}>
      <WebTabMotion brandColor={theme.color.brandPrimary} enabled={motionEnabled} />
      <Tabs
        screenListeners={{
          tabPress: () => {
            if (hapticsEnabled && Platform.OS !== "web") {
              Haptics.selectionAsync().catch(() => {});
            }
          },
        }}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: theme.color.brandPrimary,
          tabBarInactiveTintColor: theme.color.muted,
          tabBarActiveBackgroundColor: "transparent",
          tabBarInactiveBackgroundColor: "transparent",
          tabBarStyle: {
            backgroundColor: theme.color.surfaceSecondary,
            borderTopColor: theme.color.border,
            borderTopWidth: 1,
            height: 64 + tabBarBottomInset,
            paddingTop: 7,
            paddingBottom: tabBarBottomInset,
            paddingHorizontal: 10,
            elevation: 8,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.05,
            shadowRadius: 12,
          },
          tabBarLabelPosition: "below-icon",
          tabBarLabel: (props) => <PrototypeTabLabel {...props} />,
          tabBarIconStyle: { marginTop: 0 },
          tabBarItemStyle: { borderRadius: 18, marginHorizontal: 2 },
          sceneStyle: { backgroundColor: theme.color.surface },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ color, focused }) => <PrototypeTabIcon Icon={Grid3X3} color={color} focused={focused} />,
            tabBarButtonTestID: "tab-home",
          }}
        />
        <Tabs.Screen
          name="suppliers"
          options={{
            title: "Accounts",
            tabBarIcon: ({ color, focused }) => <PrototypeTabIcon Icon={Users} color={color} focused={focused} />,
            tabBarButtonTestID: "tab-suppliers",
          }}
        />
        <Tabs.Screen
          name="quick_action_spacer"
          options={{
            title: "",
            tabBarIcon: () => null,
            tabBarButton: () => <View accessible={false} pointerEvents="none" style={{ flex: 1 }} />,
          }}
        />
        <Tabs.Screen
          name="reports"
          options={{
            title: "Reports",
            tabBarIcon: ({ color, focused }) => <PrototypeTabIcon Icon={PieChart} color={color} focused={focused} />,
            tabBarButtonTestID: "tab-reports",
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, focused }) => <PrototypeTabIcon Icon={Settings} color={color} focused={focused} />,
            tabBarButtonTestID: "tab-settings",
          }}
        />
        <Tabs.Screen name="bills" options={{ href: null }} />
      </Tabs>
      <QuickActionMenu />
      <VoiceFab />
    </View>
  );
}
