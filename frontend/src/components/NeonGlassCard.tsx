import React from "react";
import { View, StyleSheet, ViewStyle, StyleProp } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme } from "@/src/context/ThemeContext";

interface NeonGlassCardProps {
  children: React.ReactNode;
  brandColor?: string;
  brandGlow?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const NeonGlassCard: React.FC<NeonGlassCardProps> = ({
  children,
  brandColor,
  brandGlow,
  style,
  testID,
}) => {
  const theme = useTheme();
  const activeBrand = brandColor || theme.color.brandPrimary;
  const activeGlow = brandGlow || (theme.color as any).brandGlow || "rgba(253, 186, 33, 0.35)";

  return (
    <View style={[styles.cardContainer, { shadowColor: activeGlow, backgroundColor: theme.color.surfaceSecondary, borderColor: activeBrand + "25" }, style]} testID={testID}>
      <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
      
      {/* Top Neon Accent Line */}
      <LinearGradient
        colors={["transparent", activeBrand, "transparent"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.neonTopBorder}
      />
      
      <View style={styles.contentContainer}>{children}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  cardContainer: {
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.09)",
    marginBottom: 16,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 25,
    elevation: 10,
    position: "relative",
  },
  neonTopBorder: {
    height: 2,
    width: "100%",
    opacity: 1,
  },
  contentContainer: {
    padding: 18,
  },
});
