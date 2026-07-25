import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { api } from "@/src/api";

export default function Index() {
  const [dest, setDest] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setDest(s.hasOnboarded ? "/(tabs)" : "/onboarding");
      } catch {
        setDest("/(tabs)");
      }
    })();
  }, []);

  if (!dest) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#1C4030" }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  return <Redirect href={dest as any} />;
}
