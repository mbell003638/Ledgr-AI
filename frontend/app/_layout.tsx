import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { LogBox, View, Platform, useWindowDimensions, Text, ScrollView, FlatList, SectionList, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import * as ImagePicker from "expo-image-picker";
import { ThemeProvider, useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { initStorage } from "@/src/db/backend";


// Keep scrolling functional while removing platform scrollbar chrome globally.
// Individual screens can still opt in explicitly if a visible indicator is needed.
[ScrollView, FlatList, SectionList].forEach((ScrollComponent) => {
  const component = ScrollComponent as any;
  component.defaultProps = {
    ...component.defaultProps,
    showsVerticalScrollIndicator: false,
    showsHorizontalScrollIndicator: false,
  };
});
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
          maxWidth: isWideWeb ? 440 : undefined,
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
        <Stack.Screen name="investor/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="bill-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="party-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="sale-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="sales" options={{ presentation: "card" }} />
        <Stack.Screen name="cashbook" options={{ presentation: "card" }} />
        <Stack.Screen name="assets" options={{ presentation: "card" }} />
        <Stack.Screen name="payment-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="receipt-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="payments" options={{ presentation: "card" }} />
        <Stack.Screen name="inventory-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="voice" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="monthly-summary" options={{ presentation: "card" }} />
        <Stack.Screen name="custom-report" options={{ presentation: "card" }} />
        <Stack.Screen name="reconcile" options={{ presentation: "card" }} />
        <Stack.Screen name="invoices" options={{ presentation: "card" }} />
        <Stack.Screen name="quotes" options={{ presentation: "card" }} />
        <Stack.Screen name="delivery-notes" options={{ presentation: "card" }} />
        <Stack.Screen name="receipts" options={{ presentation: "card" }} />
        <Stack.Screen name="expenses" options={{ presentation: "card" }} />
        <Stack.Screen name="customer/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="debtors" options={{ presentation: "card" }} />
        <Stack.Screen name="daybook" options={{ presentation: "card" }} />
        <Stack.Screen name="ask" options={{ presentation: "card" }} />
        <Stack.Screen name="onboarding" options={{ presentation: "card", gestureEnabled: false }} />
        <Stack.Screen name="customize-features" options={{ presentation: "card" }} />
        </Stack>
      </View>
    </View>
  );
}

import { Image, Animated, StyleSheet } from "react-native";


function AppOpeningSplashScreen() {
  const scaleAnim = React.useRef(new Animated.Value(0.92)).current;
  const opacityAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacityAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, friction: 7, tension: 50, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0C", justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
      <Animated.View style={{ alignItems: "center", opacity: opacityAnim, transform: [{ scale: scaleAnim }] }}>
        {/* Official App Icon (Green Neon Dollar Emblem) */}
        <View
          style={{
            width: 100,
            height: 100,
            borderRadius: 24,
            overflow: "hidden",
            marginBottom: 24,
            shadowColor: "#22c55e",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.45,
            shadowRadius: 16,
            elevation: 10,
            borderWidth: 1,
            borderColor: "rgba(34, 197, 94, 0.3)",
          }}
        >
          <Image
            source={require("@/assets/images/icon.png")}
            style={{ width: 100, height: 100, borderRadius: 24 }}
            resizeMode="cover"
          />
        </View>

        {/* Title matching Image 1: Ledgr */}
        <Text style={{ fontSize: 34, fontWeight: "800", color: "#FFFFFF", letterSpacing: -0.5 }}>
          Ledgr
        </Text>

        {/* Subtitle matching Image 1: Your business finances, simplified */}
        <Text style={{ fontSize: 14, fontWeight: "400", color: "#94A3B8", marginTop: 6, letterSpacing: 0.2 }}>
          Your business finances, simplified
        </Text>
      </Animated.View>
    </View>
  );
}

// ---------- Root Layout ----------
function WebScrollbarStyles() {
  if (Platform.OS !== "web") return null;
  return React.createElement("style", {
    dangerouslySetInnerHTML: {
      __html: `
        html, body, #root, #root *, body > div, body > div * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        html::-webkit-scrollbar, body::-webkit-scrollbar,
        #root::-webkit-scrollbar, #root *::-webkit-scrollbar,
        body > div::-webkit-scrollbar, body > div *::-webkit-scrollbar {
          width: 0 !important;
          height: 0 !important;
          display: none !important;
          background: transparent !important;
        }
      `,
    },
  } as any);
}

export default function RootLayout() {

  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Replace the native splash immediately with the in-app opening screen.
    SplashScreen.hideAsync().catch(() => {});

    // Do not mount the router until the persisted active book and SQLite
    // backend are ready. Otherwise the onboarding gate can read the temporary
    // AsyncStorage fallback and incorrectly treat a returning user as new.
    initStorage()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setStorageReady(true);
      });

    if (Platform.OS !== "web") {
      ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => {});
      ImagePicker.requestCameraPermissionsAsync().catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, []);

  if (!storageReady) {
    return <AppOpeningSplashScreen />;
  }
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
        <WebScrollbarStyles />
            <ThemedStack />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
