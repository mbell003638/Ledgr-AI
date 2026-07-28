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
            borderTopWidth: 1,
            height: 88,
            paddingTop: 10,
            paddingBottom: 28,
            elevation: 8,
            shadowColor: "#000",
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.05,
            shadowRadius: 12,
          },
          tabBarLabelStyle: { fontSize: 12, fontWeight: "600", marginTop: -2 },
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
      </Tabs>
      <VoiceFab />
    </View>
  );
}
