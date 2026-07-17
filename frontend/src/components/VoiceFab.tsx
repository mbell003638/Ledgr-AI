import React from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useTheme } from "@/src/context/ThemeContext";

export default function VoiceFab() {
  const router = useRouter();
  const theme = useTheme();
  return (
    <Pressable
      testID="voice-fab"
      onPress={() => router.push("/voice")}
      style={({ pressed }) => [
        styles.fab,
        { backgroundColor: theme.color.brandPrimary },
        pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
      ]}
    >
      <Ionicons name="mic" size={26} color={theme.color.onBrandPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 20,
    bottom: 100,
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
});
