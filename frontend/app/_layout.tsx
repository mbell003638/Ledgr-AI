import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { ThemeProvider, useTheme, useThemeMode } from "@/src/context/ThemeContext";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

function ThemedStack() {
  const theme = useTheme();
  const { effective } = useThemeMode();
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.surface }}>
      <StatusBar style={effective === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.surface } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="supplier/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="bill-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="supplier-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="sale-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="payment-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="inventory-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="voice" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="monthly-summary" options={{ presentation: "card" }} />
      </Stack>
    </View>
  );
}

export default function RootLayout() {
  const [loaded, error] = useIconFonts();

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStack />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
