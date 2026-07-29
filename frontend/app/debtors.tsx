import React, { useEffect } from "react";
import { View, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";

export default function DebtorsRedirectScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ customerId?: string; id?: string }>();
  const id = params.customerId || params.id;

  useEffect(() => {
    if (id) {
      router.replace(`/customer/${id}` as any);
    } else {
      router.replace("/suppliers" as any);
    }
  }, [id]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.surface, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size="large" color={theme.color.brandPrimary} />
    </View>
  );
}
