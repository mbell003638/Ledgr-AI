import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { LogBox, View, Platform, useWindowDimensions, Text, ScrollView, Pressable } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { ThemeProvider, useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { initStorage } from "@/src/db/backend";

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

import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { Animated, StyleSheet } from "react-native";

function AppOpeningSplashScreen({ statusText, progress }: { statusText: string; progress: number }) {
  const pulseAnim = React.useRef(new Animated.Value(1)).current;
  const scaleAnim = React.useRef(new Animated.Value(0.9)).current;
  const opacityAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacityAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 40, useNativeDriver: true }),
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.12, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#0F172A", justifyContent: "center", alignItems: "center" }}>
      <LinearGradient colors={["#0F172A", "#1E293B", "#0B0F19"]} style={StyleSheet.absoluteFill} />
      
      <Animated.View
        style={{
          position: "absolute",
          width: 220,
          height: 220,
          borderRadius: 110,
          backgroundColor: "rgba(253, 186, 33, 0.12)",
          transform: [{ scale: pulseAnim }],
        }}
      />

      <Animated.View style={{ alignItems: "center", opacity: opacityAnim, transform: [{ scale: scaleAnim }] }}>
        <LinearGradient
          colors={["#FDBA21", "#F59E0B"]}
          style={{
            width: 84,
            height: 84,
            borderRadius: 24,
            justifyContent: "center",
            alignItems: "center",
            shadowColor: "#FDBA21",
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.4,
            shadowRadius: 16,
            elevation: 10,
            marginBottom: 20,
          }}
        >
          <Text style={{ fontSize: 44, fontWeight: "900", color: "#111827" }}>L</Text>
        </LinearGradient>

        <Text style={{ fontSize: 28, fontWeight: "900", color: "#FFFFFF", letterSpacing: 1.5 }}>
          LEDGR <Text style={{ color: "#FDBA21" }}>AI</Text>
        </Text>
        <Text style={{ fontSize: 12, fontWeight: "700", color: "#94A3B8", letterSpacing: 1, marginTop: 4, textTransform: "uppercase" }}>
          Smart Business Accounting
        </Text>

        <View style={{ width: 220, height: 5, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 3, marginTop: 36, overflow: "hidden" }}>
          <View style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%`, height: "100%", backgroundColor: "#FDBA21", borderRadius: 3 }} />
        </View>

        <Text style={{ fontSize: 12, fontWeight: "500", color: "#64748B", marginTop: 12 }}>
          {statusText}
        </Text>
      </Animated.View>
    </View>
  );
}

// ---------- Root Layout ----------
export default function RootLayout() {
  const [loaded, error] = useIconFontsSafe();
  const [statusText, setStatusText] = useState("Initializing storage...");
  const [progress, setProgress] = useState(0.2);
  const [readyToRender, setReadyToRender] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function initApp() {
      try {
        setStatusText("Initializing secure storage...");
        setProgress(0.3);
        await initStorage().catch(() => {});
        if (cancelled) return;

        setStatusText("Checking permissions...");
        setProgress(0.6);
        if (Platform.OS !== "web") {
          await Promise.all([
            ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => {}),
            ImagePicker.requestCameraPermissionsAsync().catch(() => {}),
          ]);
        }
        if (cancelled) return;

        setStatusText("Opening Ledgr Workspace...");
        setProgress(1.0);
        await SplashScreen.hideAsync().catch(() => {});

        setTimeout(() => {
          if (!cancelled) setReadyToRender(true);
        }, 300);
      } catch {
        if (!cancelled) setReadyToRender(true);
      }
    }

    initApp();

    const fallback = setTimeout(() => {
      if (!cancelled) setReadyToRender(true);
      SplashScreen.hideAsync().catch(() => {});
    }, 4500);

    return () => { cancelled = true; clearTimeout(fallback); };
  }, []);

  if (!readyToRender) {
    return <AppOpeningSplashScreen statusText={statusText} progress={progress} />;
  }

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
