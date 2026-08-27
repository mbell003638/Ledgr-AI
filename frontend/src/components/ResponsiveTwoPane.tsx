import React from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import type { FoldPostureSnapshot } from "@/src/hooks/foldPosture";

export function isSafeTwoPanePosture(snapshot: FoldPostureSnapshot): boolean {
  return snapshot.dualPane && snapshot.hasHinge && (snapshot.posture === "flat" || snapshot.posture === "book");
}

type ResponsiveTwoPaneProps = {
  snapshot: FoldPostureSnapshot;
  primary: React.ReactNode;
  secondary: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A reversible layout-only split for the first safe candidates (Accounts and
 * Reports). It deliberately refuses to split when the OS does not provide an
 * explicit hinge/posture snapshot. Data loading, selected book/location,
 * routing, and writes remain owned by the screen that supplies the children.
 */
export function ResponsiveTwoPane({ snapshot, primary, secondary, style, testID }: ResponsiveTwoPaneProps) {
  if (!isSafeTwoPanePosture(snapshot)) return <>{primary}</>;

  return (
    <View testID={testID} style={[{ flex: 1, flexDirection: "row", gap: 12 }, style]}>
      <View style={{ flex: 1, minWidth: 0 }}>{primary}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{secondary}</View>
    </View>
  );
}
