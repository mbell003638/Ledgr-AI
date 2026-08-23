import React, { useEffect } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";

/**
 * Compatibility entry point for older customer links. Ledgr intentionally keeps
 * customers and suppliers in one Accounts screen, but deep links may still land
 * on /customers. Preserve a customer detail id when one is provided; otherwise
 * route to the combined Accounts list instead of exposing an unmatched page.
 */
export default function CustomersCompatibilityScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; customerId?: string }>();
  const customerId = String(params.customerId || params.id || "").trim();

  useEffect(() => {
    if (customerId) {
      router.replace({ pathname: "/customer/[id]", params: { id: customerId } } as any);
    } else {
      router.replace("/suppliers");
    }
  }, [customerId, router]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.color.surface }]}>
      <ActivityIndicator color={theme.color.brandPrimary} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
});
