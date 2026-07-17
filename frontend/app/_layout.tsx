import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

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
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="supplier/[id]" options={{ presentation: "card" }} />
          <Stack.Screen name="bill-form" options={{ presentation: "modal" }} />
          <Stack.Screen name="supplier-form" options={{ presentation: "modal" }} />
          <Stack.Screen name="sale-form" options={{ presentation: "modal" }} />
          <Stack.Screen name="payment-form" options={{ presentation: "modal" }} />
          <Stack.Screen name="inventory-form" options={{ presentation: "modal" }} />
          <Stack.Screen name="voice" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
