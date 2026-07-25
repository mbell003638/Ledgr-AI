import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { LogBox, View, Platform, useWindowDimensions, Text, ScrollView, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { ThemeProvider, useTheme, useThemeMode } from "@/src/context/ThemeContext";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync().catch(() => {});

// ---------- Error Boundary ----------
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: "#1C4030", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 12 }}>
            Ledgr crashed on startup
          </Text>
          <ScrollView style={{ maxHeight: 300, backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 12 }}>
            <Text style={{ color: "#EE7C6E", fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>
              {this.state.error.message}
            </Text>
            <Text style={{ color: "#ccc", fontSize: 11, marginTop: 8, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>
              {this.state.error.stack?.slice(0, 800)}
            </Text>
          </ScrollView>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: 14, backgroundColor: "#4A6E5C", borderRadius: 8, alignItems: "center" }}
          >
            <Text style={{ color: "#fff", fontWeight: "600" }}>Try Again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// ---------- Icon fonts (simplified — no CDN fetch for native builds) ----------
function useIconFontsSafe(): [boolean, Error | null] {
  // In native APK builds, vector-icon fonts are bundled by the autolinking
  // plugin. We don't need to load them at runtime. Returning [true, null]
  // immediately so the splash screen hides without waiting for a font fetch.
  // The CDN-fetch path was only needed for Expo Go, which we are not using.
  return [true, null];
}

// ---------- Themed Stack ----------
function ThemedStack() {
  const theme = useTheme();
  const { effective } = useThemeMode();
  const { width } = useWindowDimensions();
  const isWideWeb = Platform.OS === "web" && width >= 768;
  return (
    <View style={{ flex: 1, backgroundColor: isWideWeb ? theme.color.surfaceTertiary : theme.color.surface, alignItems: "center" }}>
      <StatusBar style={effective === "dark" ? "light" : "dark"} />
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: isWideWeb ? 480 : undefined,
          backgroundColor: theme.color.surface,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: isWideWeb ? 0.08 : 0,
          shadowRadius: isWideWeb ? 24 : 0,
          elevation: isWideWeb ? 8 : 0,
        }}
      >
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
        <Stack.Screen name="reconcile" options={{ presentation: "card" }} />
        <Stack.Screen name="invoices" options={{ presentation: "card" }} />
        <Stack.Screen name="expenses" options={{ presentation: "card" }} />
        <Stack.Screen name="debtors" options={{ presentation: "card" }} />
        <Stack.Screen name="daybook" options={{ presentation: "card" }} />
        <Stack.Screen name="ask" options={{ presentation: "card" }} />
        <Stack.Screen name="onboarding" options={{ presentation: "card", gestureEnabled: false }} />
        </Stack>
      </View>
    </View>
  );
}

// ---------- Root Layout ----------
export default function RootLayout() {
  const [loaded, error] = useIconFontsSafe();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    // Safety: hide splash after 5 seconds no matter what
    const timer = setTimeout(() => {
      setTimedOut(true);
      SplashScreen.hideAsync().catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (loaded || error) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [loaded, error]);

  if (!loaded && !error && !timedOut) return null;

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <ThemedStack />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
