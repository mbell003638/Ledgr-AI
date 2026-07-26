import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { View } from "react-native";
import { useTheme } from "@/src/context/ThemeContext";
import VoiceFab from "@/src/components/VoiceFab";

export default function TabsLayout() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.surface }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: theme.color.brandPrimary,
          tabBarInactiveTintColor: theme.color.muted,
          tabBarStyle: {
            backgroundColor: theme.color.surfaceSecondary,
            borderTopColor: theme.color.border,
            height: 84,
            paddingTop: 8,
            paddingBottom: 24,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
          sceneStyle: { backgroundColor: theme.color.surface },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ color, size }) => <Ionicons name="apps-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-home",
          }}
        />
        <Tabs.Screen
          name="bills"
          options={{
            title: "Bills",
            tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-bills",
          }}
        />
        <Tabs.Screen
          name="suppliers"
          options={{
            title: "Parties",
            tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-suppliers",
          }}
        />
        <Tabs.Screen
          name="reports"
          options={{
            title: "Reports",
            tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-reports",
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-settings",
          }}
        />
        <Tabs.Screen
          name="employee-report"
          options={{
            // Removed from the bottom bar — now reachable from Reports → Staff Report.
            href: null,
            title: "Staff",
            tabBarIcon: ({ color, size }) => <Ionicons name="briefcase-outline" size={size} color={color} />,
            tabBarButtonTestID: "tab-staff",
          }}
        />
      </Tabs>
      <VoiceFab />
    </View>
  );
}
